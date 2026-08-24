import { getNonEmptyString, toRecord } from "./common.js";
import { safeJsonStringify } from "./logging.js";
import type { BashReason, PermissionCheckResult } from "./types.js";
import type { SkillPromptEntry } from "./skill-prompt-sanitizer.js";

const STRUCTURED_EDIT_OPERATION_NAMES = new Set(["replace", "append", "prepend", "delete", "replace_text"]);

const TOOL_INPUT_PREVIEW_MAX_LENGTH = 200;
const TOOL_TEXT_SUMMARY_MAX_LENGTH = 60;

export function getStructuredEditPayloads(inputRecord: Record<string, unknown>): unknown[] {
  if (Array.isArray(inputRecord.edits)) {
    return inputRecord.edits;
  }

  if (typeof inputRecord.oldText === "string" && typeof inputRecord.newText === "string") {
    return [{ op: "replace_text", oldText: inputRecord.oldText, newText: inputRecord.newText }];
  }

  return [];
}

export function hasStructuredEditPayload(inputRecord: Record<string, unknown>): boolean {
  return getStructuredEditPayloads(inputRecord).some((edit) => {
    const editRecord = toRecord(edit);
    const op = typeof editRecord.op === "string" ? editRecord.op : "replace_text";
    return STRUCTURED_EDIT_OPERATION_NAMES.has(op)
      || (typeof editRecord.oldText === "string" && typeof editRecord.newText === "string");
  });
}

export function formatMissingToolNameReason(): string {
  return "Tool call was blocked because no tool name was provided. Use a registered tool name from pi.getAllTools().";
}

export function formatUnknownToolReason(toolName: string, availableToolNames: readonly string[]): string {
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

/**
 * Format the per-segment reason lines for a bash permission result. One line
 * per deciding segment (segments whose state set the final state). The
 * segment-text prefix is only shown for compound commands (more than one
 * segment); single-segment commands read as bare reasons.
 */
function formatBashReasonLines(result: PermissionCheckResult): string[] {
  const reasons = result.bashReasons ?? [];
  if (reasons.length === 0) {
    return [];
  }
  const compound = (result.bashSegmentCount ?? 0) > 1;
  return reasons.map((reason) => formatBashReasonLine(result, reason, compound));
}

function formatBashReasonLine(result: PermissionCheckResult, reason: BashReason, compound: boolean): string {
  // The quoted segment text identifies which part of a compound command the
  // reason refers to. Whitespace is normalized so multi-line segments (e.g.
  // heredocs) stay on one line, and long segments are truncated. In
  // single-segment commands the segment reference is omitted entirely so the
  // line reads as a bare reason (no dangling "for segment:" or empty line).
  const segment = compound ? `\n   '${sanitizeInlineText(reason.text)}'` : "";
  switch (reason.kind) {
    case "command":
      return compound
        ? ` - matched '${reason.pattern}' for segment:${segment}`
        : ` - matched '${reason.pattern}'`;
    case "redirect":
      return compound
        ? ` - redirect to '${reason.target}' matched bashRedirect '${reason.pattern}':${segment}`
        : ` - redirect to '${reason.target}' matched bashRedirect '${reason.pattern}'`;
    case "opaque":
      return compound
        ? ` - contains unparseable constructs — always requires approval:${segment}`
        : ` - contains unparseable constructs — always requires approval`;
    case "default":
      return compound
        ? ` - no matching rule (default: ${result.state}) for segment:${segment}`
        : ` - no matching rule (default: ${result.state})`;
  }
}

function formatBashReasonBlock(result: PermissionCheckResult): string {
  const lines = formatBashReasonLines(result);
  return lines.length > 0 ? `\n${lines.join("\n")}\n` : "";
}

export function formatDenyReason(result: PermissionCheckResult, agentName?: string): string {
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

  let reasonBlock = "";
  if (result.toolName === "bash") {
    reasonBlock = formatBashReasonBlock(result);
  } else if (result.matchedPattern) {
    parts.push(`(matched '${result.matchedPattern}')`);
  }
  const separator = reasonBlock ? "" : " ";

  return `${parts.join(" ")}.${reasonBlock}${separator}${formatPermissionHardStopHint(result)}`;
}

export function formatUserDeniedReason(result: PermissionCheckResult, denialReason?: string): string {
  const base = (result.source === "mcp" || result.toolName === "mcp") && result.target
    ? `User denied MCP target '${result.target}'.`
    : result.toolName === "bash" && result.command
      ? `User denied bash command '${result.command}'.`
      : `User denied tool '${result.toolName}'.`;
  const reasonSuffix = denialReason ? ` Reason: ${denialReason}.` : "";

  return `${base}${reasonSuffix} ${formatPermissionHardStopHint(result)}`;
}

function truncateInlineText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function sanitizeInlineText(value: string, maxLength = TOOL_TEXT_SUMMARY_MAX_LENGTH): string {
  const firstLine = value.split(/\r\n|\r|\n/)[0].trim();
  return firstLine ? truncateInlineText(firstLine, maxLength) : "empty text";
}

function countTextLines(value: string): number {
  if (!value) {
    return 0;
  }

  return value.split(/\r\n|\r|\n/).length;
}

function formatCount(value: number, singular: string, plural: string): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function getPromptPath(input: Record<string, unknown>): string | null {
  return getNonEmptyString(input.path) ?? getNonEmptyString(input.file_path);
}

function countEditPayloadLines(value: unknown): number {
  if (Array.isArray(value)) {
    return value.filter((line) => typeof line === "string").length;
  }
  if (typeof value === "string") {
    return countTextLines(value.endsWith("\n") ? value.slice(0, -1) : value);
  }
  return 0;
}

function formatEditReference(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? sanitizeInlineText(value, 40)
    : "anchor";
}

function formatEditReferenceRange(edit: Record<string, unknown>): string {
  const start = formatEditReference(edit.pos);
  const end = typeof edit.end === "string" && edit.end.trim()
    ? ` through ${formatEditReference(edit.end)}`
    : "";
  return `${start}${end}`;
}

function formatStructuredEditSummary(edit: Record<string, unknown>, index: number): string | null {
  const ordinal = `edit #${index + 1}`;
  const op = typeof edit.op === "string" ? edit.op : "replace_text";

  if (typeof edit.oldText === "string" && typeof edit.newText === "string" && op === "replace_text") {
    return `${ordinal} replaces ${formatCount(countTextLines(edit.oldText), "line", "lines")} with ${formatCount(countTextLines(edit.newText), "line", "lines")}`;
  }

  const lineCount = formatCount(countEditPayloadLines(edit.lines), "line", "lines");
  switch (op) {
    case "replace": {
      const refRange = formatEditReferenceRange(edit);
      return `${ordinal} replaces ${lineCount} at ${refRange}`;
    }
    case "append":
      return `${ordinal} appends ${lineCount}${typeof edit.pos === "string" ? ` after ${formatEditReference(edit.pos)}` : " at EOF"}`;
    case "prepend":
      return `${ordinal} prepends ${lineCount}${typeof edit.pos === "string" ? ` before ${formatEditReference(edit.pos)}` : " at BOF"}`;
    case "delete": {
      const refRange = formatEditReferenceRange(edit);
      return `${ordinal} deletes at ${refRange}`;
    }
    default:
      return null;
  }
}

function formatStructuredEditInputForPrompt(input: Record<string, unknown>, fallback?: string): string | null {
  const path = getPromptPath(input);
  const editSummaries = getStructuredEditPayloads(input)
    .map((edit, index) => formatStructuredEditSummary(toRecord(edit), index))
    .filter((summary): summary is string => typeof summary === "string" && summary.length > 0);

  const pathPart = path ? `for '${path}'` : "";
  if (editSummaries.length === 0) {
    if (!fallback) {
      return null;
    }
    return pathPart ? `${pathPart} ${fallback}` : fallback;
  }

  const extraEdits = editSummaries.length > 1 ? `, plus ${formatCount(editSummaries.length - 1, "additional edit", "additional edits")}` : "";
  const summary = `(${formatCount(editSummaries.length, "edit", "edits")}: ${editSummaries[0]}${extraEdits})`;
  return pathPart ? `${pathPart} ${summary}` : summary;
}

function formatEditInputForPrompt(input: Record<string, unknown>): string {
  return formatStructuredEditInputForPrompt(input, "with edit input") ?? "with edit input";
}

function formatWriteInputForPrompt(input: Record<string, unknown>): string {
  const path = getPromptPath(input);
  const content = typeof input.content === "string" ? input.content : "";
  const summary = `(${formatCount(countTextLines(content), "line", "lines")}, ${formatCount(content.length, "character", "characters")})`;
  return path ? `for '${path}' ${summary}` : summary;
}

function formatReadInputForPrompt(input: Record<string, unknown>): string {
  const path = getPromptPath(input);
  const parts = path ? [`path '${path}'`] : [];
  if (typeof input.offset === "number") {
    parts.push(`offset ${input.offset}`);
  }
  if (typeof input.limit === "number") {
    parts.push(`limit ${input.limit}`);
  }
  return parts.length > 0 ? `for ${parts.join(", ")}` : "";
}

function formatSearchInputForPrompt(toolName: string, input: Record<string, unknown>): string {
  const parts: string[] = [];
  const path = getPromptPath(input);
  const pattern = getNonEmptyString(input.pattern);
  const glob = getNonEmptyString(input.glob);

  if (pattern) {
    parts.push(`pattern '${sanitizeInlineText(pattern)}'`);
  }
  if (glob) {
    parts.push(`glob '${sanitizeInlineText(glob)}'`);
  }
  if (path) {
    parts.push(`path '${path}'`);
  } else if (toolName === "find" || toolName === "grep" || toolName === "ls") {
    parts.push("current working directory");
  }

  return parts.length > 0 ? `for ${parts.join(", ")}` : "";
}

function serializeToolInputPreview(input: unknown): string {
  const serialized = safeJsonStringify(input);
  if (!serialized || serialized === "{}" || serialized === "null") {
    return "";
  }

  return serialized.replace(/\s+/g, " ").trim();
}

function formatJsonInputForPrompt(input: unknown): string {
  const inline = serializeToolInputPreview(input);
  return inline ? `with input ${truncateInlineText(inline, TOOL_INPUT_PREVIEW_MAX_LENGTH)}` : "";
}

export function formatToolInputForPrompt(toolName: string, input: unknown): string {
  const inputRecord = toRecord(input);

  switch (toolName) {
    case "edit":
      return formatEditInputForPrompt(inputRecord);
    case "write":
      return formatWriteInputForPrompt(inputRecord);
    case "read":
      return formatReadInputForPrompt(inputRecord);
    case "find":
    case "grep":
    case "ls":
      return formatSearchInputForPrompt(toolName, inputRecord);
    default: {
      const structuredEditPreview = formatStructuredEditInputForPrompt(inputRecord);
      return structuredEditPreview ?? formatJsonInputForPrompt(input);
    }
  }
}

export function formatAgentSubject(agentName?: string): string {
  return agentName ? `Agent '${agentName}'` : "Current agent";
}

export function formatAskPrompt(result: PermissionCheckResult, agentName?: string, input?: unknown): string {
  const subject = formatAgentSubject(agentName);

  if (result.toolName === "bash") {
    const reasonBlock = formatBashReasonBlock(result);
    const separator = reasonBlock ? "" : " ";
    return `${subject} requested bash command '${result.command || ""}'.${reasonBlock}${separator}Allow this command?`;
  }

  if ((result.source === "mcp" || result.toolName === "mcp") && result.target) {
    const patternInfo = result.matchedPattern ? ` (matched '${result.matchedPattern}')` : "";
    return `${subject} requested MCP target '${result.target}'${patternInfo}. Allow this call?`;
  }

  const patternInfo = result.matchedPattern ? ` (matched '${result.matchedPattern}')` : "";
  const inputPreview = formatToolInputForPrompt(result.toolName, input);
  const inputSuffix = inputPreview ? ` ${inputPreview}` : "";
  return `${subject} requested tool '${result.toolName}'${patternInfo}${inputSuffix}. Allow this call?`;
}

export function formatSkillAskPrompt(skillName: string, agentName?: string): string {
  return `${formatAgentSubject(agentName)} requested skill '${skillName}'. Allow loading this skill?`;
}

export function formatSkillPathAskPrompt(skill: SkillPromptEntry, readPath: string, agentName?: string): string {
  return `${formatAgentSubject(agentName)} requested access to skill '${skill.name}' via '${readPath}'. Allow this read?`;
}

export function formatSkillPathDenyReason(skill: SkillPromptEntry, readPath: string, agentName?: string): string {
  return `${formatAgentSubject(agentName)} is not permitted to access this skill.`;
}

export function formatExternalDirectoryHardStopHint(): string {
  return "Hard stop: this external directory permission denial is policy-enforced. Do not retry this path, do not attempt a filesystem bypass, and report the block to the user.";
}

export function formatExternalDirectoryAskPrompt(
  toolName: string,
  pathValue: string,
  cwd: string,
  agentName?: string,
): string {
  return `${formatAgentSubject(agentName)} requested tool '${toolName}' for path '${pathValue}' outside working directory '${cwd}'. Allow this external directory access?`;
}

export function formatExternalDirectoryDenyReason(
  toolName: string,
  pathValue: string,
  cwd: string,
  agentName?: string,
): string {
  return `${formatAgentSubject(agentName)} is not permitted to run tool '${toolName}' for path '${pathValue}' outside working directory '${cwd}'. ${formatExternalDirectoryHardStopHint()}`;
}

export function formatExternalDirectoryUserDeniedReason(
  toolName: string,
  pathValue: string,
  denialReason?: string,
): string {
  const reasonSuffix = denialReason ? ` Reason: ${denialReason}.` : "";
  return `User denied external directory access for tool '${toolName}' path '${pathValue}'.${reasonSuffix} ${formatExternalDirectoryHardStopHint()}`;
}
