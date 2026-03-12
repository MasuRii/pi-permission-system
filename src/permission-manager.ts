import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { BashFilter } from "./bash-filter.js";
import { extractFrontmatter, getNonEmptyString, isPermissionState, parseSimpleYamlMap, toRecord } from "./common.js";
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
  findCompiledWildcardMatchForNames,
  type CompiledWildcardPattern,
} from "./wildcard-matcher.js";

const GLOBAL_CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-permissions.jsonc");
const AGENTS_DIR = join(homedir(), ".pi", "agent", "agents");
const LEGACY_GLOBAL_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const GLOBAL_MCP_CONFIG_PATH = join(homedir(), ".pi", "agent", "mcp.json");

const TOOL_PERMISSION_NAMES = new Set(["bash", "read", "write", "edit", "grep", "find", "ls", "mcp", "task"]);
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
  mcp: {},
  skills: {},
  special: {},
};

function stripJsonComments(input: string): string {
  let output = "";
  let inString = false;
  let stringQuote: '"' | "'" | "" = "";
  let escaping = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const next = input[i + 1] || "";

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        output += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (!inString && char === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }

    if (!inString && char === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    output += char;

    if (!inString && (char === '"' || char === "'")) {
      inString = true;
      stringQuote = char;
      escaping = false;
      continue;
    }

    if (!inString) {
      continue;
    }

    if (escaping) {
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (char === stringQuote) {
      inString = false;
      stringQuote = "";
    }
  }

  return output;
}

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
    const parsed = JSON.parse(stripJsonComments(raw)) as unknown;
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

  const normalized: AgentPermissions = {
    defaultPolicy: normalizePartialPolicy(record.defaultPolicy),
    tools: normalizedTools,
    bash: normalizePermissionRecord(record.bash),
    mcp: normalizePermissionRecord(record.mcp),
    skills: normalizePermissionRecord(record.skills),
    special: normalizePermissionRecord(record.special),
  };

  for (const [key, value] of Object.entries(record)) {
    if (!isPermissionState(value)) {
      continue;
    }

    if (TOOL_PERMISSION_NAMES.has(key)) {
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

type CompiledPermissionPatterns = readonly CompiledWildcardPattern<PermissionState>[];

type ResolvedPermissions = {
  globalConfig: GlobalPermissionConfig;
  agentConfig: AgentPermissions;
  merged: GlobalPermissionConfig;
  compiledSpecial: CompiledPermissionPatterns;
  compiledSkills: CompiledPermissionPatterns;
  compiledMcp: CompiledPermissionPatterns;
  bashFilter: BashFilter;
};

function compilePermissionPatternsFromSources(
  ...sources: Array<Record<string, PermissionState> | undefined>
): CompiledPermissionPatterns {
  const entries: Array<readonly [string, PermissionState]> = [];

  for (const source of sources) {
    if (!source) {
      continue;
    }

    for (const entry of Object.entries(source)) {
      entries.push(entry);
    }
  }

  if (entries.length === 0) {
    return [];
  }

  return compileWildcardPatternEntries(entries);
}

function findCompiledPermissionMatch(patterns: CompiledPermissionPatterns, name: string) {
  if (patterns.length === 0) {
    return null;
  }

  return findCompiledWildcardMatch(patterns, name);
}

function findCompiledPermissionMatchForNames(
  patterns: CompiledPermissionPatterns,
  names: readonly string[],
) {
  if (patterns.length === 0) {
    return null;
  }

  return findCompiledWildcardMatchForNames(patterns, names);
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

export class PermissionManager {
  private readonly globalConfigPath: string;
  private readonly agentsDir: string;
  private readonly legacyGlobalSettingsPath: string;
  private readonly globalMcpConfigPath: string;
  private readonly configuredMcpServerNamesOverride: readonly string[] | null;
  private globalConfigCache: FileCacheEntry<GlobalPermissionConfig> | null = null;
  private readonly agentConfigCache = new Map<string, FileCacheEntry<AgentPermissions>>();
  private readonly resolvedPermissionsCache = new Map<string, FileCacheEntry<ResolvedPermissions>>();
  private configuredMcpServerNamesCache: FileCacheEntry<readonly string[]> | null = null;

  constructor(
    options: {
      globalConfigPath?: string;
      agentsDir?: string;
      legacyGlobalSettingsPath?: string;
      globalMcpConfigPath?: string;
      mcpServerNames?: readonly string[];
    } = {},
  ) {
    this.globalConfigPath = options.globalConfigPath || GLOBAL_CONFIG_PATH;
    this.agentsDir = options.agentsDir || AGENTS_DIR;
    this.legacyGlobalSettingsPath = options.legacyGlobalSettingsPath || LEGACY_GLOBAL_SETTINGS_PATH;
    this.globalMcpConfigPath = options.globalMcpConfigPath || GLOBAL_MCP_CONFIG_PATH;
    this.configuredMcpServerNamesOverride = options.mcpServerNames
      ? [...new Set(options.mcpServerNames.map((name) => name.trim()).filter((name) => name.length > 0))]
      : null;
  }

  private loadGlobalConfig(): GlobalPermissionConfig {
    const stamp = getFileStamp(this.globalConfigPath);
    if (this.globalConfigCache?.stamp === stamp) {
      return this.globalConfigCache.value;
    }

    let value: GlobalPermissionConfig;
    try {
      const raw = readFileSync(this.globalConfigPath, "utf-8");
      const parsed = JSON.parse(stripJsonComments(raw)) as unknown;
      const normalized = normalizeRawPermission(parsed);

      value = {
        defaultPolicy: normalizePolicy(normalized.defaultPolicy),
        tools: normalized.tools || {},
        bash: normalized.bash || {},
        mcp: normalized.mcp || {},
        skills: normalized.skills || {},
        special: normalized.special || {},
      };
    } catch {
      value = EMPTY_GLOBAL_CONFIG;
    }

    this.globalConfigCache = { stamp, value };
    return value;
  }

  private loadAgentPermissions(agentName?: string): AgentPermissions {
    if (!agentName) {
      return {};
    }

    const filePath = join(this.agentsDir, `${agentName}.md`);
    const stamp = getFileStamp(filePath);
    const cached = this.agentConfigCache.get(agentName);
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

    this.agentConfigCache.set(agentName, { stamp, value });
    return value;
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

  private resolvePermissions(agentName?: string): ResolvedPermissions {
    const cacheKey = agentName || "__global__";
    const agentStamp = agentName ? getFileStamp(join(this.agentsDir, `${agentName}.md`)) : "missing";
    const stamp = `${getFileStamp(this.globalConfigPath)}|${agentStamp}`;
    const cached = this.resolvedPermissionsCache.get(cacheKey);
    if (cached?.stamp === stamp) {
      return cached.value;
    }

    const globalConfig = this.loadGlobalConfig();
    const agentConfig = this.loadAgentPermissions(agentName);
    const merged = this.mergePermissions(globalConfig, agentConfig);
    const bashDefault = agentConfig.tools?.bash || merged.tools?.bash || merged.defaultPolicy.bash;
    const value: ResolvedPermissions = {
      globalConfig,
      agentConfig,
      merged,
      compiledSpecial: compilePermissionPatternsFromSources(globalConfig.special, agentConfig.special),
      compiledSkills: compilePermissionPatternsFromSources(globalConfig.skills, agentConfig.skills),
      compiledMcp: compilePermissionPatternsFromSources(globalConfig.mcp, agentConfig.mcp),
      bashFilter: new BashFilter(compilePermissionPatternsFromSources(globalConfig.bash, agentConfig.bash), bashDefault),
    };

    this.resolvedPermissionsCache.set(cacheKey, { stamp, value });
    return value;
  }

  getBashPermissions(agentName?: string): BashPermissions {
    const { merged } = this.resolvePermissions(agentName);
    return merged.bash || {};
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
   * @param toolName - The name of the tool (e.g., "bash", "read", "write")
   * @param agentName - Optional agent name to check agent-specific permissions
   * @returns The permission state for the tool at the tool level
   */
  getToolPermission(toolName: string, agentName?: string): PermissionState {
    const { merged } = this.resolvePermissions(agentName);
    const normalizedToolName = toolName.trim();

    // Handle special permission keys (doom_loop, external_directory)
    if (SPECIAL_PERMISSION_KEYS.has(normalizedToolName)) {
      return merged.defaultPolicy.special;
    }

    // Handle skill tool
    if (normalizedToolName === "skill") {
      return merged.defaultPolicy.skills;
    }

    // For bash tool, return the tool-level permission (not command-level)
    if (normalizedToolName === "bash") {
      return merged.tools?.bash || merged.defaultPolicy.bash;
    }

    // Handle mcp tool
    if (normalizedToolName === "mcp") {
      return merged.tools?.mcp || merged.defaultPolicy.mcp;
    }

    // Handle other tool permission names
    if (TOOL_PERMISSION_NAMES.has(normalizedToolName)) {
      return merged.tools?.[normalizedToolName] || merged.defaultPolicy.tools;
    }

    // For MCP tools (qualified names like "server_tool"), check mcp permissions
    if (normalizedToolName.includes("_")) {
      const mcpMatch = findCompiledPermissionMatch(
        compilePermissionPatternsFromSources(this.loadGlobalConfig().mcp, this.loadAgentPermissions(agentName).mcp),
        normalizedToolName
      );
      if (mcpMatch) {
        return mcpMatch.state;
      }
    }

    // Default to the tools default policy
    return merged.defaultPolicy.tools;
  }

  checkPermission(toolName: string, input: unknown, agentName?: string): PermissionCheckResult {
    const { agentConfig, merged, compiledSpecial, compiledSkills, compiledMcp, bashFilter } = this.resolvePermissions(agentName);
    const normalizedToolName = toolName.trim();

    if (SPECIAL_PERMISSION_KEYS.has(normalizedToolName)) {
      const result = findCompiledPermissionMatch(compiledSpecial, normalizedToolName);
      return {
        toolName,
        state: result?.state || merged.defaultPolicy.special,
        matchedPattern: result?.matchedPattern,
        source: "special",
      };
    }

    if (normalizedToolName === "skill") {
      const skillName = toRecord(input).name;
      if (typeof skillName === "string") {
        const result = findCompiledPermissionMatch(compiledSkills, skillName);
        return {
          toolName,
          state: result?.state || merged.defaultPolicy.skills,
          matchedPattern: result?.matchedPattern,
          source: "skill",
        };
      }

      return {
        toolName,
        state: merged.defaultPolicy.skills,
        source: "skill",
      };
    }

    if (normalizedToolName === "bash") {
      const record = toRecord(input);
      const command = typeof record.command === "string" ? record.command : "";
      const result = bashFilter.check(command);

      return {
        toolName,
        state: result.state,
        command: result.command,
        matchedPattern: result.matchedPattern,
        source: "bash",
      };
    }

    if (normalizedToolName === "mcp") {
      const mcpTargets = [...createMcpPermissionTargets(input, this.getConfiguredMcpServerNames()), "mcp"];
      const fallbackTarget = mcpTargets[0] || "mcp";
      const toolLevelMcpState = merged.tools?.mcp;

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

      if (toolLevelMcpState) {
        return {
          toolName,
          state: toolLevelMcpState,
          target: fallbackTarget,
          source: "tool",
        };
      }

      const baselineTarget = mcpTargets.find((target) => MCP_BASELINE_TARGETS.has(target));
      if (baselineTarget) {
        const hasAnyMcpAllowRule = Object.values(merged.mcp || {}).some((state) => state === "allow");
        if (hasAnyMcpAllowRule || merged.defaultPolicy.mcp === "allow") {
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
        state: merged.defaultPolicy.mcp || "deny",
        target: fallbackTarget,
        source: "default",
      };
    }

    if (TOOL_PERMISSION_NAMES.has(normalizedToolName)) {
      return {
        toolName,
        state: merged.tools?.[normalizedToolName] || merged.defaultPolicy.tools,
        source: "tool",
      };
    }

    const mcpMatch = findCompiledPermissionMatch(compiledMcp, toolName);
    if (mcpMatch) {
      return {
        toolName,
        state: mcpMatch.state,
        matchedPattern: mcpMatch.matchedPattern,
        target: mcpMatch.matchedName,
        source: "mcp",
      };
    }

    return {
      toolName,
      state: merged.defaultPolicy.mcp || "deny",
      target: toolName,
      source: "default",
    };
  }
}
