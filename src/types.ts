export type PermissionState = "allow" | "deny" | "ask";

export type BuiltInToolName = "bash" | "read" | "write" | "edit" | "grep" | "find" | "ls";

export type ToolPermissions = Record<string, PermissionState>;

export type BashPermissions = Record<string, PermissionState>;

/**
 * Pattern-based permissions for bash output-redirect targets (`>`, `>>`, `&>`,
 * `<>`). Patterns match the unquoted redirect target (for example
 * "/dev/null"). fd-dup redirects (`2>&1`) are exempt by construction and
 * input redirection (`<`) is never evaluated.
 */
export type BashRedirectPermissions = Record<string, PermissionState>;

/**
 * Why a deciding bash segment has its final state. One reason is emitted per
 * segment whose state equals the command's final (most restrictive) state.
 * `segmentIndex` is 1-based; `text` is the segment's command text (what
 * prompts display in place of a "segment N" label). Prompts omit the segment
 * prefix for single-segment commands.
 */
export type BashReason =
  | { kind: "command"; segmentIndex: number; text: string; pattern: string }
  | { kind: "redirect"; segmentIndex: number; text: string; target: string; pattern: string }
  | { kind: "opaque"; segmentIndex: number; text: string }
  | { kind: "default"; segmentIndex: number; text: string };

export type SkillPermissions = Record<string, PermissionState>;

export type SpecialPermissionName = "doom_loop" | "external_directory";

export type SpecialPermissions = Record<string, PermissionState>;

export interface PermissionDefaultPolicy {
  tools: PermissionState;
  bash: PermissionState;
  mcp: PermissionState;
  skills: PermissionState;
  special: PermissionState;
}

export interface AgentPermissions {
  defaultPolicy?: Partial<PermissionDefaultPolicy>;
  tools?: ToolPermissions;
  bash?: BashPermissions;
  bashRedirect?: BashRedirectPermissions;
  mcp?: ToolPermissions;
  skills?: SkillPermissions;
  special?: SpecialPermissions;
}

export interface GlobalPermissionConfig extends AgentPermissions {
  defaultPolicy: PermissionDefaultPolicy;
}

export interface PermissionCheckResult {
  toolName: string;
  state: PermissionState;
  matchedPattern?: string;
  command?: string;
  target?: string;
  /** Bash only: the command contains at least one opaque (unparseable) segment. */
  hasOpaqueSegments?: boolean;
  /** Bash only: per-decision reasons (one per segment that set the final state). */
  bashReasons?: BashReason[];
  /** Bash only: total number of segments in the command. */
  bashSegmentCount?: number;
  source: "tool" | "bash" | "mcp" | "skill" | "special" | "default";
}
