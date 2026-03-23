export type PermissionDecisionState = "approved" | "denied" | "denied_with_reason";

export type PermissionPromptDecision = {
  approved: boolean;
  state: PermissionDecisionState;
  denialReason?: string;
};

export interface PermissionDecisionUi {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
}

const APPROVE_OPTION = "Yes";
const DENY_OPTION = "No";
const DENY_WITH_REASON_OPTION = "No, provide reason";
const PERMISSION_DECISION_OPTIONS = [
  APPROVE_OPTION,
  DENY_OPTION,
  DENY_WITH_REASON_OPTION,
] as const;

export function normalizePermissionDenialReason(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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
  return value === "approved" || value === "denied" || value === "denied_with_reason";
}

export async function requestPermissionDecisionFromUi(
  ui: PermissionDecisionUi,
  title: string,
  message: string,
): Promise<PermissionPromptDecision> {
  const selected = await ui.select(
    `${title}\n${message}`,
    [...PERMISSION_DECISION_OPTIONS],
  );

  if (selected === APPROVE_OPTION) {
    return {
      approved: true,
      state: "approved",
    };
  }

  if (selected === DENY_WITH_REASON_OPTION) {
    const denialReason = normalizePermissionDenialReason(
      await ui.input(
        `${title}\nShare why this request was denied (optional).`,
        "Reason shown back to the agent",
      ),
    );

    return createDeniedPermissionDecision(denialReason);
  }

  return createDeniedPermissionDecision();
}
