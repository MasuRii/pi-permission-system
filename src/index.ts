import { getAgentDir, isToolCallEventType, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve, sep } from "node:path";

import { toRecord } from "./common.js";
import {
  createActiveToolsCacheKey,
  createBeforeAgentStartPromptStateKey,
  shouldApplyCachedAgentStartState,
} from "./before-agent-start-cache.js";
import {
  isPermissionDecisionState,
  requestPermissionDecisionFromUi,
  type PermissionPromptDecision,
} from "./permission-dialog.js";
import {
  DEFAULT_EXTENSION_CONFIG,
  getPermissionSystemConfigPath,
  loadPermissionSystemConfig,
  normalizePermissionSystemConfig,
  savePermissionSystemConfig,
  type PermissionSystemExtensionConfig,
} from "./extension-config.js";
import { createPermissionSystemLogger } from "./logging.js";
import { registerPermissionSystemCommand } from "./config-modal.js";
import {
  createPermissionForwardingLocation,
  isForwardedPermissionRequestForSession,
  PERMISSION_FORWARDING_POLL_INTERVAL_MS,
  PERMISSION_FORWARDING_TIMEOUT_MS,
  resolvePermissionForwardingTargetSessionId,
  SUBAGENT_ENV_HINT_KEYS,
  type ForwardedPermissionRequest,
  type ForwardedPermissionResponse,
  type PermissionForwardingLocation,
} from "./permission-forwarding.js";
import { PermissionManager } from "./permission-manager.js";
import { sanitizeAvailableToolsSection } from "./system-prompt-sanitizer.js";
import { checkRequestedToolRegistration, getToolNameFromValue } from "./tool-registry.js";
import type { PermissionCheckResult, PermissionState } from "./types.js";
import { PERMISSION_SYSTEM_STATUS_KEY, syncPermissionSystemStatus } from "./status.js";
import { canResolveAskPermissionRequest, shouldAutoApprovePermissionState } from "./yolo-mode.js";

const PI_AGENT_DIR = getAgentDir();
const SESSIONS_DIR = join(PI_AGENT_DIR, "sessions");
const SUBAGENT_SESSIONS_DIR = join(PI_AGENT_DIR, "subagent-sessions");
const PERMISSION_FORWARDING_DIR = join(SESSIONS_DIR, "permission-forwarding");

const AVAILABLE_SKILLS_OPEN_TAG = "<available_skills>";
const AVAILABLE_SKILLS_CLOSE_TAG = "</available_skills>";
const SKILL_BLOCK_PATTERN = "<skill>([\\s\\S]*?)<\\/skill>";
const SKILL_NAME_REGEX = /<name>([\s\S]*?)<\/name>/;
const SKILL_DESCRIPTION_REGEX = /<description>([\s\S]*?)<\/description>/;
const SKILL_LOCATION_REGEX = /<location>([\s\S]*?)<\/location>/;
const ACTIVE_AGENT_TAG_REGEX = /<active_agent\s+name=["']([^"']+)["'][^>]*>/i;

type SkillPromptEntry = {
  name: string;
  description: string;
  location: string;
  state: PermissionState;
  normalizedLocation: string;
  normalizedBaseDir: string;
};

type SkillPromptSection = {
  start: number;
  end: number;
  entries: Array<{ name: string; description: string; location: string }>;
};

type PermissionRequestSource = "tool_call" | "skill_input" | "skill_read";
type PermissionRequestState = "waiting" | "approved" | "denied";

type PermissionRequestEvent = {
  requestId: string;
  source: PermissionRequestSource;
  state: PermissionRequestState;
  message: string;
  toolCallId?: string;
  toolName?: string;
  skillName?: string;
  path?: string;
  command?: string;
  target?: string;
  agentName?: string | null;
};

const PERMISSION_REQUEST_EVENT_CHANNEL = "pi-permission-system:permission-request";

let extensionConfig: PermissionSystemExtensionConfig = { ...DEFAULT_EXTENSION_CONFIG };
const extensionLogger = createPermissionSystemLogger({
  getConfig: () => extensionConfig,
});
const reportedLoggingWarnings = new Set<string>();
let loggingWarningReporter: ((message: string) => void) | null = null;

function setExtensionConfig(config: PermissionSystemExtensionConfig): void {
  extensionConfig = normalizePermissionSystemConfig(config);
}

function setLoggingWarningReporter(reporter: ((message: string) => void) | null): void {
  loggingWarningReporter = reporter;
}

function reportLoggingWarning(message: string): void {
  if (!loggingWarningReporter || reportedLoggingWarnings.has(message)) {
    return;
  }

  reportedLoggingWarnings.add(message);
  loggingWarningReporter(message);
}

function writeDebugLog(event: string, details: Record<string, unknown> = {}): void {
  const warning = extensionLogger.debug(event, details);
  if (warning) {
    reportLoggingWarning(warning);
  }
}

function writeReviewLog(event: string, details: Record<string, unknown> = {}): void {
  const warning = extensionLogger.review(event, details);
  if (warning) {
    reportLoggingWarning(warning);
  }
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function encodeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizePathForComparison(pathValue: string, cwd: string): string {
  const trimmed = pathValue.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) {
    return "";
  }

  let normalizedPath = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;

  if (normalizedPath === "~") {
    normalizedPath = homedir();
  } else if (normalizedPath.startsWith("~/") || normalizedPath.startsWith("~\\")) {
    normalizedPath = join(homedir(), normalizedPath.slice(2));
  }

  const absolutePath = resolve(cwd, normalizedPath);
  const normalizedAbsolutePath = normalize(absolutePath);
  return process.platform === "win32" ? normalizedAbsolutePath.toLowerCase() : normalizedAbsolutePath;
}

function isPathWithinDirectory(pathValue: string, directory: string): boolean {
  if (!pathValue || !directory) {
    return false;
  }

  if (pathValue === directory) {
    return true;
  }

  const prefix = directory.endsWith(sep) ? directory : `${directory}${sep}`;
  return pathValue.startsWith(prefix);
}

function parseSkillPromptSection(prompt: string): SkillPromptSection | null {
  const start = prompt.indexOf(AVAILABLE_SKILLS_OPEN_TAG);
  if (start === -1) {
    return null;
  }

  const closeStart = prompt.indexOf(AVAILABLE_SKILLS_CLOSE_TAG, start + AVAILABLE_SKILLS_OPEN_TAG.length);
  if (closeStart === -1) {
    return null;
  }

  const end = closeStart + AVAILABLE_SKILLS_CLOSE_TAG.length;
  const sectionBody = prompt.slice(start + AVAILABLE_SKILLS_OPEN_TAG.length, closeStart);
  const entries: Array<{ name: string; description: string; location: string }> = [];

  const skillBlockRegex = new RegExp(SKILL_BLOCK_PATTERN, "g");
  for (const match of sectionBody.matchAll(skillBlockRegex)) {
    const block = match[1];
    const nameMatch = block.match(SKILL_NAME_REGEX);
    const descriptionMatch = block.match(SKILL_DESCRIPTION_REGEX);
    const locationMatch = block.match(SKILL_LOCATION_REGEX);

    if (!nameMatch || !descriptionMatch || !locationMatch) {
      continue;
    }

    const name = decodeXml(nameMatch[1].trim());
    const description = decodeXml(descriptionMatch[1].trim());
    const location = decodeXml(locationMatch[1].trim());

    if (!name || !location) {
      continue;
    }

    entries.push({ name, description, location });
  }

  return {
    start,
    end,
    entries,
  };
}

function resolveSkillPromptEntries(
  prompt: string,
  permissionManager: PermissionManager,
  agentName: string | null,
  cwd: string,
): { prompt: string; entries: SkillPromptEntry[] } {
  const section = parseSkillPromptSection(prompt);
  if (!section) {
    return { prompt, entries: [] };
  }

  const resolvedEntries: SkillPromptEntry[] = section.entries.map((entry) => {
    const check = permissionManager.checkPermission("skill", { name: entry.name }, agentName ?? undefined);
    const state: PermissionState = check.state;
    return {
      name: entry.name,
      description: entry.description,
      location: entry.location,
      state,
      normalizedLocation: normalizePathForComparison(entry.location, cwd),
      normalizedBaseDir: normalizePathForComparison(dirname(entry.location), cwd),
    };
  });

  const visibleEntries = resolvedEntries.filter((entry) => entry.state !== "deny");
  if (visibleEntries.length === resolvedEntries.length) {
    return { prompt, entries: resolvedEntries };
  }

  const replacement = [
    AVAILABLE_SKILLS_OPEN_TAG,
    ...visibleEntries.flatMap((entry) => [
      "  <skill>",
      `    <name>${encodeXml(entry.name)}</name>`,
      `    <description>${encodeXml(entry.description)}</description>`,
      `    <location>${encodeXml(entry.location)}</location>`,
      "  </skill>",
    ]),
    AVAILABLE_SKILLS_CLOSE_TAG,
  ].join("\n");

  return {
    prompt: `${prompt.slice(0, section.start)}${replacement}${prompt.slice(section.end)}`,
    entries: resolvedEntries,
  };
}

function findSkillPathMatch(normalizedPath: string, entries: readonly SkillPromptEntry[]): SkillPromptEntry | null {
  if (!normalizedPath || entries.length === 0) {
    return null;
  }

  for (const entry of entries) {
    if (entry.normalizedLocation && normalizedPath === entry.normalizedLocation) {
      return entry;
    }
  }

  let bestMatch: SkillPromptEntry | null = null;
  for (const entry of entries) {
    if (!entry.normalizedBaseDir || !isPathWithinDirectory(normalizedPath, entry.normalizedBaseDir)) {
      continue;
    }

    if (!bestMatch || entry.normalizedBaseDir.length > bestMatch.normalizedBaseDir.length) {
      bestMatch = entry;
    }
  }

  return bestMatch;
}

function extractSkillNameFromInput(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/skill:")) {
    return null;
  }

  const afterPrefix = trimmed.slice("/skill:".length);
  if (!afterPrefix) {
    return null;
  }

  const firstWhitespace = afterPrefix.search(/\s/);
  const skillName = (firstWhitespace === -1 ? afterPrefix : afterPrefix.slice(0, firstWhitespace)).trim();
  return skillName || null;
}

function getEventToolName(event: unknown): string | null {
  return getToolNameFromValue(event);
}

function getEventInput(event: unknown): unknown {
  const record = toRecord(event);

  if (record.input !== undefined) {
    return record.input;
  }

  if (record.arguments !== undefined) {
    return record.arguments;
  }

  return {};
}

function normalizeAgentName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function getActiveAgentName(ctx: ExtensionContext): string | null {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type: string; customType?: string; data?: unknown };
    if (entry.type !== "custom" || entry.customType !== "active_agent") {
      continue;
    }

    const data = entry.data as { name?: unknown } | undefined;
    const normalizedName = normalizeAgentName(data?.name);
    if (normalizedName) {
      return normalizedName;
    }

    if (data?.name === null) {
      return null;
    }
  }

  return null;
}

function getActiveAgentNameFromSystemPrompt(systemPrompt: string | undefined): string | null {
  if (!systemPrompt) {
    return null;
  }

  const match = systemPrompt.match(ACTIVE_AGENT_TAG_REGEX);
  if (!match || !match[1]) {
    return null;
  }

  return normalizeAgentName(match[1]);
}

function formatMissingToolNameReason(): string {
  return "Tool call was blocked because no tool name was provided. Use a registered tool name from pi.getAllTools().";
}

function formatUnknownToolReason(toolName: string, availableToolNames: readonly string[]): string {
  const preview = availableToolNames.slice(0, 10);
  const suffix = availableToolNames.length > preview.length ? ", ..." : "";
  const availableList = preview.length > 0 ? `${preview.join(", ")}${suffix}` : "none";

  const mcpHint = toolName === "mcp"
    ? ""
    : " If this was intended as an MCP server tool, call the registered 'mcp' tool when available (for example: {\"tool\":\"server:tool\"}).";

  return `Tool '${toolName}' is not registered in this runtime and was blocked before permission checks.${mcpHint} Registered tools: ${availableList}.`;
}

function formatPermissionHardStopHint(result: PermissionCheckResult): string {
  if ((result.source === "mcp" || result.toolName === "mcp") && result.target) {
    return "Hard stop: this MCP permission denial is policy-enforced. Do not retry this target, do not run discovery/investigation to bypass it, and report the block to the user.";
  }

  return "Hard stop: this permission denial is policy-enforced. Do not retry or investigate bypasses; report the block to the user.";
}

function formatDenyReason(result: PermissionCheckResult, agentName?: string): string {
  const parts: string[] = [];

  if (agentName) {
    parts.push(`Agent '${agentName}'`);
  }

  if ((result.source === "mcp" || result.toolName === "mcp") && result.target) {
    parts.push(`is not permitted to run MCP target '${result.target}'`);
  } else {
    parts.push(`is not permitted to run '${result.toolName}'`);
  }

  if (result.command) {
    parts.push(`command '${result.command}'`);
  }

  if (result.matchedPattern) {
    parts.push(`(matched '${result.matchedPattern}')`);
  }

  return `${parts.join(" ")}. ${formatPermissionHardStopHint(result)}`;
}

function formatUserDeniedReason(result: PermissionCheckResult, denialReason?: string): string {
  const base = (result.source === "mcp" || result.toolName === "mcp") && result.target
    ? `User denied MCP target '${result.target}'.`
    : result.toolName === "bash" && result.command
      ? `User denied bash command '${result.command}'.`
      : `User denied tool '${result.toolName}'.`;
  const reasonSuffix = denialReason ? ` Reason: ${denialReason}.` : "";

  return `${base}${reasonSuffix} ${formatPermissionHardStopHint(result)}`;
}

function formatAskPrompt(result: PermissionCheckResult, agentName?: string): string {
  const subject = agentName ? `Agent '${agentName}'` : "Current agent";

  if (result.toolName === "bash") {
    const patternInfo = result.matchedPattern ? ` (matched '${result.matchedPattern}')` : "";
    return `${subject} requested bash command '${result.command || ""}'${patternInfo}. Allow this command?`;
  }

  if ((result.source === "mcp" || result.toolName === "mcp") && result.target) {
    const patternInfo = result.matchedPattern ? ` (matched '${result.matchedPattern}')` : "";
    return `${subject} requested MCP target '${result.target}'${patternInfo}. Allow this call?`;
  }

  const patternInfo = result.matchedPattern ? ` (matched '${result.matchedPattern}')` : "";
  return `${subject} requested tool '${result.toolName}'${patternInfo}. Allow this call?`;
}

function formatSkillAskPrompt(skillName: string, agentName?: string): string {
  const subject = agentName ? `Agent '${agentName}'` : "Current agent";
  return `${subject} requested skill '${skillName}'. Allow loading this skill?`;
}

function formatSkillPathAskPrompt(skill: SkillPromptEntry, readPath: string, agentName?: string): string {
  const subject = agentName ? `Agent '${agentName}'` : "Current agent";
  return `${subject} requested access to skill '${skill.name}' via '${readPath}'. Allow this read?`;
}

function formatSkillPathDenyReason(skill: SkillPromptEntry, readPath: string, agentName?: string): string {
  const subject = agentName ? `Agent '${agentName}'` : "Current agent";
  return `${subject} is not permitted to access skill '${skill.name}' via '${readPath}'.`;
}

function getPermissionLogContext(result: PermissionCheckResult): { command?: string; target?: string } {
  return {
    command: result.command,
    target: result.target,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeFilesystemPath(pathValue: string): string {
  const normalizedPath = normalize(pathValue);
  return process.platform === "win32" ? normalizedPath.toLowerCase() : normalizedPath;
}

function getSessionId(ctx: ExtensionContext): string {
  try {
    const sessionId = ctx.sessionManager.getSessionId();
    if (typeof sessionId === "string" && sessionId.trim()) {
      return sessionId.trim();
    }
  } catch {
  }

  return "unknown";
}

function isSubagentExecutionContext(ctx: ExtensionContext): boolean {
  for (const key of SUBAGENT_ENV_HINT_KEYS) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim()) {
      return true;
    }
  }

  const sessionDir = ctx.sessionManager.getSessionDir();
  if (!sessionDir) {
    return false;
  }

  const normalizedSessionDir = normalizeFilesystemPath(sessionDir);
  const normalizedSubagentRoot = normalizeFilesystemPath(SUBAGENT_SESSIONS_DIR);
  return isPathWithinDirectory(normalizedSessionDir, normalizedSubagentRoot);
}

function canRequestPermissionConfirmation(ctx: ExtensionContext): boolean {
  return canResolveAskPermissionRequest({
    config: extensionConfig,
    hasUI: ctx.hasUI,
    isSubagent: isSubagentExecutionContext(ctx),
  });
}

function formatUnknownErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === code);
}

function logPermissionForwardingWarning(message: string, error?: unknown): void {
  const details = typeof error === "undefined"
    ? { message }
    : { message, error: formatUnknownErrorMessage(error) };

  writeReviewLog("permission_forwarding.warning", details);
  writeDebugLog("permission_forwarding.warning", details);
}

function logPermissionForwardingError(message: string, error?: unknown): void {
  const details = typeof error === "undefined"
    ? { message }
    : { message, error: formatUnknownErrorMessage(error) };

  writeReviewLog("permission_forwarding.error", details);
  writeDebugLog("permission_forwarding.error", details);
}

function ensureDirectoryExists(path: string, description: string): boolean {
  try {
    mkdirSync(path, { recursive: true });
    return true;
  } catch (error) {
    logPermissionForwardingError(`Failed to create ${description} directory '${path}'`, error);
    return false;
  }
}

function getPermissionForwardingLocationForSession(sessionId: string): PermissionForwardingLocation {
  return createPermissionForwardingLocation(PERMISSION_FORWARDING_DIR, sessionId);
}

function ensurePermissionForwardingLocation(sessionId: string): PermissionForwardingLocation | null {
  let location: PermissionForwardingLocation;
  try {
    location = getPermissionForwardingLocationForSession(sessionId);
  } catch (error) {
    logPermissionForwardingError("Failed to resolve permission forwarding location", error);
    return null;
  }

  const sessionRootReady = ensureDirectoryExists(location.sessionRootDir, "permission forwarding session root");
  const requestsReady = ensureDirectoryExists(location.requestsDir, "permission forwarding requests");
  const responsesReady = ensureDirectoryExists(location.responsesDir, "permission forwarding responses");

  return sessionRootReady && requestsReady && responsesReady ? location : null;
}

function getExistingPermissionForwardingLocation(sessionId: string): PermissionForwardingLocation | null {
  let location: PermissionForwardingLocation;
  try {
    location = getPermissionForwardingLocationForSession(sessionId);
  } catch {
    return null;
  }

  return existsSync(location.requestsDir) ? location : null;
}

function tryRemoveDirectoryIfEmpty(path: string, description: string): void {
  if (!existsSync(path)) {
    return;
  }

  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch (error) {
    logPermissionForwardingWarning(`Failed to inspect ${description} directory '${path}'`, error);
    return;
  }

  if (entries.length > 0) {
    return;
  }

  try {
    rmdirSync(path);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ENOTEMPTY")) {
      return;
    }

    logPermissionForwardingWarning(`Failed to remove empty ${description} directory '${path}'`, error);
  }
}

function cleanupPermissionForwardingLocationIfEmpty(location: PermissionForwardingLocation): void {
  tryRemoveDirectoryIfEmpty(location.requestsDir, `${location.label} permission forwarding requests`);
  tryRemoveDirectoryIfEmpty(location.responsesDir, `${location.label} permission forwarding responses`);
  tryRemoveDirectoryIfEmpty(location.sessionRootDir, `${location.label} permission forwarding session root`);
}

function safeDeleteFile(filePath: string, description: string): void {
  try {
    unlinkSync(filePath);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return;
    }

    logPermissionForwardingWarning(`Failed to delete ${description} file '${filePath}'`, error);
  }
}

function writeJsonFileAtomic(filePath: string, value: unknown): void {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

  try {
    writeFileSync(tempPath, JSON.stringify(value), "utf-8");
    renameSync(tempPath, filePath);
  } catch (error) {
    safeDeleteFile(tempPath, "temporary permission-forwarding");
    throw error;
  }
}

function readForwardedPermissionRequest(filePath: string): ForwardedPermissionRequest | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ForwardedPermissionRequest>;
    if (
      !parsed
      || typeof parsed.id !== "string"
      || typeof parsed.createdAt !== "number"
      || typeof parsed.requesterSessionId !== "string"
      || typeof parsed.targetSessionId !== "string"
      || typeof parsed.requesterAgentName !== "string"
      || typeof parsed.message !== "string"
    ) {
      logPermissionForwardingWarning(`Ignoring invalid forwarded permission request format in '${filePath}'`);
      return null;
    }

    return {
      id: parsed.id,
      createdAt: parsed.createdAt,
      requesterSessionId: parsed.requesterSessionId,
      targetSessionId: parsed.targetSessionId,
      requesterAgentName: parsed.requesterAgentName,
      message: parsed.message,
    };
  } catch (error) {
    logPermissionForwardingWarning(`Failed to read forwarded permission request '${filePath}'`, error);
    return null;
  }
}

function readForwardedPermissionResponse(filePath: string): ForwardedPermissionResponse | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ForwardedPermissionResponse>;
    if (
      !parsed
      || typeof parsed.approved !== "boolean"
      || !isPermissionDecisionState(parsed.state)
      || typeof parsed.responderSessionId !== "string"
    ) {
      logPermissionForwardingWarning(`Ignoring invalid forwarded permission response format in '${filePath}'`);
      return null;
    }

    return {
      approved: parsed.approved,
      state: parsed.state,
      denialReason: typeof parsed.denialReason === "string" ? parsed.denialReason : undefined,
      responderSessionId: parsed.responderSessionId,
      respondedAt: typeof parsed.respondedAt === "number" ? parsed.respondedAt : Date.now(),
    };
  } catch (error) {
    logPermissionForwardingWarning(`Failed to read forwarded permission response '${filePath}'`, error);
    return null;
  }
}

function formatForwardedPermissionPrompt(request: ForwardedPermissionRequest): string {
  const agentName = request.requesterAgentName || "unknown";
  const sessionId = request.requesterSessionId || "unknown";
  return [
    `Subagent '${agentName}' requested permission.`,
    `Session ID: ${sessionId}`,
    "",
    request.message,
  ].join("\n");
}

async function waitForForwardedPermissionApproval(
  ctx: ExtensionContext,
  message: string,
): Promise<PermissionPromptDecision> {
  const requesterSessionId = getSessionId(ctx);
  const targetSessionId = resolvePermissionForwardingTargetSessionId({
    hasUI: ctx.hasUI,
    isSubagent: isSubagentExecutionContext(ctx),
    currentSessionId: requesterSessionId,
    env: process.env,
  });

  if (!targetSessionId) {
    logPermissionForwardingError(
      "Permission forwarding target session could not be resolved from subagent runtime metadata (expected PI_AGENT_ROUTER_PARENT_SESSION_ID)",
    );
    return { approved: false, state: "denied" };
  }

  const location = ensurePermissionForwardingLocation(targetSessionId);
  if (!location) {
    logPermissionForwardingError(
      `Permission forwarding is unavailable because session-scoped directories could not be prepared for '${targetSessionId}'`,
    );
    return { approved: false, state: "denied" };
  }

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${process.pid}`;
  const requesterAgentName = getActiveAgentName(ctx) || getActiveAgentNameFromSystemPrompt(ctx.getSystemPrompt()) || "unknown";
  const request: ForwardedPermissionRequest = {
    id: requestId,
    createdAt: Date.now(),
    requesterSessionId,
    targetSessionId,
    requesterAgentName,
    message,
  };

  const requestPath = join(location.requestsDir, `${requestId}.json`);
  const responsePath = join(location.responsesDir, `${requestId}.json`);

  writeReviewLog("forwarded_permission.request_created", {
    requestId,
    requesterAgentName,
    requesterSessionId: request.requesterSessionId,
    targetSessionId,
    requestPath,
    responsePath,
  });

  try {
    writeJsonFileAtomic(requestPath, request);
  } catch (error) {
    logPermissionForwardingError(`Failed to write forwarded permission request '${requestPath}'`, error);
    return { approved: false, state: "denied" };
  }

  const deadline = Date.now() + PERMISSION_FORWARDING_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(responsePath)) {
      const response = readForwardedPermissionResponse(responsePath);
      writeReviewLog("forwarded_permission.response_received", {
        requestId,
        approved: response?.approved ?? null,
        state: response?.state ?? null,
        denialReason: response?.denialReason ?? null,
        responderSessionId: response?.responderSessionId ?? null,
        targetSessionId,
        responsePath,
      });
      safeDeleteFile(responsePath, "forwarded permission response");
      safeDeleteFile(requestPath, "forwarded permission request");
      cleanupPermissionForwardingLocationIfEmpty(location);
      return response ?? { approved: false, state: "denied" };
    }

    await sleep(PERMISSION_FORWARDING_POLL_INTERVAL_MS);
  }

  logPermissionForwardingWarning(`Timed out waiting for forwarded permission response '${responsePath}'`);
  writeReviewLog("forwarded_permission.response_timed_out", {
    requestId,
    requesterAgentName,
    targetSessionId,
    responsePath,
  });
  safeDeleteFile(requestPath, "forwarded permission request");
  cleanupPermissionForwardingLocationIfEmpty(location);
  return { approved: false, state: "denied" };
}

async function processForwardedPermissionRequests(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) {
    return;
  }

  const currentSessionId = getSessionId(ctx);
  const location = getExistingPermissionForwardingLocation(currentSessionId);
  if (!location) {
    return;
  }

  let requestFiles: string[] = [];
  try {
    requestFiles = readdirSync(location.requestsDir)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch (error) {
    logPermissionForwardingWarning(`Failed to read ${location.label} permission forwarding requests from '${location.requestsDir}'`, error);
    return;
  }

  for (const fileName of requestFiles) {
    const requestPath = join(location.requestsDir, fileName);
    const request = readForwardedPermissionRequest(requestPath);
    if (!request) {
      safeDeleteFile(requestPath, `${location.label} forwarded permission request`);
      continue;
    }

    if (!isForwardedPermissionRequestForSession(request, currentSessionId)) {
      logPermissionForwardingWarning(
        `Ignoring forwarded permission request '${request.id}' because it targets session '${request.targetSessionId}' instead of '${currentSessionId}'`,
      );
      safeDeleteFile(requestPath, `${location.label} forwarded permission request`);
      continue;
    }

    const forwardedPermissionLogDetails = {
      requestId: request.id,
      source: location.label,
      requesterAgentName: request.requesterAgentName,
      requesterSessionId: request.requesterSessionId,
      targetSessionId: request.targetSessionId,
      requestPath,
    };

    let decision: PermissionPromptDecision = { approved: false, state: "denied" };
    if (shouldAutoApprovePermissionState("ask", extensionConfig)) {
      writeReviewLog("forwarded_permission.auto_approved", forwardedPermissionLogDetails);
      decision = { approved: true, state: "approved" };
    } else {
      writeReviewLog("forwarded_permission.prompted", forwardedPermissionLogDetails);
      try {
        decision = await requestPermissionDecisionFromUi(
          ctx.ui,
          "Permission Required (Subagent)",
          formatForwardedPermissionPrompt(request),
        );
      } catch (error) {
        logPermissionForwardingError("Failed to show forwarded permission confirmation dialog", error);
        decision = { approved: false, state: "denied" };
      }
    }

    const responsePath = join(location.responsesDir, `${request.id}.json`);
    writeReviewLog(decision.approved ? "forwarded_permission.approved" : "forwarded_permission.denied", {
      requestId: request.id,
      source: location.label,
      requesterAgentName: request.requesterAgentName,
      requesterSessionId: request.requesterSessionId,
      targetSessionId: request.targetSessionId,
      responsePath,
      resolution: decision.state,
      denialReason: decision.denialReason ?? null,
    });
    try {
      writeJsonFileAtomic(responsePath, {
        approved: decision.approved,
        state: decision.state,
        denialReason: decision.denialReason,
        responderSessionId: currentSessionId,
        respondedAt: Date.now(),
      } satisfies ForwardedPermissionResponse);
    } catch (error) {
      logPermissionForwardingError(`Failed to write ${location.label} forwarded permission response '${responsePath}'`, error);
      continue;
    }

    safeDeleteFile(requestPath, `${location.label} forwarded permission request`);
  }

  cleanupPermissionForwardingLocationIfEmpty(location);
}

async function confirmPermission(
  ctx: ExtensionContext,
  message: string,
): Promise<PermissionPromptDecision> {
  if (ctx.hasUI) {
    return requestPermissionDecisionFromUi(ctx.ui, "Permission Required", message);
  }

  if (!isSubagentExecutionContext(ctx)) {
    return { approved: false, state: "denied" };
  }

  return waitForForwardedPermissionApproval(ctx, message);
}

function derivePiProjectPaths(cwd: string | undefined | null): {
  projectGlobalConfigPath: string;
  projectAgentsDir: string;
} | null {
  if (!cwd) {
    return null;
  }

  const projectAgentRoot = join(cwd, ".pi", "agent");
  return {
    projectGlobalConfigPath: join(projectAgentRoot, "pi-permissions.jsonc"),
    projectAgentsDir: join(projectAgentRoot, "agents"),
  };
}

function createPermissionManagerForCwd(cwd: string | undefined | null): PermissionManager {
  const projectPaths = derivePiProjectPaths(cwd);
  if (!projectPaths) {
    return new PermissionManager();
  }

  return new PermissionManager({
    projectGlobalConfigPath: projectPaths.projectGlobalConfigPath,
    projectAgentsDir: projectPaths.projectAgentsDir,
  });
}

export default function piPermissionSystemExtension(pi: ExtensionAPI): void {
  let permissionManager = new PermissionManager();
  let activeSkillEntries: SkillPromptEntry[] = [];
  let lastKnownActiveAgentName: string | null = null;
  let lastActiveToolsCacheKey: string | null = null;
  let lastPromptStateCacheKey: string | null = null;
  let permissionForwardingContext: ExtensionContext | null = null;
  let permissionForwardingTimer: NodeJS.Timeout | null = null;
  let isProcessingForwardedRequests = false;
  let runtimeContext: ExtensionContext | null = null;
  let lastConfigWarning: string | null = null;

  const invalidateAgentStartCache = (): void => {
    activeSkillEntries = [];
    lastActiveToolsCacheKey = null;
    lastPromptStateCacheKey = null;
  };

  const notifyWarning = (message: string): void => {
    if (!runtimeContext?.hasUI) {
      return;
    }

    runtimeContext.ui.notify(message, "warning");
  };

  const refreshExtensionConfig = (ctx?: ExtensionContext): void => {
    if (ctx) {
      runtimeContext = ctx;
    }

    const result = loadPermissionSystemConfig();
    setExtensionConfig(result.config);

    if (runtimeContext?.hasUI) {
      syncPermissionSystemStatus(runtimeContext, result.config);
    }

    if (result.warning && result.warning !== lastConfigWarning) {
      lastConfigWarning = result.warning;
      notifyWarning(result.warning);
    } else if (!result.warning) {
      lastConfigWarning = null;
    }

    writeDebugLog("config.loaded", {
      created: result.created,
      warning: result.warning ?? null,
      debugLog: result.config.debugLog,
      permissionReviewLog: result.config.permissionReviewLog,
      yoloMode: result.config.yoloMode,
    });
  };

  const saveExtensionConfig = (next: PermissionSystemExtensionConfig, ctx: ExtensionCommandContext): void => {
    const normalized = normalizePermissionSystemConfig(next);
    const saved = savePermissionSystemConfig(normalized);
    if (!saved.success) {
      if (saved.error) {
        ctx.ui.notify(saved.error, "error");
      }
      return;
    }

    setExtensionConfig(normalized);
    syncPermissionSystemStatus(ctx, normalized);
    lastConfigWarning = null;

    writeDebugLog("config.saved", {
      debugLog: normalized.debugLog,
      permissionReviewLog: normalized.permissionReviewLog,
      yoloMode: normalized.yoloMode,
    });
  };

  setLoggingWarningReporter(notifyWarning);
  refreshExtensionConfig();

  registerPermissionSystemCommand(pi, {
    getConfig: () => extensionConfig,
    setConfig: saveExtensionConfig,
    getConfigPath: getPermissionSystemConfigPath,
  });

  const createPermissionRequestId = (prefix: string): string => {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${process.pid}`;
  };

  const emitPermissionRequestEvent = (event: PermissionRequestEvent): void => {
    try {
      pi.events.emit(PERMISSION_REQUEST_EVENT_CHANNEL, event);
    } catch (error) {
      writeDebugLog("permission_request.event_emit_failed", {
        requestId: event.requestId,
        source: event.source,
        state: event.state,
        error: formatUnknownErrorMessage(error),
      });
    }
  };

  const reviewPermissionDecision = (
    event: string,
    details: {
      requestId: string;
      source: PermissionRequestSource;
      agentName: string | null;
      message: string;
      toolCallId?: string;
      toolName?: string;
      skillName?: string;
      path?: string;
      command?: string;
      target?: string;
      resolution?: string;
      denialReason?: string;
    },
  ): void => {
    writeReviewLog(event, {
      requestId: details.requestId,
      source: details.source,
      agentName: details.agentName,
      message: details.message,
      toolCallId: details.toolCallId ?? null,
      toolName: details.toolName ?? null,
      skillName: details.skillName ?? null,
      path: details.path ?? null,
      command: details.command ?? null,
      target: details.target ?? null,
      resolution: details.resolution ?? null,
      denialReason: details.denialReason ?? null,
    });
  };

  const promptPermission = async (
    ctx: ExtensionContext,
    details: {
      requestId: string;
      source: PermissionRequestSource;
      agentName: string | null;
      message: string;
      toolCallId?: string;
      toolName?: string;
      skillName?: string;
      path?: string;
      command?: string;
      target?: string;
    },
  ): Promise<PermissionPromptDecision> => {
    if (shouldAutoApprovePermissionState("ask", extensionConfig)) {
      reviewPermissionDecision("permission_request.auto_approved", details);
      emitPermissionRequestEvent({
        requestId: details.requestId,
        source: details.source,
        state: "approved",
        message: details.message,
        toolCallId: details.toolCallId,
        toolName: details.toolName,
        skillName: details.skillName,
        path: details.path,
        command: details.command,
        target: details.target,
        agentName: details.agentName,
      });
      return { approved: true, state: "approved" };
    }

    reviewPermissionDecision("permission_request.waiting", details);
    emitPermissionRequestEvent({
      requestId: details.requestId,
      source: details.source,
      state: "waiting",
      message: details.message,
      toolCallId: details.toolCallId,
      toolName: details.toolName,
      skillName: details.skillName,
      path: details.path,
      command: details.command,
      target: details.target,
      agentName: details.agentName,
    });

    const decision = await confirmPermission(ctx, details.message);
    reviewPermissionDecision(decision.approved ? "permission_request.approved" : "permission_request.denied", {
      ...details,
      resolution: decision.state,
      denialReason: decision.denialReason,
    });
    emitPermissionRequestEvent({
      requestId: details.requestId,
      source: details.source,
      state: decision.approved ? "approved" : "denied",
      message: details.message,
      toolCallId: details.toolCallId,
      toolName: details.toolName,
      skillName: details.skillName,
      path: details.path,
      command: details.command,
      target: details.target,
      agentName: details.agentName,
    });

    return decision;
  };

  const stopForwardedPermissionPolling = (): void => {
    if (permissionForwardingTimer) {
      clearInterval(permissionForwardingTimer);
      permissionForwardingTimer = null;
    }

    permissionForwardingContext = null;
    isProcessingForwardedRequests = false;
  };

  const startForwardedPermissionPolling = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI || isSubagentExecutionContext(ctx)) {
      stopForwardedPermissionPolling();
      return;
    }

    permissionForwardingContext = ctx;
    if (permissionForwardingTimer) {
      return;
    }

    permissionForwardingTimer = setInterval(() => {
      if (!permissionForwardingContext || isProcessingForwardedRequests) {
        return;
      }

      isProcessingForwardedRequests = true;
      void processForwardedPermissionRequests(permissionForwardingContext)
        .finally(() => {
          isProcessingForwardedRequests = false;
        });
    }, PERMISSION_FORWARDING_POLL_INTERVAL_MS);
  };

  const resolveAgentName = (ctx: ExtensionContext, systemPrompt?: string): string | null => {
    const fromSession = getActiveAgentName(ctx);
    if (fromSession) {
      lastKnownActiveAgentName = fromSession;
      return fromSession;
    }

    const fromSystemPrompt = getActiveAgentNameFromSystemPrompt(systemPrompt);
    if (fromSystemPrompt) {
      lastKnownActiveAgentName = fromSystemPrompt;
      return fromSystemPrompt;
    }

    return lastKnownActiveAgentName;
  };

  const shouldExposeTool = (toolName: string, agentName: string | null): boolean => {
    // Use tool-level permission check for tool injection decisions
    // This ensures that agent-specific tool deny rules (e.g., bash: deny) are respected
    // before any command-level permissions are considered
    const toolPermission = permissionManager.getToolPermission(toolName, agentName ?? undefined);
    return toolPermission !== "deny";
  };

  pi.on("session_start", async (event, ctx) => {
    runtimeContext = ctx;
    refreshExtensionConfig(ctx);
    permissionManager = createPermissionManagerForCwd(ctx.cwd);
    invalidateAgentStartCache();
    lastKnownActiveAgentName = getActiveAgentName(ctx);
    startForwardedPermissionPolling(ctx);

    if (event.reason === "reload") {
      writeDebugLog("lifecycle.reload", {
        triggeredBy: "session_start",
        reason: event.reason,
        cwd: ctx.cwd,
      });
    }
  });

  pi.on("session_switch", async (_event, ctx) => {
    runtimeContext = ctx;
    refreshExtensionConfig(ctx);
    permissionManager = createPermissionManagerForCwd(ctx.cwd);
    invalidateAgentStartCache();
    lastKnownActiveAgentName = getActiveAgentName(ctx);
    startForwardedPermissionPolling(ctx);
  });

  pi.on("resources_discover", async (event, _ctx) => {
    if (event.reason === "reload") {
      permissionManager = runtimeContext ? createPermissionManagerForCwd(runtimeContext.cwd) : new PermissionManager();
      invalidateAgentStartCache();
      writeDebugLog("lifecycle.reload", {
        triggeredBy: "resources_discover",
        reason: event.reason,
        cwd: runtimeContext?.cwd ?? null,
      });
    }
  });


  pi.on("session_shutdown", async () => {
    runtimeContext?.ui.setStatus(PERMISSION_SYSTEM_STATUS_KEY, undefined);
    runtimeContext = null;
    invalidateAgentStartCache();
    stopForwardedPermissionPolling();
  });

  pi.on("before_agent_start", async (event, ctx) => {
    runtimeContext = ctx;
    refreshExtensionConfig(ctx);
    startForwardedPermissionPolling(ctx);
    const agentName = resolveAgentName(ctx, event.systemPrompt);
    const allTools = pi.getAllTools();
    const allowedTools: string[] = [];

    for (const tool of allTools) {
      const toolName = getEventToolName(tool);
      if (!toolName) {
        continue;
      }

      if (shouldExposeTool(toolName, agentName)) {
        allowedTools.push(toolName);
      }
    }

    const activeToolsCacheKey = createActiveToolsCacheKey(allowedTools);
    if (shouldApplyCachedAgentStartState(lastActiveToolsCacheKey, activeToolsCacheKey)) {
      pi.setActiveTools(allowedTools);
      lastActiveToolsCacheKey = activeToolsCacheKey;
    }

    const promptStateCacheKey = createBeforeAgentStartPromptStateKey({
      agentName,
      cwd: ctx.cwd,
      permissionStamp: permissionManager.getPolicyCacheStamp(agentName ?? undefined),
      systemPrompt: event.systemPrompt,
      allowedToolNames: allowedTools,
    });

    if (!shouldApplyCachedAgentStartState(lastPromptStateCacheKey, promptStateCacheKey)) {
      return {};
    }

    lastPromptStateCacheKey = promptStateCacheKey;
    const toolPromptResult = sanitizeAvailableToolsSection(event.systemPrompt, allowedTools);
    const skillPromptResult = resolveSkillPromptEntries(toolPromptResult.prompt, permissionManager, agentName, ctx.cwd);
    activeSkillEntries = skillPromptResult.entries;

    if (skillPromptResult.prompt !== event.systemPrompt) {
      return { systemPrompt: skillPromptResult.prompt };
    }

    return {};
  });

  pi.on("input", async (event, ctx) => {
    runtimeContext = ctx;
    startForwardedPermissionPolling(ctx);
    const skillName = extractSkillNameFromInput(event.text);
    if (!skillName) {
      return { action: "continue" };
    }

    const agentName = resolveAgentName(ctx);
    const check = permissionManager.checkPermission("skill", { name: skillName }, agentName ?? undefined);

    if (check.state === "deny") {
      if (ctx.hasUI) {
        const message = agentName
          ? `Skill '${skillName}' is not permitted for agent '${agentName}'.`
          : `Skill '${skillName}' is not permitted by the current skill policy.`;
        ctx.ui.notify(message, "warning");
      }
      writeReviewLog("permission_request.blocked", {
        source: "skill_input",
        skillName,
        agentName,
        resolution: "policy_denied",
      });
      return { action: "handled" };
    }

    if (check.state === "ask") {
      const message = formatSkillAskPrompt(skillName, agentName ?? undefined);
      if (!canRequestPermissionConfirmation(ctx)) {
        writeReviewLog("permission_request.blocked", {
          source: "skill_input",
          skillName,
          agentName,
          message,
          resolution: "confirmation_unavailable",
        });
        return { action: "handled" };
      }

      const decision = await promptPermission(ctx, {
        requestId: createPermissionRequestId("skill-input"),
        source: "skill_input",
        agentName,
        message,
        skillName,
      });
      if (!decision.approved) {
        return { action: "handled" };
      }
    }

    return { action: "continue" };
  });

  pi.on("tool_call", async (event, ctx) => {
    runtimeContext = ctx;
    startForwardedPermissionPolling(ctx);
    const agentName = resolveAgentName(ctx);
    const toolName = getEventToolName(event);

    if (!toolName) {
      return { block: true, reason: formatMissingToolNameReason() };
    }

    const registrationCheck = checkRequestedToolRegistration(toolName, pi.getAllTools());
    if (registrationCheck.status === "missing-tool-name") {
      return { block: true, reason: formatMissingToolNameReason() };
    }

    if (registrationCheck.status === "unregistered") {
      return {
        block: true,
        reason: formatUnknownToolReason(registrationCheck.requestedToolName, registrationCheck.availableToolNames),
      };
    }

    if (isToolCallEventType("read", event) && activeSkillEntries.length > 0) {
      const normalizedReadPath = normalizePathForComparison(event.input.path, ctx.cwd);
      const matchedSkill = findSkillPathMatch(normalizedReadPath, activeSkillEntries);

      if (matchedSkill) {
        if (matchedSkill.state === "deny") {
          writeReviewLog("permission_request.blocked", {
            source: "skill_read",
            skillName: matchedSkill.name,
            agentName,
            path: event.input.path,
            resolution: "policy_denied",
          });
          return {
            block: true,
            reason: formatSkillPathDenyReason(matchedSkill, event.input.path, agentName ?? undefined),
          };
        }

        if (matchedSkill.state === "ask") {
          const message = formatSkillPathAskPrompt(matchedSkill, event.input.path, agentName ?? undefined);
          if (!canRequestPermissionConfirmation(ctx)) {
            writeReviewLog("permission_request.blocked", {
              source: "skill_read",
              skillName: matchedSkill.name,
              agentName,
              path: event.input.path,
              message,
              resolution: "confirmation_unavailable",
            });
            return {
              block: true,
              reason: `Accessing skill '${matchedSkill.name}' requires approval, but no interactive UI is available.`,
            };
          }

          const decision = await promptPermission(ctx, {
            requestId: event.toolCallId,
            source: "skill_read",
            agentName,
            message,
            toolCallId: event.toolCallId,
            toolName: toolName,
            skillName: matchedSkill.name,
            path: event.input.path,
          });
          if (!decision.approved) {
            const denialReason = decision.denialReason ? ` Reason: ${decision.denialReason}.` : "";
            return { block: true, reason: `User denied access to skill '${matchedSkill.name}'.${denialReason}` };
          }
        }
      }
    }

    if (ctx.cwd && PATH_BEARING_TOOLS.has(toolName)) {
      const toolInput = getEventInput(event);
      const inputRecord = toRecord(toolInput);
      const rawPath = typeof inputRecord.path === "string" ? inputRecord.path.trim() : null;

      if (rawPath) {
        const normalizedCwd = normalizeFilesystemPath(ctx.cwd);
        const normalizedFilePath = normalizePathForComparison(rawPath, ctx.cwd);

        if (normalizedFilePath && !isPathWithinDirectory(normalizedFilePath, normalizedCwd)) {
          const extCheck = permissionManager.checkPermission("external_directory", {}, agentName ?? undefined);

          if (extCheck.state === "deny") {
            writeReviewLog("permission_request.blocked", {
              source: "tool_call",
              toolCallId: event.toolCallId,
              toolName,
              agentName,
              path: rawPath,
              resolution: "policy_denied",
            });
            return {
              block: true,
              reason: formatExternalDirectoryDenyReason(rawPath, ctx.cwd, agentName ?? undefined),
            };
          }

          if (extCheck.state === "ask") {
            const message = formatExternalDirectoryAskPrompt(rawPath, ctx.cwd, agentName ?? undefined);
            if (!canRequestPermissionConfirmation(ctx)) {
              writeReviewLog("permission_request.blocked", {
                source: "tool_call",
                toolCallId: event.toolCallId,
                toolName,
                agentName,
                path: rawPath,
                message,
                resolution: "confirmation_unavailable",
              });
              return {
                block: true,
                reason: `Accessing '${rawPath}' outside the working directory requires approval, but no interactive UI is available.`,
              };
            }

            const extDecision = await promptPermission(ctx, {
              requestId: event.toolCallId,
              source: "tool_call",
              agentName,
              message,
              toolCallId: event.toolCallId,
              toolName,
              path: rawPath,
            });

            if (!extDecision.approved) {
              return {
                block: true,
                reason: formatExternalDirectoryUserDeniedReason(rawPath, extDecision.denialReason),
              };
            }
          }
          // state === "allow" → fall through to normal permission check
        }
      }
    }

    const input = getEventInput(event);
    const check = permissionManager.checkPermission(toolName, input, agentName ?? undefined);
    const permissionLogContext = getPermissionLogContext(check);

    if (check.state === "deny") {
      writeReviewLog("permission_request.blocked", {
        source: "tool_call",
        toolCallId: event.toolCallId,
        toolName,
        agentName,
        ...permissionLogContext,
        resolution: "policy_denied",
      });
      return { block: true, reason: formatDenyReason(check, agentName ?? undefined) };
    }

    if (check.state === "ask") {
      const unavailableReason = toolName === "bash" && isToolCallEventType("bash", event)
        ? `Running bash command '${event.input.command}' requires approval, but no interactive UI is available.`
        : toolName === "mcp"
          ? "Using tool 'mcp' requires approval, but no interactive UI is available."
          : `Using tool '${toolName}' requires approval, but no interactive UI is available.`;

      const message = formatAskPrompt(check, agentName ?? undefined);
      if (!canRequestPermissionConfirmation(ctx)) {
        writeReviewLog("permission_request.blocked", {
          source: "tool_call",
          toolCallId: event.toolCallId,
          toolName,
          agentName,
          message,
          ...permissionLogContext,
          resolution: "confirmation_unavailable",
        });
        return {
          block: true,
          reason: unavailableReason,
        };
      }

      const decision = await promptPermission(ctx, {
        requestId: event.toolCallId,
        source: "tool_call",
        agentName,
        message,
        toolCallId: event.toolCallId,
        toolName,
        ...permissionLogContext,
      });
      if (!decision.approved) {
        return { block: true, reason: formatUserDeniedReason(check, decision.denialReason) };
      }
    }

    return {};
  });
}
