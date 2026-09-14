import { getNonEmptyString } from "./common.js";

export type PermissionDecisionState = "approved" | "denied" | "denied_with_reason" | "once" | "always" | "reject";

export type PermissionPromptDecision = {
  approved: boolean;
  state: PermissionDecisionState;
  denialReason?: string;
  approvalMessage?: string;
};

export interface PermissionDecisionUiSelectOptions {
  timeout?: number;
}

export interface PermissionDecisionUi {
  select(title: string, options: string[], optionsOverride?: PermissionDecisionUiSelectOptions): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
}

export type PermissionDecisionRequestOptions = {
  timeoutMs?: number;
  timeoutDenialReason?: string;
};

const APPROVE_ONCE_OPTION = "Allow Once";
const APPROVE_ONCE_WITH_MESSAGE_OPTION = "Allow Once with Message";
const APPROVE_ALWAYS_OPTION = "Allow Always";
const REJECT_OPTION = "Reject";
const REJECT_WITH_REASON_OPTION = "Reject with Reason";
const PERMISSION_DECISION_OPTIONS = [
  APPROVE_ONCE_OPTION,
  APPROVE_ONCE_WITH_MESSAGE_OPTION,
  APPROVE_ALWAYS_OPTION,
  REJECT_OPTION,
  REJECT_WITH_REASON_OPTION,
] as const;
const PERMISSION_DIALOG_MAX_VISIBLE_LINES = 32;
const PERMISSION_DIALOG_MAX_VISIBLE_CHARACTERS = 2_200;

function splitPromptLines(value: string): string[] {
  return value.split(/\r\n|\r|\n/);
}

function formatPromptCompactionNotice(omittedLines: number, omittedCharacters: number): string {
  const omittedParts = [
    omittedLines > 0 ? `${omittedLines} ${omittedLines === 1 ? "line" : "lines"}` : null,
    omittedCharacters > 0 ? `${omittedCharacters} ${omittedCharacters === 1 ? "character" : "characters"}` : null,
  ].filter((part): part is string => typeof part === "string");
  const omittedSummary = omittedParts.length > 0 ? omittedParts.join(" and ") : "content";
  return `[Permission prompt compacted: omitted ${omittedSummary} to keep the permission dialog usable.]`;
}

function compactPermissionPromptForSelect(value: string): string {
  const lines = splitPromptLines(value);
  if (lines.length <= PERMISSION_DIALOG_MAX_VISIBLE_LINES && value.length <= PERMISSION_DIALOG_MAX_VISIBLE_CHARACTERS) {
    return value;
  }

  const maxPrefixLines = Math.max(1, PERMISSION_DIALOG_MAX_VISIBLE_LINES - 1);
  const prefixLines = lines.slice(0, maxPrefixLines);
  const omittedLines = Math.max(0, lines.length - prefixLines.length);
  let prefix = prefixLines.join("\n");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const omittedCharacters = Math.max(0, value.length - prefix.length);
    const notice = formatPromptCompactionNotice(omittedLines, omittedCharacters);
    const separatorLength = prefix.trimEnd() ? 1 : 0;
    const maxPrefixCharacters = Math.max(0, PERMISSION_DIALOG_MAX_VISIBLE_CHARACTERS - notice.length - separatorLength);

    if (prefix.length <= maxPrefixCharacters) {
      return prefix.trimEnd() ? `${prefix.trimEnd()}\n${notice}` : notice;
    }

    prefix = prefix.slice(0, maxPrefixCharacters).trimEnd();
  }

  const omittedCharacters = Math.max(0, value.length - prefix.length);
  const notice = formatPromptCompactionNotice(omittedLines, omittedCharacters);
  return prefix.trimEnd() ? `${prefix.trimEnd()}\n${notice}` : notice;
}

export function normalizePermissionDenialReason(value: unknown): string | undefined {
  return getNonEmptyString(value) ?? undefined;
}

export function createDeniedPermissionDecision(
  denialReason?: string,
): PermissionPromptDecision {
  const normalizedReason = normalizePermissionDenialReason(denialReason);
  return normalizedReason
    ? {
      approved: false,
      state: "denied_with_reason",
      denialReason: normalizedReason,
    }
    : {
      approved: false,
      state: "denied",
    };
}

export function isPermissionDecisionState(
  value: unknown,
): value is PermissionDecisionState {
  return value === "approved"
    || value === "denied"
    || value === "denied_with_reason"
    || value === "once"
    || value === "always"
    || value === "reject";
}

export async function requestPermissionDecisionFromUi(
  ui: PermissionDecisionUi,
  title: string,
  message: string,
  options: PermissionDecisionRequestOptions = {},
): Promise<PermissionPromptDecision> {
  const selectOptions = typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? { timeout: options.timeoutMs }
    : undefined;
  const selected = await ui.select(
    compactPermissionPromptForSelect(`${title}\n${message}`),
    [...PERMISSION_DECISION_OPTIONS],
    selectOptions,
  );

  if (selected === APPROVE_ONCE_OPTION) {
    return {
      approved: true,
      state: "once",
    };
  }

  if (selected === APPROVE_ONCE_WITH_MESSAGE_OPTION) {
    const approvalMessage = getNonEmptyString(
      await ui.input(
        `${title}\nMessage to steer the agent alongside this approval (optional).`,
        "Note shown to the agent",
      ),
    );

    return approvalMessage
      ? { approved: true, state: "once", approvalMessage }
      : { approved: true, state: "once" };
  }

  if (selected === APPROVE_ALWAYS_OPTION) {
    return {
      approved: true,
      state: "always",
    };
  }

  if (selected === REJECT_WITH_REASON_OPTION) {
    const denialReason = normalizePermissionDenialReason(
      await ui.input(
        `${title}\nShare why this request was denied (optional).`,
        "Reason shown back to the agent",
      ),
    );

    return denialReason
      ? { approved: false, state: "reject", denialReason }
      : { approved: false, state: "reject" };
  }

  return options.timeoutDenialReason
    ? { approved: false, state: "reject", denialReason: options.timeoutDenialReason }
    : { approved: false, state: "reject" };
}
