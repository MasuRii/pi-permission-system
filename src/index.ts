import { isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve, sep } from "node:path";

import { PermissionManager } from "./permission-manager.js";
import { sanitizeAvailableToolsSection } from "./system-prompt-sanitizer.js";
import { checkRequestedToolRegistration, getToolNameFromValue } from "./tool-registry.js";
import type { PermissionCheckResult, PermissionState } from "./types.js";

const PI_AGENT_DIR = join(homedir(), ".pi", "agent");
const AGENTS_DIR = join(PI_AGENT_DIR, "agents");
const SESSIONS_DIR = join(PI_AGENT_DIR, "sessions");
const SUBAGENT_SESSIONS_DIR = join(PI_AGENT_DIR, "subagent-sessions");
const PERMISSION_FORWARDING_DIR = join(SESSIONS_DIR, "permission-forwarding");
const PERMISSION_FORWARDING_REQUESTS_DIR = join(PERMISSION_FORWARDING_DIR, "requests");
const PERMISSION_FORWARDING_RESPONSES_DIR = join(PERMISSION_FORWARDING_DIR, "responses");
const LEGACY_PERMISSION_FORWARDING_DIR = join(PI_AGENT_DIR, "permission-forwarding");
const LEGACY_PERMISSION_FORWARDING_REQUESTS_DIR = join(LEGACY_PERMISSION_FORWARDING_DIR, "requests");
const LEGACY_PERMISSION_FORWARDING_RESPONSES_DIR = join(LEGACY_PERMISSION_FORWARDING_DIR, "responses");
const PERMISSION_FORWARDING_POLL_INTERVAL_MS = 250;
const PERMISSION_FORWARDING_TIMEOUT_MS = 10 * 60 * 1000;
const SUBAGENT_ENV_HINT_KEYS = ["PI_IS_SUBAGENT", "PI_SUBAGENT_SESSION_ID", "PI_AGENT_ROUTER_SUBAGENT"] as const;
const ORCHESTRATOR_AGENT_NAME = "orchestrator";
const DELEGATION_TOOL_NAME = "task";
const TOOL_PERMISSION_MAP: Record<string, string> = {
  bash: "bash",
  read: "read",
  write: "write",
  edit: "edit",
  grep: "grep",
  find: "find",
  ls: "ls",
  mcp: "mcp",
  task: "task",
};
const LEGACY_TOOL_ALIASES: Record<string, string> = {};
const DEFAULT_ALLOWED_MAPPED_TOOLS = new Set<string>();

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

type ForwardedPermissionRequest = {
  id: string;
  createdAt: number;
  requesterSessionId: string;
  requesterAgentName: string;
  message: string;
};

type ForwardedPermissionResponse = {
  approved: boolean;
  responderSessionId: string;
  respondedAt: number;
};

type PermissionForwardingLocation = {
  requestsDir: string;
  responsesDir: string;
  label: "primary" | "legacy";
};

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
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
    const state: PermissionState = agentName ? check.state : "deny";
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

function isPermissionState(value: unknown): value is PermissionState {
  return value === "allow" || value === "deny" || value === "ask";
}

type StackNode = { indent: number; target: Record<string, unknown> };

function parseSimpleYamlMap(input: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: StackNode[] = [{ indent: -1, target: root }];

  const lines = input.split(/\r?\n/);
  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) {
      continue;
    }

    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();

    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim().replace(/^['"]|['"]$/g, "");
    const rawValue = line.slice(separatorIndex + 1).trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const current = stack[stack.length - 1].target;

    if (!rawValue) {
      const child: Record<string, unknown> = {};
      current[key] = child;
      stack.push({ indent, target: child });
      continue;
    }

    let scalar = rawValue;
    if ((scalar.startsWith('"') && scalar.endsWith('"')) || (scalar.startsWith("'") && scalar.endsWith("'"))) {
      scalar = scalar.slice(1, -1);
    }

    current[key] = scalar;
  }

  return root;
}

function extractFrontmatter(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return "";
  }

  const end = normalized.indexOf("\n---", 4);
  if (end === -1) {
    return "";
  }

  return normalized.slice(4, end);
}

function loadAgentPermissionFields(agentName?: string): Record<string, PermissionState> {
  if (!agentName) {
    return {};
  }

  const filePath = join(AGENTS_DIR, `${agentName}.md`);
  try {
    const markdown = readFileSync(filePath, "utf-8");
    const frontmatter = extractFrontmatter(markdown);
    if (!frontmatter) {
      return {};
    }

    const parsedFrontmatter = parseSimpleYamlMap(frontmatter);
    const permissionBlock = toRecord(parsedFrontmatter.permission);
    const permissions: Record<string, PermissionState> = {};

    const collectStates = (value: unknown): void => {
      const record = toRecord(value);
      for (const [key, state] of Object.entries(record)) {
        if (isPermissionState(state)) {
          permissions[key] = state;
        }
      }
    };

    collectStates(permissionBlock.tools);
    collectStates(permissionBlock.mcp);
    collectStates(permissionBlock.bash);
    collectStates(permissionBlock.skills);
    collectStates(permissionBlock.special);

    for (const [key, value] of Object.entries(permissionBlock)) {
      if (isPermissionState(value)) {
        permissions[key] = value;
      }
    }

    return permissions;
  } catch {
    return {};
  }
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

function isDelegationAllowedAgent(agentName: string | null): boolean {
  return Boolean(agentName && agentName.toLowerCase() === ORCHESTRATOR_AGENT_NAME);
}

function getDelegationBlockReason(agentName: string | null): string {
  const resolvedAgent = agentName ?? "none";
  return `Tool '${DELEGATION_TOOL_NAME}' is restricted to '${ORCHESTRATOR_AGENT_NAME}'. Active agent '${resolvedAgent}' cannot delegate.`;
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
    : " If this was intended as an MCP server tool, call the built-in 'mcp' tool (for example: {\"tool\":\"server:tool\"}).";

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

function formatUserDeniedReason(result: PermissionCheckResult): string {
  const base = (result.source === "mcp" || result.toolName === "mcp") && result.target
    ? `User denied MCP target '${result.target}'.`
    : result.toolName === "bash" && result.command
      ? `User denied bash command '${result.command}'.`
      : `User denied tool '${result.toolName}'.`;

  return `${base} ${formatPermissionHardStopHint(result)}`;
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
  return ctx.hasUI || isSubagentExecutionContext(ctx);
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
  if (typeof error === "undefined") {
    console.warn(`[pi-permission-system] ${message}`);
    return;
  }

  console.warn(`[pi-permission-system] ${message}: ${formatUnknownErrorMessage(error)}`);
}

function logPermissionForwardingError(message: string, error?: unknown): void {
  if (typeof error === "undefined") {
    console.error(`[pi-permission-system] ${message}`);
    return;
  }

  console.error(`[pi-permission-system] ${message}: ${formatUnknownErrorMessage(error)}`);
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

function ensurePermissionForwardingDirectories(): boolean {
  const requestsReady = ensureDirectoryExists(PERMISSION_FORWARDING_REQUESTS_DIR, "permission forwarding requests");
  const responsesReady = ensureDirectoryExists(PERMISSION_FORWARDING_RESPONSES_DIR, "permission forwarding responses");
  return requestsReady && responsesReady;
}

function ensureLegacyPermissionForwardingResponsesDirectory(): boolean {
  if (existsSync(LEGACY_PERMISSION_FORWARDING_RESPONSES_DIR)) {
    return true;
  }

  if (!existsSync(LEGACY_PERMISSION_FORWARDING_DIR)) {
    logPermissionForwardingWarning(`Legacy permission-forwarding root '${LEGACY_PERMISSION_FORWARDING_DIR}' does not exist`);
    return false;
  }

  try {
    mkdirSync(LEGACY_PERMISSION_FORWARDING_RESPONSES_DIR, { recursive: true });
    return true;
  } catch (error) {
    logPermissionForwardingError(
      `Failed to create legacy permission forwarding responses directory '${LEGACY_PERMISSION_FORWARDING_RESPONSES_DIR}'`,
      error,
    );
    return false;
  }
}

function getPermissionForwardingLocationsForProcessing(): PermissionForwardingLocation[] {
  const locations: PermissionForwardingLocation[] = [];

  if (ensurePermissionForwardingDirectories()) {
    locations.push({
      requestsDir: PERMISSION_FORWARDING_REQUESTS_DIR,
      responsesDir: PERMISSION_FORWARDING_RESPONSES_DIR,
      label: "primary",
    });
  }

  if (existsSync(LEGACY_PERMISSION_FORWARDING_REQUESTS_DIR)) {
    locations.push({
      requestsDir: LEGACY_PERMISSION_FORWARDING_REQUESTS_DIR,
      responsesDir: LEGACY_PERMISSION_FORWARDING_RESPONSES_DIR,
      label: "legacy",
    });
  }

  return locations;
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

function cleanupLegacyPermissionForwardingDirectoryIfEmpty(): void {
  if (!existsSync(LEGACY_PERMISSION_FORWARDING_DIR)) {
    return;
  }

  tryRemoveDirectoryIfEmpty(LEGACY_PERMISSION_FORWARDING_REQUESTS_DIR, "legacy permission forwarding requests");
  tryRemoveDirectoryIfEmpty(LEGACY_PERMISSION_FORWARDING_RESPONSES_DIR, "legacy permission forwarding responses");
  tryRemoveDirectoryIfEmpty(LEGACY_PERMISSION_FORWARDING_DIR, "legacy permission forwarding root");
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
    if (!parsed || typeof parsed.approved !== "boolean" || typeof parsed.responderSessionId !== "string") {
      logPermissionForwardingWarning(`Ignoring invalid forwarded permission response format in '${filePath}'`);
      return null;
    }

    return {
      approved: parsed.approved,
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

async function waitForForwardedPermissionApproval(ctx: ExtensionContext, message: string): Promise<boolean> {
  if (!ensurePermissionForwardingDirectories()) {
    logPermissionForwardingError("Permission forwarding is unavailable because primary directories could not be prepared");
    return false;
  }

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${process.pid}`;
  const requesterAgentName = getActiveAgentName(ctx) || getActiveAgentNameFromSystemPrompt(ctx.getSystemPrompt()) || "unknown";
  const request: ForwardedPermissionRequest = {
    id: requestId,
    createdAt: Date.now(),
    requesterSessionId: getSessionId(ctx),
    requesterAgentName,
    message,
  };

  const requestPath = join(PERMISSION_FORWARDING_REQUESTS_DIR, `${requestId}.json`);
  const responsePath = join(PERMISSION_FORWARDING_RESPONSES_DIR, `${requestId}.json`);

  try {
    writeJsonFileAtomic(requestPath, request);
  } catch (error) {
    logPermissionForwardingError(`Failed to write forwarded permission request '${requestPath}'`, error);
    return false;
  }

  const deadline = Date.now() + PERMISSION_FORWARDING_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(responsePath)) {
      const response = readForwardedPermissionResponse(responsePath);
      safeDeleteFile(responsePath, "forwarded permission response");
      safeDeleteFile(requestPath, "forwarded permission request");
      return Boolean(response?.approved);
    }

    await sleep(PERMISSION_FORWARDING_POLL_INTERVAL_MS);
  }

  logPermissionForwardingWarning(`Timed out waiting for forwarded permission response '${responsePath}'`);
  safeDeleteFile(requestPath, "forwarded permission request");
  return false;
}

async function processForwardedPermissionRequests(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) {
    return;
  }

  const forwardingLocations = getPermissionForwardingLocationsForProcessing();
  if (forwardingLocations.length === 0) {
    return;
  }

  for (const location of forwardingLocations) {
    let requestFiles: string[] = [];
    try {
      requestFiles = readdirSync(location.requestsDir)
        .filter((name) => name.endsWith(".json"))
        .sort();
    } catch (error) {
      logPermissionForwardingWarning(`Failed to read ${location.label} permission forwarding requests from '${location.requestsDir}'`, error);
      continue;
    }

    for (const fileName of requestFiles) {
      const requestPath = join(location.requestsDir, fileName);
      const request = readForwardedPermissionRequest(requestPath);
      if (!request) {
        safeDeleteFile(requestPath, `${location.label} forwarded permission request`);
        continue;
      }

      let approved = false;
      try {
        approved = await ctx.ui.confirm("Permission Required (Subagent)", formatForwardedPermissionPrompt(request));
      } catch (error) {
        logPermissionForwardingError("Failed to show forwarded permission confirmation dialog", error);
        approved = false;
      }

      if (location.label === "legacy" && !ensureLegacyPermissionForwardingResponsesDirectory()) {
        continue;
      }

      const responsePath = join(location.responsesDir, `${request.id}.json`);
      try {
        writeJsonFileAtomic(responsePath, {
          approved,
          responderSessionId: getSessionId(ctx),
          respondedAt: Date.now(),
        } satisfies ForwardedPermissionResponse);
      } catch (error) {
        logPermissionForwardingError(`Failed to write ${location.label} forwarded permission response '${responsePath}'`, error);
        continue;
      }

      safeDeleteFile(requestPath, `${location.label} forwarded permission request`);
    }
  }

  cleanupLegacyPermissionForwardingDirectoryIfEmpty();
}

async function confirmPermission(ctx: ExtensionContext, message: string): Promise<boolean> {
  if (ctx.hasUI) {
    return ctx.ui.confirm("Permission Required", message);
  }

  if (!isSubagentExecutionContext(ctx)) {
    return false;
  }

  return waitForForwardedPermissionApproval(ctx, message);
}

function getMappedPermissionState(toolName: string, permissionFields: Record<string, PermissionState>): PermissionState | undefined {
  const normalizedToolName = LEGACY_TOOL_ALIASES[toolName] || toolName;
  const directState = permissionFields[normalizedToolName];
  if (directState) {
    return directState;
  }

  const permissionKey = TOOL_PERMISSION_MAP[normalizedToolName];
  if (!permissionKey) {
    return undefined;
  }

  const mappedState = permissionFields[permissionKey];
  if (mappedState) {
    return mappedState;
  }

  for (const [legacyToolName, canonicalToolName] of Object.entries(LEGACY_TOOL_ALIASES)) {
    if (canonicalToolName !== normalizedToolName) {
      continue;
    }

    const legacyState = permissionFields[legacyToolName];
    if (legacyState) {
      return legacyState;
    }
  }

  if (DEFAULT_ALLOWED_MAPPED_TOOLS.has(permissionKey)) {
    return "allow";
  }

  return undefined;
}

function createMappedResult(toolName: string, input: unknown, state: PermissionState): PermissionCheckResult {
  const result: PermissionCheckResult = {
    toolName,
    state,
    source: "tool",
  };

  if (toolName === "bash") {
    const command = toRecord(input).command;
    if (typeof command === "string") {
      result.command = command;
    }
  }

  return result;
}

export default function piPermissionSystemExtension(pi: ExtensionAPI): void {
  let permissionManager = new PermissionManager();
  const cachedAgentPermissions = new Map<string, Record<string, PermissionState>>();
  let activeSkillEntries: SkillPromptEntry[] = [];
  let lastKnownActiveAgentName: string | null = null;
  let permissionForwardingContext: ExtensionContext | null = null;
  let permissionForwardingTimer: NodeJS.Timeout | null = null;
  let isProcessingForwardedRequests = false;

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

  const getAgentPermissionFields = (agentName: string | null): Record<string, PermissionState> => {
    if (!agentName) {
      return {};
    }

    const cached = cachedAgentPermissions.get(agentName);
    if (cached) {
      return cached;
    }

    const loaded = loadAgentPermissionFields(agentName);
    cachedAgentPermissions.set(agentName, loaded);
    return loaded;
  };

  const shouldExposeTool = (toolName: string, agentName: string | null): boolean => {
    if (toolName === DELEGATION_TOOL_NAME && !isDelegationAllowedAgent(agentName)) {
      return false;
    }

    const permissionFields = getAgentPermissionFields(agentName);
    const mappedState = getMappedPermissionState(toolName, permissionFields);
    if (mappedState) {
      return mappedState !== "deny";
    }

    const check = permissionManager.checkPermission(toolName, {}, agentName ?? undefined);
    return check.state !== "deny";
  };

  pi.on("session_start", async (_event, ctx) => {
    permissionManager = new PermissionManager();
    cachedAgentPermissions.clear();
    activeSkillEntries = [];
    lastKnownActiveAgentName = getActiveAgentName(ctx);
    startForwardedPermissionPolling(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    activeSkillEntries = [];
    lastKnownActiveAgentName = getActiveAgentName(ctx);
    startForwardedPermissionPolling(ctx);
  });

  pi.on("session_shutdown", async () => {
    stopForwardedPermissionPolling();
  });

  pi.on("before_agent_start", async (event, ctx) => {
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

    pi.setActiveTools(allowedTools);

    const toolPromptResult = sanitizeAvailableToolsSection(event.systemPrompt, allowedTools);
    const skillPromptResult = resolveSkillPromptEntries(toolPromptResult.prompt, permissionManager, agentName, ctx.cwd);
    activeSkillEntries = skillPromptResult.entries;

    if (skillPromptResult.prompt !== event.systemPrompt) {
      return { systemPrompt: skillPromptResult.prompt };
    }

    return {};
  });

  pi.on("input", async (event, ctx) => {
    startForwardedPermissionPolling(ctx);
    const skillName = extractSkillNameFromInput(event.text);
    if (!skillName) {
      return { action: "continue" };
    }

    const agentName = resolveAgentName(ctx);

    if (!agentName) {
      if (ctx.hasUI) {
        ctx.ui.notify(`Skill '${skillName}' is blocked because active agent context is unavailable.`, "warning");
      }
      return { action: "handled" };
    }

    const check = permissionManager.checkPermission("skill", { name: skillName }, agentName ?? undefined);

    if (check.state === "deny") {
      if (ctx.hasUI) {
        const resolvedAgent = agentName ?? "none";
        ctx.ui.notify(`Skill '${skillName}' is not permitted for agent '${resolvedAgent}'.`, "warning");
      }
      return { action: "handled" };
    }

    if (check.state === "ask") {
      if (!canRequestPermissionConfirmation(ctx)) {
        return { action: "handled" };
      }

      const approved = await confirmPermission(ctx, formatSkillAskPrompt(skillName, agentName ?? undefined));
      if (!approved) {
        return { action: "handled" };
      }
    }

    return { action: "continue" };
  });

  pi.on("tool_call", async (event, ctx) => {
    startForwardedPermissionPolling(ctx);
    const agentName = resolveAgentName(ctx);
    const permissionFields = getAgentPermissionFields(agentName);
    const toolName = getEventToolName(event);

    if (!toolName) {
      return { block: true, reason: formatMissingToolNameReason() };
    }

    const registrationCheck = checkRequestedToolRegistration(toolName, pi.getAllTools(), LEGACY_TOOL_ALIASES);
    if (registrationCheck.status === "missing-tool-name") {
      return { block: true, reason: formatMissingToolNameReason() };
    }

    if (registrationCheck.status === "unregistered") {
      return {
        block: true,
        reason: formatUnknownToolReason(registrationCheck.requestedToolName, registrationCheck.availableToolNames),
      };
    }

    if (toolName === DELEGATION_TOOL_NAME && !isDelegationAllowedAgent(agentName)) {
      return { block: true, reason: getDelegationBlockReason(agentName) };
    }

    if (isToolCallEventType("read", event) && activeSkillEntries.length > 0) {
      const normalizedReadPath = normalizePathForComparison(event.input.path, ctx.cwd);
      const matchedSkill = findSkillPathMatch(normalizedReadPath, activeSkillEntries);

      if (matchedSkill) {
        if (matchedSkill.state === "deny") {
          return {
            block: true,
            reason: formatSkillPathDenyReason(matchedSkill, event.input.path, agentName ?? undefined),
          };
        }

        if (matchedSkill.state === "ask") {
          if (!canRequestPermissionConfirmation(ctx)) {
            return {
              block: true,
              reason: `Accessing skill '${matchedSkill.name}' requires approval, but no interactive UI is available.`,
            };
          }

          const approved = await confirmPermission(
            ctx,
            formatSkillPathAskPrompt(matchedSkill, event.input.path, agentName ?? undefined),
          );
          if (!approved) {
            return { block: true, reason: `User denied access to skill '${matchedSkill.name}'.` };
          }
        }
      }
    }

    if (isToolCallEventType("bash", event)) {
      const command = event.input.command;
      const mappedBashState = getMappedPermissionState("bash", permissionFields);
      let mappedAskApproved = false;

      if (mappedBashState) {
        const mappedCheck = createMappedResult("bash", { command }, mappedBashState);

        if (mappedCheck.state === "deny") {
          return { block: true, reason: formatDenyReason(mappedCheck, agentName ?? undefined) };
        }

        if (mappedCheck.state === "ask") {
          if (!canRequestPermissionConfirmation(ctx)) {
            return {
              block: true,
              reason: `Running bash command '${command}' requires approval, but no interactive UI is available.`,
            };
          }

          const approved = await confirmPermission(ctx, formatAskPrompt(mappedCheck, agentName ?? undefined));
          if (!approved) {
            return { block: true, reason: formatUserDeniedReason(mappedCheck) };
          }
          mappedAskApproved = true;
        }
      }

      const check = permissionManager.checkPermission("bash", { command }, agentName ?? undefined);

      if (check.state === "deny") {
        return { block: true, reason: formatDenyReason(check, agentName ?? undefined) };
      }

      if (check.state === "ask") {
        if (mappedAskApproved || mappedBashState === "allow") {
          return {};
        }

        if (!canRequestPermissionConfirmation(ctx)) {
          return {
            block: true,
            reason: `Running bash command '${command}' requires approval, but no interactive UI is available.`,
          };
        }

        const approved = await confirmPermission(ctx, formatAskPrompt(check, agentName ?? undefined));
        if (!approved) {
          return { block: true, reason: formatUserDeniedReason(check) };
        }
      }

      return {};
    }

    const mappedState = getMappedPermissionState(toolName, permissionFields);
    if (mappedState) {
      const mappedCheck = createMappedResult(toolName, getEventInput(event), mappedState);

      if (mappedCheck.state === "deny") {
        return { block: true, reason: formatDenyReason(mappedCheck, agentName ?? undefined) };
      }

      if (mappedCheck.state === "ask") {
        if (!canRequestPermissionConfirmation(ctx)) {
          return {
            block: true,
            reason: `Using tool '${toolName}' requires approval, but no interactive UI is available.`,
          };
        }

        const approved = await confirmPermission(ctx, formatAskPrompt(mappedCheck, agentName ?? undefined));
        if (!approved) {
          return { block: true, reason: formatUserDeniedReason(mappedCheck) };
        }
      }

      return {};
    }

    const check = permissionManager.checkPermission(toolName, getEventInput(event), agentName ?? undefined);

    if (check.state === "deny") {
      return { block: true, reason: formatDenyReason(check, agentName ?? undefined) };
    }

    if (check.state === "ask") {
      if (!canRequestPermissionConfirmation(ctx)) {
        return {
          block: true,
          reason: `Using tool '${toolName}' requires approval, but no interactive UI is available.`,
        };
      }

      const approved = await confirmPermission(ctx, formatAskPrompt(check, agentName ?? undefined));
      if (!approved) {
        return { block: true, reason: formatUserDeniedReason(check) };
      }
    }

    return {};
  });
}
