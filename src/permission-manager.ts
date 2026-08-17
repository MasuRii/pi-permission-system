import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { evaluateBashCommand, expandHomeInPattern } from "./bash-filter.js";
import {
  extractFrontmatter,
  findFirstMatchForNames,
  getNonEmptyString,
  isPermissionState,
  normalizePathResourceForPermission,
  parseSimpleYamlMap,
  toRecord,
} from "./common.js";
import { formatJsoncConfigLoadWarning, parseJsoncConfig } from "./jsonc-config.js";
import type {
  AgentPermissions,
  BashPermissions,
  GlobalPermissionConfig,
  PermissionCheckResult,
  PermissionDefaultPolicy,
  PermissionState,
} from "./types.js";
import {
  compileWildcardPatternEntries,
  findCompiledWildcardMatch,
  type CompiledWildcardPattern,
} from "./wildcard-matcher.js";

const PERMISSION_POLICY_AGENT_DIR_ENV_KEY = "PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR";

function defaultPolicyAgentDir(): string {
  const override = process.env[PERMISSION_POLICY_AGENT_DIR_ENV_KEY]?.trim();
  return override ? resolve(override) : getAgentDir();
}

function defaultGlobalConfigPath(): string { return join(defaultPolicyAgentDir(), "pi-permissions.jsonc"); }
function defaultAgentsDir(): string { return join(defaultPolicyAgentDir(), "agents"); }
function defaultLegacyGlobalSettingsPath(): string { return join(defaultPolicyAgentDir(), "settings.json"); }
function defaultGlobalMcpConfigPath(): string { return join(defaultPolicyAgentDir(), "mcp.json"); }

const BUILT_IN_TOOL_PERMISSION_NAMES = new Set(["bash", "read", "write", "edit", "grep", "find", "ls"]);
const SPECIAL_PERMISSION_KEYS = new Set(["doom_loop", "external_directory"]);
const MCP_BASELINE_TARGETS = new Set(["mcp_status", "mcp_list", "mcp_search", "mcp_describe", "mcp_connect"]);

const DEFAULT_POLICY: PermissionDefaultPolicy = {
  tools: "ask",
  bash: "ask",
  mcp: "ask",
  skills: "ask",
  special: "ask",
};

const EMPTY_GLOBAL_CONFIG: GlobalPermissionConfig = {
  defaultPolicy: DEFAULT_POLICY,
  tools: {},
  bash: {},
  bashRedirect: {},
  mcp: {},
  skills: {},
  special: {},
};

function normalizePolicy(value: unknown): PermissionDefaultPolicy {
  const record = toRecord(value);
  return {
    tools: isPermissionState(record.tools) ? record.tools : DEFAULT_POLICY.tools,
    bash: isPermissionState(record.bash) ? record.bash : DEFAULT_POLICY.bash,
    mcp: isPermissionState(record.mcp) ? record.mcp : DEFAULT_POLICY.mcp,
    skills: isPermissionState(record.skills) ? record.skills : DEFAULT_POLICY.skills,
    special: isPermissionState(record.special) ? record.special : DEFAULT_POLICY.special,
  };
}

function normalizePartialPolicy(value: unknown): Partial<PermissionDefaultPolicy> {
  const record = toRecord(value);
  const normalized: Partial<PermissionDefaultPolicy> = {};

  if (isPermissionState(record.tools)) {
    normalized.tools = record.tools;
  }

  if (isPermissionState(record.bash)) {
    normalized.bash = record.bash;
  }

  if (isPermissionState(record.mcp)) {
    normalized.mcp = record.mcp;
  }

  if (isPermissionState(record.skills)) {
    normalized.skills = record.skills;
  }

  if (isPermissionState(record.special)) {
    normalized.special = record.special;
  }

  return normalized;
}

function normalizePermissionRecord(value: unknown): Record<string, PermissionState> {
  const record = toRecord(value);
  const normalized: Record<string, PermissionState> = {};
  for (const [key, state] of Object.entries(record)) {
    if (isPermissionState(state)) {
      normalized[key] = state;
    }
  }
  return normalized;
}

function readConfiguredMcpServerNamesFromConfigPath(configPath: string): string[] {
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseJsoncConfig(raw, configPath, "permission config");
    const root = toRecord(parsed);
    const serverRecord = toRecord(root.mcpServers ?? root["mcp-servers"]);

    return Object.keys(serverRecord)
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
  } catch {
    return [];
  }
}

function getConfiguredMcpServerNamesFromPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();

  for (const path of paths) {
    for (const name of readConfiguredMcpServerNamesFromConfigPath(path)) {
      seen.add(name);
    }
  }

  return [...seen].sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function normalizeRawPermission(raw: unknown): AgentPermissions {
  const record = toRecord(raw);
  const normalizedTools = normalizePermissionRecord(record.tools);

  // Redirect-target patterns are matched against normalized absolute paths,
  // so expand a leading `~` in the patterns for a convenience that mirrors
  // what the matcher does to command targets.
  const normalizedBashRedirect = Object.fromEntries(
    Object.entries(normalizePermissionRecord(record.bashRedirect)).map(([pattern, state]) => [
      expandHomeInPattern(pattern),
      state,
    ]),
  );

  const normalized: AgentPermissions = {
    defaultPolicy: normalizePartialPolicy(record.defaultPolicy),
    tools: normalizedTools,
    bash: normalizePermissionRecord(record.bash),
    bashRedirect: normalizedBashRedirect,
    mcp: normalizePermissionRecord(record.mcp),
    skills: normalizePermissionRecord(record.skills),
    special: normalizePermissionRecord(record.special),
  };

  for (const [key, value] of Object.entries(record)) {
    if (!isPermissionState(value)) {
      continue;
    }

    if (BUILT_IN_TOOL_PERMISSION_NAMES.has(key)) {
      normalized.tools = { ...(normalized.tools || {}), [key]: value };
      continue;
    }

    if (SPECIAL_PERMISSION_KEYS.has(key)) {
      normalized.special = { ...(normalized.special || {}), [key]: value };
    }
  }

  return normalized;
}

function parseQualifiedMcpToolName(value: string): { server: string; tool: string } | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const colonIndex = trimmed.indexOf(":");
  if (colonIndex <= 0 || colonIndex >= trimmed.length - 1) {
    return null;
  }

  const server = trimmed.slice(0, colonIndex).trim();
  const tool = trimmed.slice(colonIndex + 1).trim();
  if (!server || !tool) {
    return null;
  }

  return { server, tool };
}

function addDerivedMcpServerTargets(
  toolName: string,
  configuredServerNames: readonly string[],
  pushTarget: (value: string | null) => void,
): void {
  const trimmedToolName = toolName.trim();
  if (!trimmedToolName) {
    return;
  }

  for (const serverName of configuredServerNames) {
    const trimmedServerName = serverName.trim();
    if (!trimmedServerName) {
      continue;
    }

    if (!trimmedToolName.endsWith(`_${trimmedServerName}`)) {
      continue;
    }

    if (trimmedToolName.startsWith(`${trimmedServerName}_`)) {
      continue;
    }

    pushTarget(`${trimmedServerName}_${trimmedToolName}`);
    pushTarget(`${trimmedServerName}:${trimmedToolName}`);
    pushTarget(trimmedServerName);
  }
}

function pushMcpToolPermissionTargets(
  rawReference: string,
  serverHint: string | null,
  configuredServerNames: readonly string[],
  pushTarget: (value: string | null) => void,
): void {
  const qualified = parseQualifiedMcpToolName(rawReference);
  const resolvedServer = serverHint ?? qualified?.server ?? null;
  const resolvedTool = qualified?.tool ?? rawReference;

  if (resolvedServer) {
    pushTarget(`${resolvedServer}_${resolvedTool}`);
    pushTarget(`${resolvedServer}:${resolvedTool}`);
    pushTarget(resolvedServer);
  } else {
    addDerivedMcpServerTargets(resolvedTool, configuredServerNames, pushTarget);
  }

  pushTarget(resolvedTool);
  pushTarget(rawReference);
}

function createMcpPermissionTargets(input: unknown, configuredServerNames: readonly string[] = []): string[] {
  const record = toRecord(input);
  const tool = getNonEmptyString(record.tool);
  const server = getNonEmptyString(record.server);
  const connect = getNonEmptyString(record.connect);
  const describe = getNonEmptyString(record.describe);
  const search = getNonEmptyString(record.search);

  const targets: string[] = [];
  const pushTarget = (value: string | null) => {
    if (!value) {
      return;
    }
    if (!targets.includes(value)) {
      targets.push(value);
    }
  };

  if (tool) {
    pushMcpToolPermissionTargets(tool, server, configuredServerNames, pushTarget);
    pushTarget("mcp_call");
    return targets;
  }

  if (connect) {
    pushTarget(`mcp_connect_${connect}`);
    pushTarget(connect);
    pushTarget("mcp_connect");
    return targets;
  }

  if (describe) {
    pushMcpToolPermissionTargets(describe, server, configuredServerNames, pushTarget);
    pushTarget("mcp_describe");
    return targets;
  }

  if (search) {
    if (server) {
      pushTarget(`mcp_server_${server}`);
      pushTarget(server);
    }

    pushTarget(search);
    pushTarget("mcp_search");
    return targets;
  }

  if (server) {
    pushTarget(`mcp_server_${server}`);
    pushTarget(server);
    pushTarget("mcp_list");
    return targets;
  }

  pushTarget("mcp_status");
  return targets;
}

type PermissionLayerName = "global" | "project" | "agent" | "projectAgent";

type PermissionLayer = {
  name: PermissionLayerName;
  permissions: GlobalPermissionConfig | AgentPermissions;
  trusted: boolean;
};

type LayeredPermissionState = {
  state: PermissionState;
  layer: PermissionLayerName;
  trusted: boolean;
};

type LayeredPermissionResolution = LayeredPermissionState;

type LayeredPermissionMatch = {
  state: PermissionState;
  matchedPattern: string;
  matchedName: string;
};

type PermissionRecordCategory = "tools" | "bash" | "bashRedirect" | "mcp" | "skills" | "special";
type PermissionDefaultCategory = keyof PermissionDefaultPolicy;
type CompiledPermissionPatterns = readonly CompiledWildcardPattern<LayeredPermissionState>[];

type ResolvedPermissions = {
  globalConfig: GlobalPermissionConfig;
  agentConfig: AgentPermissions;
  merged: GlobalPermissionConfig;
  layers: readonly PermissionLayer[];
  compiledTools: CompiledPermissionPatterns;
  compiledSpecial: CompiledPermissionPatterns;
  compiledSkills: CompiledPermissionPatterns;
  compiledMcp: CompiledPermissionPatterns;
  compiledBash: CompiledPermissionPatterns;
  compiledBashRedirect: CompiledPermissionPatterns;
};

function createPermissionLayers(
  globalConfig: GlobalPermissionConfig,
  projectConfig: AgentPermissions,
  agentConfig: AgentPermissions,
  projectAgentConfig: AgentPermissions,
): readonly PermissionLayer[] {
  return [
    { name: "global", permissions: globalConfig, trusted: true },
    { name: "project", permissions: projectConfig, trusted: false },
    { name: "agent", permissions: agentConfig, trusted: true },
    { name: "projectAgent", permissions: projectAgentConfig, trusted: false },
  ];
}

function compilePermissionPatternsFromLayers(
  category: PermissionRecordCategory,
  layers: readonly PermissionLayer[],
): CompiledPermissionPatterns {
  const entries: Array<readonly [string, LayeredPermissionState]> = [];

  for (const layer of layers) {
    const source = layer.permissions[category];
    if (!source) {
      continue;
    }

    for (const [pattern, state] of Object.entries(source)) {
      entries.push([pattern, { state, layer: layer.name, trusted: layer.trusted }]);
    }
  }

  if (entries.length === 0) {
    return [];
  }

  return compileWildcardPatternEntries(entries);
}

function toLayeredPermissionMatch(match: {
  state: LayeredPermissionState;
  matchedPattern: string;
  matchedName: string;
}): LayeredPermissionMatch {
  return {
    state: match.state.state,
    matchedPattern: match.matchedPattern,
    matchedName: match.matchedName,
  };
}

function toLayeredMatchFromPattern(
  pattern: { state: LayeredPermissionState; pattern: string },
  name: string,
): LayeredPermissionMatch {
  return {
    state: pattern.state.state,
    matchedPattern: pattern.pattern,
    matchedName: name,
  };
}

function findLatestTrustedPatternMatching(
  patterns: CompiledPermissionPatterns,
  isMatch: (pattern: CompiledWildcardPattern<LayeredPermissionState>) => string | null,
): LayeredPermissionMatch | null {
  for (let index = patterns.length - 1; index >= 0; index -= 1) {
    const pattern = patterns[index];
    if (!pattern.state.trusted) {
      continue;
    }
    const matchedName = isMatch(pattern);
    if (matchedName !== null) {
      return toLayeredMatchFromPattern(pattern, matchedName);
    }
  }

  return null;
}

function findLatestTrustedPermissionMatch(
  patterns: CompiledPermissionPatterns,
  name: string,
): LayeredPermissionMatch | null {
  return findLatestTrustedPatternMatching(patterns, (pattern) =>
    pattern.regex.test(name) ? name : null,
  );
}

function findCompiledPermissionMatch(
  patterns: CompiledPermissionPatterns,
  name: string,
): LayeredPermissionMatch | null {
  if (patterns.length === 0) {
    return null;
  }

  const match = findCompiledWildcardMatch(patterns, name);
  if (!match) {
    return null;
  }

  if (match.state.state !== "deny" && !match.state.trusted) {
    const trustedFloor = findLatestTrustedPermissionMatch(patterns, name);
    if (trustedFloor?.state === "deny") {
      return trustedFloor;
    }
  }

  return toLayeredPermissionMatch(match);
}

function findCompiledPermissionMatchForNames(
  patterns: CompiledPermissionPatterns,
  names: readonly string[],
): LayeredPermissionMatch | null {
  return findFirstMatchForNames(names, (name) => findCompiledPermissionMatch(patterns, name));
}

function findLatestTrustedPermissionMatchForNames(
  patterns: CompiledPermissionPatterns,
  names: readonly string[],
): LayeredPermissionMatch | null {
  return findLatestTrustedPatternMatching(patterns, (pattern) => {
    for (const name of names) {
      if (pattern.regex.test(name.replaceAll("\\", "/"))) {
        return name;
      }
    }
    return null;
  });
}

function findCompiledPermissionMatchByPatternOrderForNames(
  patterns: CompiledPermissionPatterns,
  names: readonly string[],
): LayeredPermissionMatch | null {
  if (patterns.length === 0) {
    return null;
  }

  const normalizedNames = names.map((value) => value.trim()).filter((value) => value.length > 0);
  if (normalizedNames.length === 0) {
    return null;
  }

  for (let index = patterns.length - 1; index >= 0; index -= 1) {
    const pattern = patterns[index];
    for (const name of normalizedNames) {
      if (!pattern.regex.test(name.replaceAll("\\", "/"))) {
        continue;
      }

      if (pattern.state.state !== "deny" && !pattern.state.trusted) {
        const trustedFloor = findLatestTrustedPermissionMatchForNames(patterns, normalizedNames);
        if (trustedFloor?.state === "deny") {
          return trustedFloor;
        }
      }

      return toLayeredMatchFromPattern(pattern, name);
    }
  }

  return null;
}

function getPathResourceFromInput(input: unknown): string | null {
  const record = toRecord(input);
  const pathValue = getNonEmptyString(record.path) ?? getNonEmptyString(record.file_path);
  if (!pathValue) {
    return null;
  }

  const cwd = getNonEmptyString(record.cwd) ?? process.cwd();
  const resource = normalizePathResourceForPermission(pathValue, cwd);
  return resource || null;
}

function createActionResourceTargets(action: string, input: unknown): string[] {
  const resource = getPathResourceFromInput(input);
  return resource ? [`${action}:${resource}`] : [];
}

function resolveLayeredPermissionValue(
  layers: readonly PermissionLayer[],
  selectState: (layer: PermissionLayer) => PermissionState | undefined,
): LayeredPermissionResolution | null {
  let current: LayeredPermissionResolution | null = null;
  let trustedFloor: LayeredPermissionResolution | null = null;

  for (const layer of layers) {
    const state = selectState(layer);
    if (!state) {
      continue;
    }

    const candidate: LayeredPermissionResolution = {
      state,
      layer: layer.name,
      trusted: layer.trusted,
    };

    if (!candidate.trusted && candidate.state !== "deny" && trustedFloor?.state === "deny") {
      current = trustedFloor;
      continue;
    }

    current = candidate;
    if (candidate.trusted) {
      trustedFloor = candidate;
    }
  }

  return current;
}

function resolveLayeredRecordPermission(
  layers: readonly PermissionLayer[],
  category: PermissionRecordCategory,
  key: string,
): LayeredPermissionResolution | null {
  return resolveLayeredPermissionValue(layers, (layer) => layer.permissions[category]?.[key]);
}

function resolveLayeredDefaultPermission(
  layers: readonly PermissionLayer[],
  category: PermissionDefaultCategory,
): LayeredPermissionResolution | null {
  return resolveLayeredPermissionValue(layers, (layer) => layer.permissions.defaultPolicy?.[category]);
}

type FileCacheEntry<TValue> = {
  stamp: string;
  value: TValue;
};

function getFileStamp(path: string): string {
  try {
    return String(statSync(path).mtimeMs);
  } catch {
    return "missing";
  }
}

function resolveAgentMarkdownPath(dir: string | null, agentName?: string): string | null {
  if (!dir || !agentName) {
    return null;
  }

  const root = resolve(dir);
  const filePath = resolve(root, `${agentName}.md`);
  const relativePath = relative(root, filePath);
  if (relativePath.startsWith("..") || resolve(relativePath) === relativePath) {
    return null;
  }

  return filePath;
}

export class PermissionManager {
  private readonly globalConfigPath: string;
  private readonly agentsDir: string;
  private readonly projectGlobalConfigPath: string | null;
  private readonly projectAgentsDir: string | null;
  private readonly legacyGlobalSettingsPath: string;
  private readonly globalMcpConfigPath: string;
  private readonly configuredMcpServerNamesOverride: readonly string[] | null;
  private globalConfigCache: FileCacheEntry<GlobalPermissionConfig> | null = null;
  private projectGlobalConfigCache: FileCacheEntry<AgentPermissions> | null = null;
  private readonly agentConfigCache = new Map<string, FileCacheEntry<AgentPermissions>>();
  private readonly projectAgentConfigCache = new Map<string, FileCacheEntry<AgentPermissions>>();
  private readonly resolvedPermissionsCache = new Map<string, FileCacheEntry<ResolvedPermissions>>();
  private configuredMcpServerNamesCache: FileCacheEntry<readonly string[]> | null = null;
  private readonly onWarning: ((message: string) => void) | null;

  constructor(
    options: {
      globalConfigPath?: string;
      agentsDir?: string;
      projectGlobalConfigPath?: string;
      projectAgentsDir?: string;
      legacyGlobalSettingsPath?: string;
      globalMcpConfigPath?: string;
      mcpServerNames?: readonly string[];
      onWarning?: (message: string) => void;
    } = {},
  ) {
    this.globalConfigPath = options.globalConfigPath || defaultGlobalConfigPath();
    this.agentsDir = options.agentsDir || defaultAgentsDir();
    this.projectGlobalConfigPath = options.projectGlobalConfigPath || null;
    this.projectAgentsDir = options.projectAgentsDir || null;
    this.legacyGlobalSettingsPath = options.legacyGlobalSettingsPath || defaultLegacyGlobalSettingsPath();
    this.globalMcpConfigPath = options.globalMcpConfigPath || defaultGlobalMcpConfigPath();
    this.configuredMcpServerNamesOverride = options.mcpServerNames
      ? [...new Set(options.mcpServerNames.map((name) => name.trim()).filter((name) => name.length > 0))]
      : null;
    this.onWarning = options.onWarning || null;
  }

  private notifyWarning(message: string): void {
    this.onWarning?.(message);
  }

  private loadGlobalConfig(): GlobalPermissionConfig {
    const stamp = getFileStamp(this.globalConfigPath);
    if (this.globalConfigCache?.stamp === stamp) {
      return this.globalConfigCache.value;
    }

    let value: GlobalPermissionConfig;
    try {
      const raw = readFileSync(this.globalConfigPath, "utf-8");
      const parsed = parseJsoncConfig(raw, this.globalConfigPath, "permission config");
      const normalized = normalizeRawPermission(parsed);

        value = {
          defaultPolicy: normalizePolicy(normalized.defaultPolicy),
          tools: normalized.tools || {},
          bash: normalized.bash || {},
          bashRedirect: normalized.bashRedirect || {},
          mcp: normalized.mcp || {},
          skills: normalized.skills || {},
          special: normalized.special || {},
        };
    } catch (error) {
      const warning = formatJsoncConfigLoadWarning(
        this.globalConfigPath,
        error,
        "permission config",
        "using ask fallback",
      );
      if (warning) {
        this.notifyWarning(warning);
      }
      value = EMPTY_GLOBAL_CONFIG;
    }

    this.globalConfigCache = { stamp, value };
    return value;
  }

  private loadProjectGlobalConfig(): AgentPermissions {
    if (!this.projectGlobalConfigPath) {
      return {};
    }

    const stamp = getFileStamp(this.projectGlobalConfigPath);
    if (this.projectGlobalConfigCache?.stamp === stamp) {
      return this.projectGlobalConfigCache.value;
    }

    let value: AgentPermissions;
    try {
      const raw = readFileSync(this.projectGlobalConfigPath, "utf-8");
      const parsed = parseJsoncConfig(raw, this.projectGlobalConfigPath, "permission config");
      value = normalizeRawPermission(parsed);
    } catch (error) {
      const warning = formatJsoncConfigLoadWarning(
        this.projectGlobalConfigPath,
        error,
        "permission config",
        "ignoring project permission overrides",
      );
      if (warning) {
        this.notifyWarning(warning);
      }
      value = {};
    }

    this.projectGlobalConfigCache = { stamp, value };
    return value;
  }

  private loadAgentPermissionsFrom(
    dir: string | null,
    cache: Map<string, FileCacheEntry<AgentPermissions>>,
    agentName?: string,
  ): AgentPermissions {
    const filePath = resolveAgentMarkdownPath(dir, agentName);
    if (!filePath || !agentName) {
      return {};
    }

    const stamp = getFileStamp(filePath);
    const cached = cache.get(agentName);
    if (cached?.stamp === stamp) {
      return cached.value;
    }

    let value: AgentPermissions;
    try {
      const markdown = readFileSync(filePath, "utf-8");
      const frontmatter = extractFrontmatter(markdown);
      if (!frontmatter) {
        value = {};
      } else {
        const parsed = parseSimpleYamlMap(frontmatter);
        value = normalizeRawPermission(parsed.permission);
      }
    } catch {
      value = {};
    }

    cache.set(agentName, { stamp, value });
    return value;
  }

  private loadAgentPermissions(agentName?: string): AgentPermissions {
    return this.loadAgentPermissionsFrom(this.agentsDir, this.agentConfigCache, agentName);
  }

  private loadProjectAgentPermissions(agentName?: string): AgentPermissions {
    return this.loadAgentPermissionsFrom(this.projectAgentsDir, this.projectAgentConfigCache, agentName);
  }

  private mergePermissions(globalConfig: GlobalPermissionConfig, agentConfig: AgentPermissions): GlobalPermissionConfig {
    return {
      defaultPolicy: {
        ...globalConfig.defaultPolicy,
        ...(agentConfig.defaultPolicy || {}),
      },
      tools: {
        ...(globalConfig.tools || {}),
        ...(agentConfig.tools || {}),
      },
      bash: {
        ...(globalConfig.bash || {}),
        ...(agentConfig.bash || {}),
      },
      bashRedirect: {
        ...(globalConfig.bashRedirect || {}),
        ...(agentConfig.bashRedirect || {}),
      },
      mcp: {
        ...(globalConfig.mcp || {}),
        ...(agentConfig.mcp || {}),
      },
      skills: {
        ...(globalConfig.skills || {}),
        ...(agentConfig.skills || {}),
      },
      special: {
        ...(globalConfig.special || {}),
        ...(agentConfig.special || {}),
      },
    };
  }

  getPolicyCacheStamp(agentName?: string): string {
    const agentPath = resolveAgentMarkdownPath(this.agentsDir, agentName);
    const projectAgentPath = resolveAgentMarkdownPath(this.projectAgentsDir, agentName);
    const agentStamp = agentPath ? getFileStamp(agentPath) : "missing";
    const projectStamp = this.projectGlobalConfigPath ? getFileStamp(this.projectGlobalConfigPath) : "none";
    const projectAgentStamp = projectAgentPath ? getFileStamp(projectAgentPath) : "none";

    return `${getFileStamp(this.globalConfigPath)}|${projectStamp}|${agentStamp}|${projectAgentStamp}`;
  }

  private resolvePermissions(agentName?: string): ResolvedPermissions {
    const cacheKey = agentName || "__global__";
    const stamp = this.getPolicyCacheStamp(agentName);
    const cached = this.resolvedPermissionsCache.get(cacheKey);
    if (cached?.stamp === stamp) {
      return cached.value;
    }

    const globalConfig = this.loadGlobalConfig();
    const projectConfig = this.loadProjectGlobalConfig();
    const agentConfig = this.loadAgentPermissions(agentName);
    const projectAgentConfig = this.loadProjectAgentPermissions(agentName);

    const mergedWithProject = this.mergePermissions(globalConfig, projectConfig);
    const mergedWithAgent = this.mergePermissions(mergedWithProject, agentConfig);
    const merged = this.mergePermissions(mergedWithAgent, projectAgentConfig);
    const layers = createPermissionLayers(globalConfig, projectConfig, agentConfig, projectAgentConfig);

    const value: ResolvedPermissions = {
      globalConfig,
      agentConfig,
      merged,
      layers,
      compiledTools: compilePermissionPatternsFromLayers("tools", layers),
      compiledSpecial: compilePermissionPatternsFromLayers("special", layers),
      compiledSkills: compilePermissionPatternsFromLayers("skills", layers),
      compiledMcp: compilePermissionPatternsFromLayers("mcp", layers),
      compiledBash: compilePermissionPatternsFromLayers("bash", layers),
      compiledBashRedirect: compilePermissionPatternsFromLayers("bashRedirect", layers),
    };

    this.resolvedPermissionsCache.set(cacheKey, { stamp, value });
    return value;
  }

  getBashPermissions(agentName?: string): BashPermissions {
    const { merged } = this.resolvePermissions(agentName);
    return merged.bash || {};
  }

  /**
   * Check whether the resolved permission config has any explicitly allowed skills.
   * Used to decide if path-bearing tools like `read` should remain exposed to an agent
   * even when the tool-level permission is `deny`, so the agent can read skill files.
   *
   * Returns true when any of these conditions holds:
   * - The default skills policy is not "deny" (allows all skills by default)
   * - At least one individual skill entry has state "allow"
   */
  hasAllowedSkills(agentName?: string): boolean {
    const { merged } = this.resolvePermissions(agentName);
    const defaultPolicy = merged.defaultPolicy.skills;
    if (defaultPolicy !== "deny") {
      return true;
    }
    const skillsRecord = merged.skills || {};
    return Object.values(skillsRecord).some((state) => state === "allow");
  }

  private getConfiguredMcpServerNames(): readonly string[] {
    if (this.configuredMcpServerNamesOverride) {
      return this.configuredMcpServerNamesOverride;
    }

    const paths = [this.globalMcpConfigPath, this.legacyGlobalSettingsPath];
    const stamp = paths.map((path) => `${path}:${getFileStamp(path)}`).join("|");
    if (this.configuredMcpServerNamesCache?.stamp === stamp) {
      return this.configuredMcpServerNamesCache.value;
    }

    const value = getConfiguredMcpServerNamesFromPaths(paths);
    this.configuredMcpServerNamesCache = { stamp, value };
    return value;
  }

  /**
   * Get the tool-level permission state for a tool, without considering command-level rules.
   * This is used for tool injection decisions where we need to know if a tool is allowed/denied
   * at the tool level before checking specific command permissions.
   *
   * Exact-name entries in `tools` work for arbitrary registered extension tools.
   * Canonical Pi tools with dedicated categories still use their specialized fallbacks.
   *
   * @param toolName - The name of the tool (for example "bash", "read", or a third-party tool name)
   * @param agentName - Optional agent name to check agent-specific permissions
   * @returns The permission state for the tool at the tool level
   */
  getToolPermission(toolName: string, agentName?: string): PermissionState {
    const { layers, compiledTools } = this.resolvePermissions(agentName);
    const normalizedToolName = toolName.trim();

    if (SPECIAL_PERMISSION_KEYS.has(normalizedToolName)) {
      return resolveLayeredDefaultPermission(layers, "special")?.state ?? DEFAULT_POLICY.special;
    }

    if (normalizedToolName === "skill") {
      return resolveLayeredDefaultPermission(layers, "skills")?.state ?? DEFAULT_POLICY.skills;
    }

    const toolMatch = findCompiledPermissionMatch(compiledTools, normalizedToolName);

    if (normalizedToolName === "bash") {
      return toolMatch?.state
        ?? resolveLayeredDefaultPermission(layers, "bash")?.state
        ?? DEFAULT_POLICY.bash;
    }

    if (normalizedToolName === "mcp") {
      return toolMatch?.state
        ?? resolveLayeredDefaultPermission(layers, "mcp")?.state
        ?? DEFAULT_POLICY.mcp;
    }

    return toolMatch?.state
      ?? resolveLayeredDefaultPermission(layers, "tools")?.state
      ?? DEFAULT_POLICY.tools;
  }

  checkPermission(toolName: string, input: unknown, agentName?: string): PermissionCheckResult {
    const { merged, layers, compiledTools, compiledSpecial, compiledSkills, compiledMcp, compiledBash, compiledBashRedirect } = this.resolvePermissions(agentName);
    const normalizedToolName = toolName.trim();
    const toolMatch = findCompiledPermissionMatch(compiledTools, normalizedToolName);

    if (SPECIAL_PERMISSION_KEYS.has(normalizedToolName)) {
      const targets = [...createActionResourceTargets(normalizedToolName, input), normalizedToolName];
      const result = findCompiledPermissionMatchByPatternOrderForNames(compiledSpecial, targets);
      return {
        toolName,
        state: result?.state ?? resolveLayeredDefaultPermission(layers, "special")?.state ?? DEFAULT_POLICY.special,
        matchedPattern: result?.matchedPattern,
        target: result?.matchedName,
        source: "special",
      };
    }

    if (normalizedToolName === "skill") {
      const skillName = toRecord(input).name;
      if (typeof skillName === "string") {
        const result = findCompiledPermissionMatch(compiledSkills, skillName);
        return {
          toolName,
          state: result?.state ?? resolveLayeredDefaultPermission(layers, "skills")?.state ?? DEFAULT_POLICY.skills,
          matchedPattern: result?.matchedPattern,
          source: "skill",
        };
      }

      return {
        toolName,
        state: resolveLayeredDefaultPermission(layers, "skills")?.state ?? DEFAULT_POLICY.skills,
        source: "skill",
      };
    }

    if (normalizedToolName === "bash") {
      const record = toRecord(input);
      const command = typeof record.command === "string" ? record.command : "";

      // Segment compound commands (&& || |& ; | & \n) and evaluate each
      // segment independently. Opaque segments (unparseable constructs like
      // $(...) or backticks) skip pattern matching and ALWAYS resolve to
      // "ask" — never the tool default state. The final decision is the most
      // restrictive of all segment results (deny > ask > allow).
      //
      // When a bashRedirect policy is configured, output-redirect targets
      // (>, >>, &>, <>) are matched against redirect patterns; a redirect
      // state more restrictive than the segment's command state wins. fd-dup
      // (2>&1) and input (<) redirects are exempt.
      const toolState =
        toolMatch?.state
        ?? resolveLayeredDefaultPermission(layers, "bash")?.state
        ?? DEFAULT_POLICY.bash;

      const evaluation = evaluateBashCommand(
        command,
        toolState,
        (text) => {
          const match = findCompiledPermissionMatch(compiledBash, text);
          return match ? { state: match.state, matchedPattern: match.matchedPattern } : null;
        },
        compiledBashRedirect.length > 0
          ? (target) => {
              const match = findCompiledPermissionMatch(compiledBashRedirect, target);
              return match ? { state: match.state, matchedPattern: match.matchedPattern } : null;
            }
          : null,
      );

      return {
        toolName,
        state: evaluation.state,
        command,
        matchedPattern: evaluation.matchedPattern,
        target: evaluation.redirectTarget,
        hasOpaqueSegments: evaluation.hasOpaqueSegments,
        source: "bash",
      };
    }

    if (normalizedToolName === "mcp") {
      const mcpTargets = [...createMcpPermissionTargets(input, this.getConfiguredMcpServerNames()), "mcp"];
      const fallbackTarget = mcpTargets[0] || "mcp";
      const defaultMcpState = resolveLayeredDefaultPermission(layers, "mcp")?.state ?? DEFAULT_POLICY.mcp;

      const mcpMatch = findCompiledPermissionMatchForNames(compiledMcp, mcpTargets);
      if (mcpMatch) {
        return {
          toolName,
          state: mcpMatch.state,
          matchedPattern: mcpMatch.matchedPattern,
          target: mcpMatch.matchedName,
          source: "mcp",
        };
      }

      if (toolMatch) {
        return {
          toolName,
          state: toolMatch.state,
          matchedPattern: toolMatch.matchedPattern,
          target: fallbackTarget,
          source: "tool",
        };
      }

      const baselineTarget = mcpTargets.find((target) => MCP_BASELINE_TARGETS.has(target));
      if (baselineTarget) {
        const hasAnyMcpAllowRule = Object.values(merged.mcp || {}).some((state) => state === "allow");
        if (hasAnyMcpAllowRule || defaultMcpState === "allow") {
          return {
            toolName,
            state: "allow",
            target: baselineTarget,
            source: "mcp",
          };
        }
      }

      return {
        toolName,
        state: defaultMcpState,
        target: fallbackTarget,
        source: "default",
      };
    }

    if (BUILT_IN_TOOL_PERMISSION_NAMES.has(normalizedToolName)) {
      const result = findCompiledPermissionMatchByPatternOrderForNames(
        compiledTools,
        [...createActionResourceTargets(normalizedToolName, input), normalizedToolName],
      );
      return {
        toolName,
        state: result?.state
          ?? resolveLayeredDefaultPermission(layers, "tools")?.state
          ?? DEFAULT_POLICY.tools,
        matchedPattern: result?.matchedPattern,
        target: result?.matchedName,
        source: "tool",
      };
    }

    if (toolMatch) {
      return {
        toolName,
        state: toolMatch.state,
        matchedPattern: toolMatch.matchedPattern,
        source: "tool",
      };
    }

    return {
      toolName,
      state: resolveLayeredDefaultPermission(layers, "tools")?.state ?? DEFAULT_POLICY.tools,
      source: "default",
    };
  }
}
