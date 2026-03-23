import { join } from "node:path";

export const PERMISSION_FORWARDING_POLL_INTERVAL_MS = 250;
export const PERMISSION_FORWARDING_TIMEOUT_MS = 10 * 60 * 1000;
export const SUBAGENT_ENV_HINT_KEYS = ["PI_IS_SUBAGENT", "PI_SUBAGENT_SESSION_ID", "PI_AGENT_ROUTER_SUBAGENT"] as const;
export const SUBAGENT_PARENT_SESSION_ENV_KEY = "PI_AGENT_ROUTER_PARENT_SESSION_ID";

const SESSION_FORWARDING_ROOT_DIRECTORY_NAME = "sessions";
const SESSION_FORWARDING_REQUESTS_DIRECTORY_NAME = "requests";
const SESSION_FORWARDING_RESPONSES_DIRECTORY_NAME = "responses";

export type ForwardedPermissionRequest = {
  id: string;
  createdAt: number;
  requesterSessionId: string;
  targetSessionId: string;
  requesterAgentName: string;
  message: string;
};

export type ForwardedPermissionResponse = {
  approved: boolean;
  responderSessionId: string;
  respondedAt: number;
};

export type PermissionForwardingLocation = {
  sessionId: string;
  sessionRootDir: string;
  requestsDir: string;
  responsesDir: string;
  label: "primary";
};

export function normalizePermissionForwardingSessionId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "unknown") {
    return null;
  }

  return trimmed;
}

function encodeSessionIdForPath(sessionId: string): string {
  return encodeURIComponent(sessionId);
}

export function createPermissionForwardingLocation(
  forwardingRootDir: string,
  sessionId: string,
): PermissionForwardingLocation {
  const normalizedSessionId = normalizePermissionForwardingSessionId(sessionId);
  if (!normalizedSessionId) {
    throw new Error("Permission forwarding session id must be a non-empty string.");
  }

  const sessionRootDir = join(
    forwardingRootDir,
    SESSION_FORWARDING_ROOT_DIRECTORY_NAME,
    encodeSessionIdForPath(normalizedSessionId),
  );

  return {
    sessionId: normalizedSessionId,
    sessionRootDir,
    requestsDir: join(sessionRootDir, SESSION_FORWARDING_REQUESTS_DIRECTORY_NAME),
    responsesDir: join(sessionRootDir, SESSION_FORWARDING_RESPONSES_DIRECTORY_NAME),
    label: "primary",
  };
}

export function resolvePermissionForwardingTargetSessionId(options: {
  hasUI: boolean;
  isSubagent: boolean;
  currentSessionId?: string | null;
  env?: NodeJS.ProcessEnv;
}): string | null {
  if (options.hasUI) {
    return normalizePermissionForwardingSessionId(options.currentSessionId);
  }

  if (!options.isSubagent) {
    return null;
  }

  return normalizePermissionForwardingSessionId(
    options.env?.[SUBAGENT_PARENT_SESSION_ENV_KEY],
  );
}

export function isForwardedPermissionRequestForSession(
  request: Pick<ForwardedPermissionRequest, "targetSessionId">,
  sessionId: string | null | undefined,
): boolean {
  const normalizedRequestSessionId = normalizePermissionForwardingSessionId(request.targetSessionId);
  const normalizedSessionId = normalizePermissionForwardingSessionId(sessionId);
  return normalizedRequestSessionId !== null && normalizedRequestSessionId === normalizedSessionId;
}
