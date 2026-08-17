import { getAgentDir, isToolCallEventType, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type BeforeAgentStartEvent, type InputEvent, type ResourcesDiscoverEvent, type SessionStartEvent, type ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, unlinkSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, normalize, relative, resolve } from "node:path";

import {
  createPermissionSystemCommandHandler,
  getNonEmptyString,
  isPathWithinDirectory,
  normalizeAgentName,
  normalizePathForComparison,
  normalizePathResourceForPermission,
  PERMISSION_SYSTEM_COMMAND_DESCRIPTION,
  toRecord,
} from "./common.js";
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
  type PermissionSystemConfigLoadResult,
  type PermissionSystemExtensionConfig,
} from "./extension-config.js";
import { createPermissionSystemLogger, safeJsonStringify } from "./logging.js";
import { isNodeErrorWithCode } from "./jsonc-config.js";
import {
  createPermissionForwardingLocation,
  isForwardedPermissionRequestForSession,
  PERMISSION_FORWARDING_POLL_INTERVAL_MS,
  PERMISSION_FORWARDING_WATCH_DEBOUNCE_MS,
  PERMISSION_FORWARDING_TIMEOUT_MS,
  resolvePermissionForwardingRootDir,
  resolvePermissionForwardingTargetSessionId,
  SUBAGENT_ENV_HINT_KEYS,
  type ForwardedPermissionRequest,
  type ForwardedPermissionResponse,
  type PermissionForwardingLocation,
} from "./permission-forwarding.js";
import { evaluatePermission, type PatternPermissionRule } from "./evaluate-permission.js";
import {
  formatAskPrompt,
  formatDenyReason,
  formatExternalDirectoryAskPrompt,
  formatExternalDirectoryDenyReason,
  formatExternalDirectoryUserDeniedReason,
  formatMissingToolNameReason,
  formatSkillAskPrompt,
  formatSkillPathAskPrompt,
  formatSkillPathDenyReason,
  formatToolInputForPrompt,
  formatUnknownToolReason,
  formatUserDeniedReason,
  getStructuredEditPayloads,
  hasStructuredEditPayload,
} from "./permission-prompts.js";
import { PermissionManager } from "./permission-manager.js";
import { SessionApprovalStore } from "./session-approval-store.js";
import {
  findSkillPathMatch,
  resolveSkillPromptEntries,
  type SkillPromptEntry,
} from "./skill-prompt-sanitizer.js";
import { sanitizeAvailableToolsSection } from "./system-prompt-sanitizer.js";
import { checkRequestedToolRegistration, getToolNameFromValue } from "./tool-registry.js";
import type { PermissionCheckResult } from "./types.js";
import { PERMISSION_SYSTEM_STATUS_KEY, syncPermissionSystemStatus } from "./status.js";
import { canResolveAskPermissionRequest, shouldAutoApprovePermissionState } from "./yolo-mode.js";
import {
  registerPiPermissionSystemRuntimeApi,
  unregisterPiPermissionSystemRuntimeApi,
  type PiPermissionSystemRuntimeApi,
  type YoloModeControlOptions,
  type YoloModeControlResult,
} from "./yolo-mode-api.js";

const PI_AGENT_DIR = getAgentDir();
const SUBAGENT_SESSIONS_DIR = join(PI_AGENT_DIR, "subagent-sessions");

let cachedSubagentEnvHint: { signature: string; value: boolean } | undefined;

function hasSubagentEnvHint(): boolean {
  const values = SUBAGENT_ENV_HINT_KEYS.map((key: string) => process.env[key]?.trim() ?? "");
  const signature = values.join("\u0000");
  if (cachedSubagentEnvHint?.signature === signature) {
    return cachedSubagentEnvHint.value;
  }

  const value = values.some((entry: string) => entry.length > 0);
  cachedSubagentEnvHint = { signature, value };
  return value;
}

const ACTIVE_AGENT_TAG_REGEX = /<active_agent\s+name=["']([^"']+)["'][^>]*>/i;

type PermissionRequestSource = "tool_call" | "skill_input" | "skill_read";
type PermissionRequestState = "waiting" | "approved" | "denied";

type PermissionRequestCommonFields = {
  requestId: string;
  source: PermissionRequestSource;
  message: string;
  toolCallId?: string;
  toolName?: string;
  skillName?: string;
  path?: string;
  command?: string;
  target?: string;
  toolInput?: unknown;
};

type PermissionRequestEvent = PermissionRequestCommonFields & {
  state: PermissionRequestState;
  agentName?: string | null;
};

type SensitiveLogMetadata = {
  present: boolean;
  length: number;
  sha256: string;
};

type PermissionPromptDetails = PermissionRequestCommonFields & {
  agentName: string | null;
  commandMetadata?: SensitiveLogMetadata | null;
  resolution?: string;
  denialReason?: string;
  decisionPersistence?: string;
  approvalPersistence?: string;
  decisionScope?: string;
  approvalScope?: string;
};

type CachedPermissionPromptDecision = {
  cachedAt: number;
  decisionPromise: Promise<PermissionPromptDecision>;
};

const PERMISSION_REQUEST_EVENT_CHANNEL = "pi-permission-system:permission-request";
const DEFAULT_FORWARDED_PERMISSION_PROMPT_TIMEOUT_REASON = "permission_timeout: forwarded permission prompt was not answered within the configured timeout.";
const PATH_BEARING_TOOLS = new Set(["read", "write", "edit", "find", "grep", "ls"]);
const FILESYSTEM_TOOL_NAME_SUFFIXES = ["read", "write", "edit", "find", "grep", "search", "list", "ls"] as const;
const SKILLS_DIR_PARTS = [".pi", "agent", "skills"] as const;
const DUPLICATE_PERMISSION_PROMPT_CACHE_TTL_MS = 2 * 60 * 1000;
const DUPLICATE_PERMISSION_PROMPT_CACHE_MAX_ENTRIES = 128;

let extensionConfig: PermissionSystemExtensionConfig = { ...DEFAULT_EXTENSION_CONFIG };
let runtimeApi: PiPermissionSystemRuntimeApi | null = null;
const extensionLogger = createPermissionSystemLogger({
  getConfig: () => extensionConfig,
});
const reportedLoggingWarnings = new Set<string>();
let loggingWarningReporter: ((message: string) => void) | null = null;

export function setExtensionConfig(config: PermissionSystemExtensionConfig): void {
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

function writeLogEntry(
  stream: "debug" | "review",
  event: string,
  details: Record<string, unknown> = {},
): void {
  const warning = stream === "debug"
    ? extensionLogger.debug(event, details)
    : extensionLogger.review(event, details);
  if (warning) {
    reportLoggingWarning(warning);
  }
}

function writeDebugEntry(event: string, details: Record<string, unknown> = {}): void {
  writeLogEntry("debug", event, details);
}

function writeReviewEntry(event: string, details: Record<string, unknown> = {}): void {
  writeLogEntry("review", event, details);
}

function isLikelyFilesystemToolName(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  const nameParts = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  return FILESYSTEM_TOOL_NAME_SUFFIXES.some((suffix) =>
    normalized.endsWith(suffix) || nameParts.includes(suffix),
  );
}

function getPathBearingToolPath(toolName: string, input: unknown): string | null {
  const inputRecord = toRecord(input);
  const path = getNonEmptyString(inputRecord.path) ?? getNonEmptyString(inputRecord.file_path);
  if (!path) {
    return null;
  }

  if (PATH_BEARING_TOOLS.has(toolName)) {
    return path;
  }

  if (hasStructuredEditPayload(inputRecord) || isLikelyFilesystemToolName(toolName)) {
    return path;
  }

  return null;
}

function isPathOutsideWorkingDirectory(pathValue: string, cwd: string): boolean {
  const normalizedCwd = normalizePathForComparison(cwd, cwd);
  const normalizedPath = normalizePathForComparison(pathValue, cwd);
  return Boolean(normalizedCwd && normalizedPath && !isPathWithinDirectory(normalizedPath, normalizedCwd));
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

function getContextSystemPrompt(ctx: ExtensionContext): string | undefined {
  const getSystemPrompt = toRecord(ctx).getSystemPrompt;
  if (typeof getSystemPrompt !== "function") {
    return undefined;
  }

  try {
    const systemPrompt: unknown = getSystemPrompt.call(ctx);
    return typeof systemPrompt === "string" ? systemPrompt : undefined;
  } catch (error) {
    logPermissionForwardingWarning("Failed to read context system prompt for forwarded permission metadata", error);
    return undefined;
  }
}

function extractSkillNameUnderRoot(normalizedReadPath: string, normalizedSkillsRoot: string): string | null {
  if (!isPathWithinDirectory(normalizedReadPath, normalizedSkillsRoot)) {
    return null;
  }

  const relativeSkillPath = relative(normalizedSkillsRoot, normalizedReadPath);
  const skillName = relativeSkillPath.split(/[\\/]+/).find((part: string) => part.length > 0);
  return skillName ?? null;
}

function inferSkillEntryFromReadPath(
  readPath: string,
  cwd: string,
  state: SkillPromptEntry["state"],
): SkillPromptEntry | null {
  const normalizedReadPath = normalizePathForComparison(readPath, cwd);
  if (!normalizedReadPath) {
    return null;
  }

  const candidateSkillRoots = [
    join(PI_AGENT_DIR, "skills"),
    join(cwd, ...SKILLS_DIR_PARTS),
  ];

  for (const skillRoot of candidateSkillRoots) {
    const normalizedSkillRoot = normalizePathForComparison(skillRoot, cwd);
    const skillName = extractSkillNameUnderRoot(normalizedReadPath, normalizedSkillRoot);
    if (!skillName) {
      continue;
    }

    return {
      name: skillName,
      description: "",
      location: readPath,
      state,
      normalizedLocation: normalizedReadPath,
      normalizedBaseDir: normalizePathForComparison(dirname(readPath), cwd),
    };
  }

  return null;
}

function createSensitiveLogMetadata(value: string | undefined): SensitiveLogMetadata | null {
  if (value === undefined) {
    return null;
  }

  return {
    present: true,
    length: value.length,
    sha256: createHash("sha256").update(value).digest("hex"),
  };
}

function clonePermissionPromptDecision(decision: PermissionPromptDecision): PermissionPromptDecision {
  return decision.denialReason === undefined
    ? {
      approved: decision.approved,
      state: decision.state,
    }
    : {
      approved: decision.approved,
      state: decision.state,
      denialReason: decision.denialReason,
    };
}

function createDuplicatePermissionPromptDecision(decision: PermissionPromptDecision): PermissionPromptDecision {
  return decision.approved
    ? { approved: true, state: "approved" }
    : clonePermissionPromptDecision(decision);
}

function pickPermissionPromptToolFields(details: PermissionPromptDetails): Record<string, unknown> {
  return {
    toolCallId: details.toolCallId ?? null,
    toolName: details.toolName ?? null,
    skillName: details.skillName ?? null,
    path: details.path ?? null,
    command: details.command ?? null,
  };
}

function buildToolCallBlockedEntryFields(
  toolCallId: string | undefined,
  toolName: string,
  agentName: string | null,
): Record<string, unknown> {
  return {
    source: "tool_call",
    toolCallId,
    toolName,
    agentName,
  };
}

function createPermissionPromptFingerprint(details: PermissionPromptDetails): string {
  return safeJsonStringify({
    source: details.source,
    agentName: details.agentName,
    message: details.message,
    ...pickPermissionPromptToolFields(details),
    target: details.target ?? null,
    toolInput: details.toolInput ?? null,
  }) ?? "";
}

function createPermissionPromptCacheKey(details: PermissionPromptDetails): string | null {
  const requestId = details.requestId.trim();
  if (!requestId) {
    return null;
  }

  const fingerprint = createPermissionPromptFingerprint(details);
  const fingerprintHash = createHash("sha256").update(fingerprint).digest("hex");
  return `${requestId}\u0000${fingerprintHash}`;
}

function prunePermissionPromptDecisionCache(
  cache: Map<string, CachedPermissionPromptDecision>,
  now = Date.now(),
): void {
  for (const [key, entry] of cache.entries()) {
    if (now - entry.cachedAt > DUPLICATE_PERMISSION_PROMPT_CACHE_TTL_MS) {
      cache.delete(key);
    }
  }

  while (cache.size > DUPLICATE_PERMISSION_PROMPT_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey !== "string") {
      return;
    }
    cache.delete(oldestKey);
  }
}

function getCachedPermissionPromptDecision(
  cache: Map<string, CachedPermissionPromptDecision>,
  cacheKey: string,
  now = Date.now(),
): Promise<PermissionPromptDecision> | null {
  const entry = cache.get(cacheKey);
  if (!entry) {
    return null;
  }

  if (now - entry.cachedAt > DUPLICATE_PERMISSION_PROMPT_CACHE_TTL_MS) {
    cache.delete(cacheKey);
    return null;
  }

  return entry.decisionPromise.then(clonePermissionPromptDecision);
}

function rememberPermissionPromptDecision(
  cache: Map<string, CachedPermissionPromptDecision>,
  cacheKey: string,
  decisionPromise: Promise<PermissionPromptDecision>,
): void {
  cache.delete(cacheKey);
  cache.set(cacheKey, {
    cachedAt: Date.now(),
    decisionPromise,
  });
  prunePermissionPromptDecisionCache(cache);
}

function forgetPermissionPromptDecision(
  cache: Map<string, CachedPermissionPromptDecision>,
  cacheKey: string,
  decisionPromise: Promise<PermissionPromptDecision>,
): void {
  const entry = cache.get(cacheKey);
  if (entry?.decisionPromise === decisionPromise) {
    cache.delete(cacheKey);
  }
}

function getPermissionLogContext(
  result: PermissionCheckResult,
  input: unknown,
): {
  command?: string;
  commandMetadata: SensitiveLogMetadata | null;
  target?: string;
  toolInput: unknown;
} {
  return {
    command: result.toolName === "bash" && result.command ? result.command : undefined,
    commandMetadata: createSensitiveLogMetadata(result.command),
    target: result.target,
    toolInput: input,
  };
}

function getPatternApprovalSubject(result: PermissionCheckResult, input: unknown): string {
  if (result.toolName === "bash" && result.command) {
    return result.command;
  }

  if ((result.source === "mcp" || result.toolName === "mcp") && result.target) {
    return result.target;
  }

  const path = getPathBearingToolPath(result.toolName, input);
  if (path) {
    const cwd = getNonEmptyString(toRecord(input).cwd) ?? process.cwd();
    return normalizePathResourceForPermission(path, cwd) || path;
  }

  if (result.target) {
    return result.target.startsWith(`${result.toolName}:`)
      ? result.target.slice(result.toolName.length + 1)
      : result.target;
  }

  return result.command || result.toolName;
}

function createConfigEvaluationRule(result: PermissionCheckResult): PatternPermissionRule {
  const canReuseMatchedPattern = result.source === "bash" || result.source === "mcp" || result.source === "skill" || result.source === "special";
  return {
    tool: result.toolName,
    pattern: canReuseMatchedPattern && result.matchedPattern ? result.matchedPattern : "*",
    action: result.state,
  };
}

export function applyPatternApprovalState(
  result: PermissionCheckResult,
  input: unknown,
  sessionApprovals: SessionApprovalStore,
): PermissionCheckResult {
  if (result.state === "deny") {
    return result;
  }

  const subject = getPatternApprovalSubject(result, input);
  const configRule = createConfigEvaluationRule(result);
  const evaluated = evaluatePermission(
    result.toolName,
    subject,
    [configRule],
    sessionApprovals.getRules(),
  );

  // The config rule falls back to a synthetic "*" pattern when the result
  // carries no matched pattern (default-state results, opaque bash
  // segments). That synthetic pattern must not leak into prompts as if it
  // were a real config rule.
  const matchedPattern = result.matchedPattern
    ?? (configRule.pattern === "*" && evaluated.matchedPattern === "*"
      ? undefined
      : evaluated.matchedPattern);

  return {
    ...result,
    state: evaluated.action,
    matchedPattern,
  };
}

function getPermissionDecisionScope(details: {
  target?: string;
  command?: string;
  path?: string;
  toolName?: string;
  skillName?: string;
}): string | undefined {
  return getNonEmptyString(details.target)
    ?? getNonEmptyString(details.command)
    ?? getNonEmptyString(details.path)
    ?? details.toolName
    ?? details.skillName;
}

function persistSessionApprovalDecision(
  decision: PermissionPromptDecision,
  result: PermissionCheckResult,
  input: unknown,
  sessionApprovals: SessionApprovalStore,
): { subject: string; persistence: "session" } | null {
  if (!decision.approved || decision.state !== "always") {
    return null;
  }

  const subject = getPatternApprovalSubject(result, input);
  if (!subject) {
    return null;
  }

  sessionApprovals.approveAlways(result.toolName, subject);
  return { subject, persistence: "session" };
}

function waitForForwardedPermissionResponseFile(responsePath: string, deadline: number): Promise<void> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    return Promise.resolve();
  }

  const timeoutMs = Math.min(PERMISSION_FORWARDING_POLL_INTERVAL_MS, remainingMs);
  const responseDir = dirname(responsePath);
  const responseFileName = basename(responsePath);

  return new Promise((resolve) => {
    let watcher: FSWatcher | null = null;
    let timer: NodeJS.Timeout | null = null;
    let finished = false;
    const finish = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (watcher) {
        try {
          watcher.close();
        } catch (error) {
          // Watcher cleanup is best-effort; the polling fallback covers missed events.
          writeDebugEntry("permission_forwarding.watcher_close_error", {
            responseDir,
            error: formatUnknownErrorMessage(error),
          });
        }
      }
      resolve();
    };
    timer = setTimeout(finish, timeoutMs);

    try {
      watcher = watch(responseDir, { persistent: false }, (_eventType: unknown, fileName: unknown) => {
        if (!fileName || String(fileName) === responseFileName) {
          finish();
        }
      });
      watcher.on("error", finish);
    } catch (error) {
      // Directory watches are best-effort across filesystems; the timeout preserves safe fallback polling.
      writeDebugEntry("permission_forwarding.watch_setup_error", {
        responseDir,
        error: formatUnknownErrorMessage(error),
      });
    }
  });
}

function normalizeFilesystemPath(pathValue: string): string {
  const normalizedPath = normalize(pathValue);
  return process.platform === "win32" ? normalizedPath.toLowerCase() : normalizedPath;
}

function resolvePathWithinDirectory(directory: string, fileName: string): string | null {
  const resolvedDirectory = resolve(directory);
  const resolvedPath = resolve(directory, fileName);
  const comparableDirectory = normalizeFilesystemPath(resolvedDirectory);
  const comparablePath = normalizeFilesystemPath(resolvedPath);
  return isPathWithinDirectory(comparablePath, comparableDirectory) ? resolvedPath : null;
}

function getSessionId(ctx: ExtensionContext): string {
  try {
    const sessionId = ctx.sessionManager.getSessionId();
    if (typeof sessionId === "string" && sessionId.trim()) {
      return sessionId.trim();
    }
  } catch (error) {
    writeDebugEntry("permission_request.session_id_error", {
      error: formatUnknownErrorMessage(error),
    });
  }

  return "unknown";
}

function isSubagentExecutionContext(ctx: ExtensionContext): boolean {
  if (hasSubagentEnvHint()) {
    return true;
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
  return isNodeErrorWithCode(error, code);
}

function logPermissionForwardingEntry(event: "warning" | "error", message: string, error?: unknown): void {
  const details = typeof error === "undefined"
    ? { message }
    : { message, error: formatUnknownErrorMessage(error) };

  writeReviewEntry(`permission_forwarding.${event}`, details);
}

function logPermissionForwardingWarning(message: string, error?: unknown): void {
  logPermissionForwardingEntry("warning", message, error);
}

function logPermissionForwardingError(message: string, error?: unknown): void {
  logPermissionForwardingEntry("error", message, error);
}

function setRestrictiveFileSystemMode(path: string, mode: number, description: string): void {
  try {
    chmodSync(path, mode);
  } catch (error) {
    logPermissionForwardingWarning(`Failed to restrict ${description} permissions for '${path}'`, error);
  }
}

function ensureDirectoryExists(path: string, description: string): boolean {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    setRestrictiveFileSystemMode(path, 0o700, description);
    return true;
  } catch (error) {
    logPermissionForwardingError(`Failed to create ${description} directory '${path}'`, error);
    return false;
  }
}

function getPermissionForwardingRootDir(ctx: ExtensionContext): string {
  return resolvePermissionForwardingRootDir({
    defaultAgentDir: PI_AGENT_DIR,
    isSubagent: isSubagentExecutionContext(ctx),
    env: process.env,
  });
}

function getPermissionForwardingLocationForSession(
  sessionId: string,
  ctx: ExtensionContext,
): PermissionForwardingLocation {
  return createPermissionForwardingLocation(getPermissionForwardingRootDir(ctx), sessionId);
}

function resolveForwardingLocation(
  sessionId: string,
  ctx: ExtensionContext,
  onError?: (error: unknown) => void,
): PermissionForwardingLocation | null {
  try {
    return getPermissionForwardingLocationForSession(sessionId, ctx);
  } catch (error) {
    onError?.(error);
    return null;
  }
}

function ensurePermissionForwardingLocation(
  sessionId: string,
  ctx: ExtensionContext,
): PermissionForwardingLocation | null {
  const location = resolveForwardingLocation(sessionId, ctx, (error) =>
    logPermissionForwardingError("Failed to resolve permission forwarding location", error),
  );
  if (!location) {
    return null;
  }

  const sessionRootReady = ensureDirectoryExists(location.sessionRootDir, "permission forwarding session root");
  const requestsReady = ensureDirectoryExists(location.requestsDir, "permission forwarding requests");
  const responsesReady = ensureDirectoryExists(location.responsesDir, "permission forwarding responses");

  return sessionRootReady && requestsReady && responsesReady ? location : null;
}

function getExistingPermissionForwardingLocation(
  sessionId: string,
  ctx: ExtensionContext,
): PermissionForwardingLocation | null {
  const location = resolveForwardingLocation(sessionId, ctx);
  if (!location) {
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

function createPermissionForwardingNonce(): string {
  return randomBytes(32).toString("base64url");
}

function safeEqualString(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isForwardedPermissionResponseBoundToRequest(
  response: ForwardedPermissionResponse | null,
  request: Pick<ForwardedPermissionRequest, "id" | "responseNonce">,
  responsePath: string,
  targetSessionId: string,
  responderSessionId?: string,
): response is ForwardedPermissionResponse {
  if (!response) {
    return false;
  }
  if (response.requestId !== request.id || !safeEqualString(response.responseNonce, request.responseNonce)) {
    logPermissionForwardingWarning(`Ignoring forwarded permission response '${responsePath}' because it is not bound to request '${request.id}'`);
    return false;
  }
  if (response.responderSessionId !== (responderSessionId ?? targetSessionId)) {
    logPermissionForwardingWarning(`Ignoring forwarded permission response '${responsePath}' because responder session '${response.responderSessionId}' does not match target session '${targetSessionId}'`);
    return false;
  }
  return true;
}

function writeJsonFileAtomic(filePath: string, value: unknown): void {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

  try {
    writeFileSync(tempPath, JSON.stringify(value), { encoding: "utf-8", flag: "wx", mode: 0o600 });
    setRestrictiveFileSystemMode(tempPath, 0o600, "temporary permission-forwarding file");
    renameSync(tempPath, filePath);
    setRestrictiveFileSystemMode(filePath, 0o600, "permission-forwarding file");
  } catch (error) {
    safeDeleteFile(tempPath, "temporary permission-forwarding");
    throw error;
  }
}

async function readForwardedPermissionRequest(filePath: string): Promise<ForwardedPermissionRequest | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ForwardedPermissionRequest>;
    if (
      !parsed
      || typeof parsed.id !== "string"
      || typeof parsed.responseNonce !== "string"
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
      responseNonce: parsed.responseNonce,
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

async function readForwardedPermissionResponse(filePath: string): Promise<ForwardedPermissionResponse | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ForwardedPermissionResponse>;
    if (
      !parsed
      || typeof parsed.requestId !== "string"
      || typeof parsed.responseNonce !== "string"
      || typeof parsed.approved !== "boolean"
      || !isPermissionDecisionState(parsed.state)
      || typeof parsed.responderSessionId !== "string"
    ) {
      logPermissionForwardingWarning(`Ignoring invalid forwarded permission response format in '${filePath}'`);
      return null;
    }

    return {
      requestId: parsed.requestId,
      responseNonce: parsed.responseNonce,
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

  const location = ensurePermissionForwardingLocation(targetSessionId, ctx);
  if (!location) {
    logPermissionForwardingError(
      `Permission forwarding is unavailable because session-scoped directories could not be prepared for '${targetSessionId}'`,
    );
    return { approved: false, state: "denied" };
  }

  const requestId = randomUUID();
  const responseNonce = createPermissionForwardingNonce();
  const requesterAgentName = getActiveAgentName(ctx) || getActiveAgentNameFromSystemPrompt(getContextSystemPrompt(ctx)) || "unknown";
  const request: ForwardedPermissionRequest = {
    id: requestId,
    responseNonce,
    createdAt: Date.now(),
    requesterSessionId,
    targetSessionId,
    requesterAgentName,
    message,
  };

  const requestPath = join(location.requestsDir, `${requestId}.json`);
  const responsePath = join(location.responsesDir, `${requestId}.json`);

  writeReviewEntry("forwarded_permission.request_created", {
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
      const response = await readForwardedPermissionResponse(responsePath);
      const boundResponse = isForwardedPermissionResponseBoundToRequest(
        response,
        request,
        responsePath,
        targetSessionId,
      ) ? response : null;
      writeReviewEntry("forwarded_permission.response_received", {
        requestId,
        approved: boundResponse?.approved ?? null,
        state: boundResponse?.state ?? null,
        denialReasonMetadata: createSensitiveLogMetadata(boundResponse?.denialReason),
        responderSessionId: boundResponse?.responderSessionId ?? null,
        targetSessionId,
        responsePath,
      });
      safeDeleteFile(responsePath, "forwarded permission response");
      if (!boundResponse) {
        continue;
      }
      safeDeleteFile(requestPath, "forwarded permission request");
      cleanupPermissionForwardingLocationIfEmpty(location);
      return boundResponse;
    }

    await waitForForwardedPermissionResponseFile(responsePath, deadline);
  }

  logPermissionForwardingWarning(`Timed out waiting for forwarded permission response '${responsePath}'`);
  writeReviewEntry("forwarded_permission.response_timed_out", {
    requestId,
    requesterAgentName,
    targetSessionId,
    responsePath,
  });
  safeDeleteFile(requestPath, "forwarded permission request");
  cleanupPermissionForwardingLocationIfEmpty(location);
  return { approved: false, state: "denied" };
}

function createForwardedPermissionLogDetails(
  request: ForwardedPermissionRequest,
  location: PermissionForwardingLocation,
): {
  requestId: string;
  source: "primary";
  requesterAgentName: string | null;
  requesterSessionId: string | null;
  targetSessionId: string | null;
} {
  return {
    requestId: request.id,
    source: location.label,
    requesterAgentName: request.requesterAgentName,
    requesterSessionId: request.requesterSessionId,
    targetSessionId: request.targetSessionId,
  };
}

export async function processForwardedPermissionRequests(
  ctx: ExtensionContext,
  options: { preserveLocation?: boolean } = {},
): Promise<void> {
  if (!ctx.hasUI) {
    return;
  }

  const currentSessionId = getSessionId(ctx);
  const location = getExistingPermissionForwardingLocation(currentSessionId, ctx);
  if (!location) {
    return;
  }

  let requestFiles: string[] = [];
  try {
    requestFiles = readdirSync(location.requestsDir)
      .filter((name: string) => name.endsWith(".json"))
      .sort();
  } catch (error) {
    logPermissionForwardingWarning(`Failed to read ${location.label} permission forwarding requests from '${location.requestsDir}'`, error);
    return;
  }

  const pendingRequests = await Promise.all(
    requestFiles.map(async (fileName) => {
      const requestPath = join(location.requestsDir, fileName);
      return {
        requestPath,
        request: await readForwardedPermissionRequest(requestPath),
      };
    }),
  );

  for (const { requestPath, request } of pendingRequests) {
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

    const responsePath = resolvePathWithinDirectory(location.responsesDir, `${request.id}.json`);
    if (!responsePath) {
      logPermissionForwardingWarning(`Ignoring forwarded permission request '${request.id}' because its response path would escape '${location.responsesDir}'`);
      safeDeleteFile(requestPath, `${location.label} forwarded permission request`);
      continue;
    }

    const forwardedPermissionLogDetails = {
      ...createForwardedPermissionLogDetails(request, location),
      requestPath,
    };

    const requestAgeMs = Date.now() - request.createdAt;
    let decision: PermissionPromptDecision = { approved: false, state: "denied" };
    if (requestAgeMs >= PERMISSION_FORWARDING_TIMEOUT_MS) {
      writeReviewEntry("forwarded_permission.expired", {
        ...forwardedPermissionLogDetails,
        requestAgeMs,
        timeoutMs: PERMISSION_FORWARDING_TIMEOUT_MS,
      });
      decision = {
        approved: false,
        state: "denied",
        denialReason: "permission_timeout: forwarded permission request expired before it could be displayed.",
      };
    } else if (shouldAutoApprovePermissionState("ask", extensionConfig)) {
      writeReviewEntry("forwarded_permission.auto_approved", forwardedPermissionLogDetails);
      decision = { approved: true, state: "approved" };
    } else {
      writeReviewEntry("forwarded_permission.prompted", forwardedPermissionLogDetails);
      if (extensionConfig.debug) {
        try {
          ctx.ui.notify(
            `Subagent '${request.requesterAgentName || "unknown"}' is waiting for permission approval.`,
            "warning",
          );
        } catch (error) {
          logPermissionForwardingWarning("Failed to show forwarded permission notification", error);
        }
      }
      try {
        const forwardedPromptTimeoutSeconds = extensionConfig.forwardedPromptTimeoutSeconds;
        const timeoutMs = forwardedPromptTimeoutSeconds !== null && forwardedPromptTimeoutSeconds > 0
          ? forwardedPromptTimeoutSeconds * 1000
          : undefined;
        const timeoutDenialReason = timeoutMs !== undefined
          ? `permission_timeout: forwarded permission prompt was not answered within ${forwardedPromptTimeoutSeconds} seconds.`
          : undefined;
        const promptMessage = timeoutMs !== undefined
          ? `This forwarded prompt auto-denies after ${forwardedPromptTimeoutSeconds} seconds if unanswered.`
          : "This forwarded prompt will wait indefinitely until answered.";

        decision = await requestPermissionDecisionFromUi(
          ctx.ui,
          "Permission Required (Subagent)",
          [
            formatForwardedPermissionPrompt(request),
            "",
            promptMessage,
          ].join("\n"),
          timeoutMs !== undefined
            ? { timeoutMs, timeoutDenialReason: timeoutDenialReason ?? DEFAULT_FORWARDED_PERMISSION_PROMPT_TIMEOUT_REASON }
            : {},
        );
      } catch (error) {
        logPermissionForwardingError("Failed to show forwarded permission confirmation dialog", error);
        decision = { approved: false, state: "denied" };
      }
    }

    writeReviewEntry(decision.approved ? "forwarded_permission.approved" : "forwarded_permission.denied", {
      ...createForwardedPermissionLogDetails(request, location),
      responsePath,
      resolution: decision.state,
      denialReasonMetadata: createSensitiveLogMetadata(decision.denialReason),
    });
    try {
      writeJsonFileAtomic(responsePath, {
        requestId: request.id,
        responseNonce: request.responseNonce,
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

  if (!options.preserveLocation) {
    cleanupPermissionForwardingLocationIfEmpty(location);
  }
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

function createPermissionManagerForCwd(
  cwd: string | undefined | null,
  onWarning?: (message: string) => void,
): PermissionManager {
  const projectPaths = derivePiProjectPaths(cwd);
  if (!projectPaths) {
    return new PermissionManager({ onWarning });
  }

  return new PermissionManager({
    projectGlobalConfigPath: projectPaths.projectGlobalConfigPath,
    projectAgentsDir: projectPaths.projectAgentsDir,
    onWarning,
  });
}

type CachedPromptStateResult = {
  systemPrompt?: string;
  entries: SkillPromptEntry[];
};

export default function piPermissionSystemExtension(pi: ExtensionAPI): void {
  let activeSkillEntries: SkillPromptEntry[] = [];
  const explicitlyRequestedSkillNames = new Set<string>();
  let lastKnownActiveAgentName: string | null = null;
  let lastActiveToolsCacheKey: string | null = null;
  let lastPromptStateCacheKey: string | null = null;
  let lastPromptStateCacheResult: CachedPromptStateResult | null = null;
  let permissionForwardingContext: ExtensionContext | null = null;
  let permissionForwardingWatcher: FSWatcher | null = null;
  let permissionForwardingFallbackTimer: NodeJS.Timeout | null = null;
  let permissionForwardingScanTimer: NodeJS.Timeout | null = null;
  let watchedPermissionForwardingRequestsDir: string | null = null;
  let isProcessingForwardedRequests = false;
  let pendingForwardedRequestScan = false;
  let runtimeContext: ExtensionContext | null = null;
  let lastConfigWarning: string | null = null;
  const shownWarnings = new Set<string>();

  const invalidateAgentStartCache = (): void => {
    activeSkillEntries = [];
    lastActiveToolsCacheKey = null;
    lastPromptStateCacheKey = null;
    lastPromptStateCacheResult = null;
  };

  const resetShownWarnings = (): void => {
    shownWarnings.clear();
  };

  const notifyWarning = (message: string): void => {
    if (!runtimeContext?.hasUI || shownWarnings.has(message)) {
      return;
    }

    shownWarnings.add(message);
    runtimeContext.ui.notify(message, "warning");
  };

  let permissionManager = createPermissionManagerForCwd(undefined, notifyWarning);
  const sessionApprovals = new SessionApprovalStore();
  const recentPermissionPromptDecisions = new Map<string, CachedPermissionPromptDecision>();

  const loadExtensionConfigState = (): PermissionSystemConfigLoadResult => {
    const result = loadPermissionSystemConfig();
    setExtensionConfig(result.config);
    return result;
  };

  const applyExtensionConfigSideEffects = (
    result: PermissionSystemConfigLoadResult,
    ctx?: ExtensionContext,
  ): void => {
    if (ctx) {
      runtimeContext = ctx;
    }

    if (runtimeContext?.hasUI) {
      syncPermissionSystemStatus(runtimeContext, result.config);
    }

    if (result.warning && result.warning !== lastConfigWarning) {
      lastConfigWarning = result.warning;
      notifyWarning(result.warning);
    } else if (!result.warning) {
      lastConfigWarning = null;
    }

    writeDebugEntry("config.loaded", {
      created: result.created,
      warning: result.warning ?? null,
      debug: result.config.debug,
      yoloMode: result.config.yoloMode,
    });
  };

  const refreshExtensionConfig = (ctx?: ExtensionContext): void => {
    const result = loadExtensionConfigState();
    applyExtensionConfigSideEffects(result, ctx);
  };

  const syncPermissionSystemStatusWhenPossible = (
    config: PermissionSystemExtensionConfig,
    ctx?: ExtensionCommandContext | ExtensionContext,
  ): void => {
    if (ctx) {
      syncPermissionSystemStatus(ctx, config);
      return;
    }

    if (runtimeContext?.hasUI) {
      syncPermissionSystemStatus(runtimeContext, config);
    }
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
    syncPermissionSystemStatusWhenPossible(normalized, ctx);
    lastConfigWarning = null;

    writeDebugEntry("config.saved", {
      debug: normalized.debug,
      yoloMode: normalized.yoloMode,
    });
  };

  const setYoloModeFromRuntimeApi = (enabled: boolean, options: YoloModeControlOptions = {}): YoloModeControlResult => {
    if (typeof enabled !== "boolean") {
      return {
        yoloMode: extensionConfig.yoloMode,
        changed: false,
        persisted: false,
        error: "setYoloMode(enabled) requires a boolean value.",
      };
    }

    const normalized = normalizePermissionSystemConfig({ ...extensionConfig, yoloMode: enabled });
    const persisted = options.persist !== false;
    const changed = extensionConfig.yoloMode !== normalized.yoloMode;

    if (persisted) {
      const saved = savePermissionSystemConfig(normalized);
      if (!saved.success) {
        const error = saved.error ?? "Failed to persist pi-permission-system config.";
        writeDebugEntry("yolo_mode.update_failed", {
          error,
          requestedYoloMode: normalized.yoloMode,
          source: getNonEmptyString(options.source) ?? "runtime-api",
        });
        return {
          yoloMode: extensionConfig.yoloMode,
          changed: false,
          persisted: false,
          error,
        };
      }
      lastConfigWarning = null;
    }

    setExtensionConfig(normalized);
    syncPermissionSystemStatusWhenPossible(normalized);
    writeDebugEntry("yolo_mode.updated", {
      changed,
      persisted,
      source: getNonEmptyString(options.source) ?? "runtime-api",
      yoloMode: normalized.yoloMode,
    });

    return {
      yoloMode: normalized.yoloMode,
      changed,
      persisted,
    };
  };

  setLoggingWarningReporter(notifyWarning);

  const initialConfigResult = loadExtensionConfigState();

  if (!extensionConfig.enabled) {
    return;
  }

  applyExtensionConfigSideEffects(initialConfigResult);

  runtimeApi = registerPiPermissionSystemRuntimeApi({
    getYoloMode: () => extensionConfig.yoloMode,
    setYoloMode: setYoloModeFromRuntimeApi,
    toggleYoloMode: (options?: YoloModeControlOptions) => setYoloModeFromRuntimeApi(!extensionConfig.yoloMode, options),
  });

  let modelOptionCompatibilityRegistration: Promise<void> | null = null;
  const ensureModelOptionCompatibilityRegistered = (): Promise<void> => {
    if (!modelOptionCompatibilityRegistration) {
      modelOptionCompatibilityRegistration = import("./model-option-compatibility.js")
        .then(({ registerModelOptionCompatibilityGuard }: { registerModelOptionCompatibilityGuard: (pi: ExtensionAPI) => void }) => {
          registerModelOptionCompatibilityGuard(pi);
        })
        .catch(() => {
          // ignore
        });
    }

    return modelOptionCompatibilityRegistration;
  };

  pi.registerCommand("permission-system", {
    description: PERMISSION_SYSTEM_COMMAND_DESCRIPTION,
    handler: createPermissionSystemCommandHandler(async (ctx) => {
      const { openPermissionSystemSettingsModal } = await import("./config-modal.js");
      await openPermissionSystemSettingsModal(ctx, {
        getConfig: () => extensionConfig,
        setConfig: saveExtensionConfig,
        getConfigPath: getPermissionSystemConfigPath,
      });
    }),
  });

  const createPermissionRequestId = (prefix: string): string => {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${process.pid}`;
  };

  const emitPermissionRequestEvent = (event: PermissionRequestEvent): void => {
    try {
      pi.events.emit(PERMISSION_REQUEST_EVENT_CHANNEL, event);
    } catch (error) {
      writeDebugEntry("permission_request.event_emit_failed", {
        requestId: event.requestId,
        source: event.source,
        state: event.state,
        error: formatUnknownErrorMessage(error),
      });
    }
  };

  const emitPermissionStateEvent = (
    details: PermissionPromptDetails,
    state: PermissionRequestState,
  ): void => {
    emitPermissionRequestEvent({
      requestId: details.requestId,
      source: details.source,
      state,
      message: details.message,
      toolCallId: details.toolCallId,
      toolName: details.toolName,
      skillName: details.skillName,
      path: details.path,
      command: details.command,
      target: details.target,
      toolInput: details.toolInput,
      agentName: details.agentName,
    });
  };

  const reviewPermissionDecision = (
    event: string,
    details: PermissionPromptDetails,
  ): void => {
    writeReviewEntry(event, {
      requestId: details.requestId,
      source: details.source,
      agentName: details.agentName,
      prompt: details.message,
      promptMetadata: createSensitiveLogMetadata(details.message),
      ...pickPermissionPromptToolFields(details),
      commandMetadata: details.commandMetadata ?? null,
      target: details.target ?? null,
      toolInput: details.toolInput ?? null,
      resolution: details.resolution ?? null,
      denialReason: details.denialReason ?? null,
      denialReasonMetadata: createSensitiveLogMetadata(details.denialReason),
      decisionPersistence: details.decisionPersistence ?? null,
      approvalPersistence: details.approvalPersistence ?? null,
      decisionScope: details.decisionScope ?? null,
      approvalScope: details.approvalScope ?? null,
    });
  };

  const promptPermission = async (
    ctx: ExtensionContext,
    details: PermissionPromptDetails,
  ): Promise<PermissionPromptDecision> => {
    prunePermissionPromptDecisionCache(recentPermissionPromptDecisions);
    const cacheKey = createPermissionPromptCacheKey(details);
    const cachedDecision = cacheKey
      ? getCachedPermissionPromptDecision(recentPermissionPromptDecisions, cacheKey)
      : null;
    if (cachedDecision) {
      const decision = createDuplicatePermissionPromptDecision(await cachedDecision);
      reviewPermissionDecision("permission_request.duplicate_reused", {
        ...details,
        resolution: decision.state,
        denialReason: decision.denialReason,
        decisionPersistence: "none",
        approvalPersistence: "none",
        decisionScope: getPermissionDecisionScope(details),
      });
      await extensionLogger.flush();
      return decision;
    }

    const decisionPromise = (async (): Promise<PermissionPromptDecision> => {
      if (shouldAutoApprovePermissionState("ask", extensionConfig)) {
        reviewPermissionDecision("permission_request.auto_approved", {
          ...details,
          resolution: "auto_response",
          decisionPersistence: "none",
          decisionScope: "yolo_mode",
        });
        emitPermissionStateEvent(details, "approved");
        await extensionLogger.flush();
        return { approved: true, state: "approved" };
      }

      reviewPermissionDecision("permission_request.waiting", details);
      emitPermissionStateEvent(details, "waiting");

      const decision = await confirmPermission(ctx, details.message);
      reviewPermissionDecision(decision.approved ? "permission_request.approved" : "permission_request.denied", {
        ...details,
        resolution: decision.state,
        denialReason: decision.denialReason,
        decisionPersistence: decision.state === "always" ? "session" : "none",
        approvalPersistence: decision.approved && decision.state === "always" ? "session" : "none",
        decisionScope: getPermissionDecisionScope(details),
        approvalScope: decision.approved && decision.state === "always"
          ? getPermissionDecisionScope(details)
          : undefined,
      });
      emitPermissionStateEvent(details, decision.approved ? "approved" : "denied");

      await extensionLogger.flush();
      return decision;
    })();

    if (cacheKey) {
      rememberPermissionPromptDecision(recentPermissionPromptDecisions, cacheKey, decisionPromise);
    }

    try {
      return clonePermissionPromptDecision(await decisionPromise);
    } catch (error) {
      if (cacheKey) {
        forgetPermissionPromptDecision(recentPermissionPromptDecisions, cacheKey, decisionPromise);
      }
      throw error;
    }
  };

  const closePermissionForwardingWatcher = (): void => {
    if (permissionForwardingWatcher) {
      try {
        permissionForwardingWatcher.close();
      } catch (error) {
        logPermissionForwardingWarning("Failed to close permission forwarding watcher", error);
      }
      permissionForwardingWatcher = null;
    }
    watchedPermissionForwardingRequestsDir = null;
  };

  const stopPermissionForwardingFallbackTimer = (): void => {
    if (permissionForwardingFallbackTimer) {
      clearInterval(permissionForwardingFallbackTimer);
      permissionForwardingFallbackTimer = null;
    }
  };

  const runForwardedPermissionRequestScan = (): void => {
    const currentContext = permissionForwardingContext;
    if (!currentContext) {
      return;
    }

    if (isProcessingForwardedRequests) {
      pendingForwardedRequestScan = true;
      return;
    }

    isProcessingForwardedRequests = true;
    void processForwardedPermissionRequests(currentContext, { preserveLocation: true })
      .finally(() => {
        isProcessingForwardedRequests = false;
        if (pendingForwardedRequestScan) {
          pendingForwardedRequestScan = false;
          runForwardedPermissionRequestScan();
        }
      });
  };

  const queueForwardedPermissionRequestScan = (): void => {
    if (!permissionForwardingContext || permissionForwardingScanTimer) {
      return;
    }

    permissionForwardingScanTimer = setTimeout(() => {
      permissionForwardingScanTimer = null;
      runForwardedPermissionRequestScan();
    }, PERMISSION_FORWARDING_WATCH_DEBOUNCE_MS);
  };

  const startPermissionForwardingFallbackTimer = (): void => {
    if (permissionForwardingFallbackTimer) {
      return;
    }

    // Keep a low-frequency sweep active even when fs.watch is available. Some
    // Windows directory watchers miss later atomic renames after the first
    // forwarded request, leaving valid subagent requests unprompted forever.
    permissionForwardingFallbackTimer = setInterval(
      queueForwardedPermissionRequestScan,
      PERMISSION_FORWARDING_POLL_INTERVAL_MS,
    );
  };

  const stopForwardedPermissionPolling = (): void => {
    closePermissionForwardingWatcher();
    stopPermissionForwardingFallbackTimer();
    if (permissionForwardingScanTimer) {
      clearTimeout(permissionForwardingScanTimer);
      permissionForwardingScanTimer = null;
    }

    permissionForwardingContext = null;
    isProcessingForwardedRequests = false;
    pendingForwardedRequestScan = false;
  };

  const startForwardedPermissionPolling = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI || isSubagentExecutionContext(ctx)) {
      stopForwardedPermissionPolling();
      return;
    }

    const sessionId = getSessionId(ctx);
    const location = ensurePermissionForwardingLocation(sessionId, ctx);
    if (!location) {
      return;
    }

    permissionForwardingContext = ctx;
    if (permissionForwardingWatcher && watchedPermissionForwardingRequestsDir === location.requestsDir) {
      startPermissionForwardingFallbackTimer();
      queueForwardedPermissionRequestScan();
      return;
    }

    closePermissionForwardingWatcher();
    stopPermissionForwardingFallbackTimer();

    try {
      permissionForwardingWatcher = watch(location.requestsDir, { persistent: false }, (_eventType: unknown, fileName: unknown) => {
        const normalizedFileName = fileName ? String(fileName) : "";
        if (!normalizedFileName || normalizedFileName.endsWith(".json") || normalizedFileName.endsWith(".tmp")) {
          queueForwardedPermissionRequestScan();
        }
      });
      permissionForwardingWatcher.on("error", (error: unknown) => {
        logPermissionForwardingWarning(
          `Permission forwarding watcher failed for '${location.requestsDir}'; using reduced-frequency polling fallback`,
          error,
        );
        closePermissionForwardingWatcher();
        startPermissionForwardingFallbackTimer();
      });
      watchedPermissionForwardingRequestsDir = location.requestsDir;
    } catch (error) {
      logPermissionForwardingWarning(
        `Unable to watch permission forwarding requests at '${location.requestsDir}'; using reduced-frequency polling fallback`,
        error,
      );
      startPermissionForwardingFallbackTimer();
    }

    startPermissionForwardingFallbackTimer();
    queueForwardedPermissionRequestScan();
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
    const toolPermission = applyPatternApprovalState(
      {
        toolName,
        state: permissionManager.getToolPermission(toolName, agentName ?? undefined),
        source: "tool",
      },
      {},
      sessionApprovals,
    ).state;
    if (toolPermission !== "deny") {
      return true;
    }

    // If the read tool is denied but the agent has explicitly allowed skills,
    // expose read anyway so the agent can read skill files. The tool_call handler
    // will restrict reads to skill paths only.
    if (toolName === "read" && permissionManager.hasAllowedSkills(agentName ?? undefined)) {
      return true;
    }

    return false;
  };

  const refreshSessionRuntimeState = (ctx: ExtensionContext): void => {
    runtimeContext = ctx;
    resetShownWarnings();
    refreshExtensionConfig(ctx);
    permissionManager = createPermissionManagerForCwd(ctx.cwd, notifyWarning);
    invalidateAgentStartCache();
    lastKnownActiveAgentName = getActiveAgentName(ctx);
    startForwardedPermissionPolling(ctx);
  };

  pi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext) => {
    await ensureModelOptionCompatibilityRegistered();
    sessionApprovals.clear();
    recentPermissionPromptDecisions.clear();
    refreshSessionRuntimeState(ctx);
    explicitlyRequestedSkillNames.clear();

    if (event.reason === "reload") {
      writeDebugEntry("lifecycle.reload", {
        triggeredBy: "session_start",
        reason: event.reason,
        cwd: ctx.cwd,
      });
    }
  });

  pi.on("resources_discover", async (event: ResourcesDiscoverEvent, _ctx: ExtensionContext) => {
    if (event.reason === "reload") {
      resetShownWarnings();
      recentPermissionPromptDecisions.clear();
      refreshExtensionConfig(runtimeContext ?? undefined);
      permissionManager = runtimeContext
        ? createPermissionManagerForCwd(runtimeContext.cwd, notifyWarning)
        : createPermissionManagerForCwd(undefined, notifyWarning);
      invalidateAgentStartCache();
      writeDebugEntry("lifecycle.reload", {
        triggeredBy: "resources_discover",
        reason: event.reason,
        cwd: runtimeContext?.cwd ?? null,
      });
    }
  });


  pi.on("session_shutdown", async () => {
    runtimeContext?.ui.setStatus(PERMISSION_SYSTEM_STATUS_KEY, undefined);
    sessionApprovals.clear();
    recentPermissionPromptDecisions.clear();
    resetShownWarnings();
    runtimeContext = null;
    unregisterPiPermissionSystemRuntimeApi(runtimeApi ?? undefined);
    explicitlyRequestedSkillNames.clear();
    runtimeApi = null;
    invalidateAgentStartCache();
    stopForwardedPermissionPolling();
  });

  pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
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

    if (!shouldApplyCachedAgentStartState(lastPromptStateCacheKey, promptStateCacheKey) && lastPromptStateCacheResult) {
      activeSkillEntries = lastPromptStateCacheResult.entries;
      return lastPromptStateCacheResult.systemPrompt === undefined
        ? {}
        : { systemPrompt: lastPromptStateCacheResult.systemPrompt };
    }

    const toolPromptResult = sanitizeAvailableToolsSection(event.systemPrompt, allowedTools);
    const skillPromptResult = resolveSkillPromptEntries(toolPromptResult.prompt, permissionManager, agentName, ctx.cwd);
    activeSkillEntries = skillPromptResult.entries;

    const cachedResult: CachedPromptStateResult = {
      entries: skillPromptResult.entries,
      systemPrompt: skillPromptResult.prompt !== event.systemPrompt ? skillPromptResult.prompt : undefined,
    };
    lastPromptStateCacheKey = promptStateCacheKey;
    lastPromptStateCacheResult = cachedResult;

    if (cachedResult.systemPrompt !== undefined) {
      return { systemPrompt: cachedResult.systemPrompt };
    }

    return {};
  });

  pi.on("input", async (event: InputEvent, ctx: ExtensionContext) => {
    runtimeContext = ctx;
    startForwardedPermissionPolling(ctx);
    const skillName = extractSkillNameFromInput(event.text);
    if (!skillName) {
      return { action: "continue" };
    }

    // A slash command is a direct user action, not an agent-initiated skill use.
    // Let Pi handle the command even when the active agent hides or denies skills
    // in frontmatter, and remember the explicit request for skill file reads that
    // happen while the command-provided skill is active.
    explicitlyRequestedSkillNames.add(skillName);
    return { action: "continue" };
  });

  pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
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

    if (isToolCallEventType("read", event)) {
      const readInputRecord = toRecord(event.input);
      const readPath = getNonEmptyString(readInputRecord.path);
      if (readPath) {
        const normalizedReadPath = normalizePathForComparison(readPath, ctx.cwd);
        const matchedSkill = findSkillPathMatch(normalizedReadPath, activeSkillEntries);
        const inferredSkill = matchedSkill
          ? null
          : inferSkillEntryFromReadPath(readPath, ctx.cwd, "ask");
        const inferredSkillCheck = inferredSkill
          ? permissionManager.checkPermission("skill", { name: inferredSkill.name }, agentName ?? undefined)
          : null;
        const readSkill = matchedSkill ?? (inferredSkill && inferredSkillCheck
          ? { ...inferredSkill, state: inferredSkillCheck.state }
          : null);

        if (readSkill && !explicitlyRequestedSkillNames.has(readSkill.name)) {
          const skillReadBlockedFields = {
            source: "skill_read",
            toolCallId: event.toolCallId,
            toolName,
            skillName: readSkill.name,
            agentName,
            path: readPath,
          };
          if (readSkill.state === "deny") {
            writeReviewEntry("permission_request.blocked", {
              ...skillReadBlockedFields,
              toolInput: event.input,
              resolution: "policy_denied",
            });
            return {
              block: true,
              reason: formatSkillPathDenyReason(readSkill, readPath, agentName ?? undefined),
            };
          }

          if (readSkill.state === "ask") {
            const message = formatSkillPathAskPrompt(readSkill, readPath, agentName ?? undefined);
            if (!canRequestPermissionConfirmation(ctx)) {
              writeReviewEntry("permission_request.blocked", {
                ...skillReadBlockedFields,
                prompt: message,
                promptMetadata: createSensitiveLogMetadata(message),
                toolInput: event.input,
                resolution: "confirmation_unavailable",
              });
              return {
                block: true,
                reason: `Accessing this skill requires approval, but no interactive UI is available.`,
              };
            }

            const decision = await promptPermission(ctx, {
              requestId: event.toolCallId,
              source: "skill_read",
              agentName,
              message,
              toolCallId: event.toolCallId,
              toolName: toolName,
              skillName: readSkill.name,
              path: readPath,
              toolInput: event.input,
            });
            if (!decision.approved) {
              const denialReason = decision.denialReason ? ` Reason: ${decision.denialReason}.` : "";
              return { block: true, reason: `User denied access to this skill.${denialReason}` };
            }
          }
        }

        if (readSkill) {
          return {};
        }
      }
    }

    const rawInput = getEventInput(event);
    const inputRecord = toRecord(rawInput);
    const input = ctx.cwd && (getNonEmptyString(inputRecord.path) || getNonEmptyString(inputRecord.file_path)) && !getNonEmptyString(inputRecord.cwd)
      ? { ...inputRecord, cwd: ctx.cwd }
      : rawInput;
    const externalDirectoryPath = ctx.cwd ? getPathBearingToolPath(toolName, input) : null;

    if (ctx.cwd && externalDirectoryPath && isPathOutsideWorkingDirectory(externalDirectoryPath, ctx.cwd)) {
      const externalPermissionInput = { path: externalDirectoryPath, cwd: ctx.cwd };
      const rawExtCheck = permissionManager.checkPermission(
        "external_directory",
        externalPermissionInput,
        agentName ?? undefined,
      );
      const extCheck = rawExtCheck.state === "ask"
        ? applyPatternApprovalState(rawExtCheck, externalPermissionInput, sessionApprovals)
        : rawExtCheck;

      if (extCheck.state === "deny") {
        writeReviewEntry("permission_request.blocked", {
          source: "tool_call",
          toolCallId: event.toolCallId,
          toolName,
          agentName,
          path: externalDirectoryPath,
          toolInput: input,
          resolution: "policy_denied",
        });
        return {
          block: true,
          reason: formatExternalDirectoryDenyReason(
            toolName,
            externalDirectoryPath,
            ctx.cwd,
            agentName ?? undefined,
          ),
        };
      }

      if (extCheck.state === "ask") {
        const message = formatExternalDirectoryAskPrompt(
          toolName,
          externalDirectoryPath,
          ctx.cwd,
          agentName ?? undefined,
        );
        if (!canRequestPermissionConfirmation(ctx)) {
          writeReviewEntry("permission_request.blocked", {
            ...buildToolCallBlockedEntryFields(event.toolCallId, toolName, agentName),
            path: externalDirectoryPath,
            prompt: message,
            promptMetadata: createSensitiveLogMetadata(message),
            toolInput: input,
            resolution: "confirmation_unavailable",
          });
          return {
            block: true,
            reason: `Accessing '${externalDirectoryPath}' outside the working directory requires approval, but no interactive UI is available.`,
          };
        }

        const extDecision = await promptPermission(ctx, {
          requestId: event.toolCallId,
          source: "tool_call",
          agentName,
          message,
          toolCallId: event.toolCallId,
          toolName,
          path: externalDirectoryPath,
          toolInput: input,
        });

        if (!extDecision.approved) {
          return {
            block: true,
            reason: formatExternalDirectoryUserDeniedReason(
              toolName,
              externalDirectoryPath,
              extDecision.denialReason,
            ),
          };
        }

        const externalApproval = persistSessionApprovalDecision(
          extDecision,
          extCheck,
          externalPermissionInput,
          sessionApprovals,
        );
        if (externalApproval) {
          writeReviewEntry("permission_request.approval_persisted", {
            source: "tool_call",
            toolCallId: event.toolCallId,
            toolName: "external_directory",
            agentName,
            path: externalDirectoryPath,
            toolInput: input,
            resolution: extDecision.state,
            decisionPersistence: externalApproval.persistence,
            approvalPersistence: externalApproval.persistence,
            approvalScope: externalApproval.subject,
          });
          await extensionLogger.flush();
        }
      }
      // state === "allow" → fall through to normal permission check
    }

    const check = applyPatternApprovalState(
      permissionManager.checkPermission(toolName, input, agentName ?? undefined),
      input,
      sessionApprovals,
    );
    const permissionLogContext = getPermissionLogContext(check, input);

    if (check.state === "deny") {
      writeReviewEntry("permission_request.blocked", {
        source: "tool_call",
        toolCallId: event.toolCallId,
        toolName,
        agentName,
        ...permissionLogContext,
        resolution: "policy_denied",
        decisionPersistence: "none",
        decisionScope: getPermissionDecisionScope({
          target: permissionLogContext.target,
          command: permissionLogContext.command,
          path: getPathBearingToolPath(toolName, input) ?? undefined,
          toolName,
        }),
      });
      await extensionLogger.flush();
      return { block: true, reason: formatDenyReason(check, agentName ?? undefined) };
    }

    if (check.state === "ask") {
      const unavailableReason = toolName === "bash" && isToolCallEventType("bash", event)
        ? `Running bash command '${event.input.command}' requires approval, but no interactive UI is available.`
        : toolName === "mcp"
          ? "Using tool 'mcp' requires approval, but no interactive UI is available."
          : `Using tool '${toolName}' requires approval, but no interactive UI is available.`;

      const message = formatAskPrompt(check, agentName ?? undefined, input);
      if (!canRequestPermissionConfirmation(ctx)) {
        writeReviewEntry("permission_request.blocked", {
          ...buildToolCallBlockedEntryFields(event.toolCallId, toolName, agentName),
          prompt: message,
          promptMetadata: createSensitiveLogMetadata(message),
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
      const approval = persistSessionApprovalDecision(decision, check, input, sessionApprovals);
      if (approval) {
        writeReviewEntry("permission_request.approval_persisted", {
          source: "tool_call",
          toolCallId: event.toolCallId,
          toolName,
          agentName,
          ...permissionLogContext,
          resolution: decision.state,
          decisionPersistence: approval.persistence,
          approvalPersistence: approval.persistence,
          approvalScope: approval.subject,
        });
      }
      await extensionLogger.flush();
    }

    return {};
  });
}
