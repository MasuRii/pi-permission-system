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
  source: "tool" | "bash" | "mcp" | "skill" | "special" | "default";
}
