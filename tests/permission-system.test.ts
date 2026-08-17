import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { BashFilter } from "../src/bash-filter.js";
import {
  createActiveToolsCacheKey,
  createBeforeAgentStartPromptStateKey,
  shouldApplyCachedAgentStartState,
} from "../src/before-agent-start-cache.js";
import {
  CONFIG_PATH_ENV_KEY,
  DEFAULT_EXTENSION_CONFIG,
  LOGS_DIR_ENV_KEY,
  loadPermissionSystemConfig,
  normalizePermissionSystemConfig,
  savePermissionSystemConfig,
  type PermissionSystemExtensionConfig,
} from "../src/extension-config.js";
import { createPermissionSystemLogger } from "../src/logging.js";
import {
  createPermissionForwardingLocation,
  isForwardedPermissionRequestForSession,
  PERMISSION_FORWARDING_AGENT_DIR_ENV_KEY,
  PI_AGENT_ROUTER_SHARED_AGENT_DIR_ENV_KEY,
  PI_DELEGATED_AUTH_RUNTIME_DIR_ENV_KEY,
  PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR_ENV_KEY,
  resolvePermissionForwardingRootDir,
  resolvePermissionForwardingTargetSessionId,
  SUBAGENT_ENV_HINT_KEYS,
  SUBAGENT_PARENT_SESSION_ENV_KEY,
} from "../src/permission-forwarding.js";
import piPermissionSystemExtension, { setExtensionConfig, processForwardedPermissionRequests } from "../src/index.js";
import {
  getUnsupportedTemperatureReason,
  stripUnsupportedTemperatureFromPayload,
} from "../src/model-option-compatibility.js";
import { PermissionManager } from "../src/permission-manager.js";
import {
  parseAllSkillPromptSections,
  resolveSkillPromptEntries,
  findSkillPathMatch,
} from "../src/skill-prompt-sanitizer.js";
import { checkRequestedToolRegistration, getToolNameFromValue } from "../src/tool-registry.js";
import { getPermissionSystemStatus } from "../src/status.js";
import { sanitizeAvailableToolsSection } from "../src/system-prompt-sanitizer.js";
import type { AgentPermissions, BashReason, GlobalPermissionConfig } from "../src/types.js";
import { canResolveAskPermissionRequest, shouldAutoApprovePermissionState } from "../src/yolo-mode.js";
import { runAsyncTest, runTest } from "./test-harness.js";

/**
 * The pattern of the segment's command-match reason (undefined when no
 * command rule matched — default-state or opaque results). Bash results now
 * report per-segment reasons instead of a single `matchedPattern`.
 */
function commandPattern(result: { reasons?: BashReason[]; bashReasons?: BashReason[] }): string | undefined {
  const reasons = result.reasons ?? result.bashReasons ?? [];
  const reason = reasons.find((r) => r.kind === "command");
  return reason?.kind === "command" ? reason.pattern : undefined;
}

const TEST_ISOLATED_ENV_KEYS = [
  PERMISSION_FORWARDING_AGENT_DIR_ENV_KEY,
  PI_AGENT_ROUTER_SHARED_AGENT_DIR_ENV_KEY,
  PI_DELEGATED_AUTH_RUNTIME_DIR_ENV_KEY,
  PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR_ENV_KEY,
] as const;

for (const key of TEST_ISOLATED_ENV_KEYS) {
  delete process.env[key];
}

type CreateManagerOptions = {
  mcpServerNames?: readonly string[];
};

function createManager(
  config: GlobalPermissionConfig,
  agentFiles: Record<string, string> = {},
  options: CreateManagerOptions = {},
) {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-test-"));
  const globalConfigPath = join(baseDir, "pi-permissions.jsonc");
  const agentsDir = join(baseDir, "agents");

  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(globalConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  for (const [name, content] of Object.entries(agentFiles)) {
    writeFileSync(join(agentsDir, `${name}.md`), content, "utf8");
  }

  const manager = new PermissionManager({
    globalConfigPath,
    agentsDir,
    mcpServerNames: options.mcpServerNames,
  });

  return {
    manager,
    globalConfigPath,
    cleanup: (): void => {
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

type MockHandler = (
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;

type PermissionSystemRuntimeApi = {
  getYoloMode(): boolean;
  setYoloMode(enabled: boolean, options?: { persist?: boolean; source?: string }): { yoloMode: boolean; changed: boolean; persisted: boolean; error?: string };
  toggleYoloMode(options?: { persist?: boolean; source?: string }): { yoloMode: boolean; changed: boolean; persisted: boolean; error?: string };
};

type GlobalWithPermissionSystem = typeof globalThis & {
  __piPermissionSystem?: PermissionSystemRuntimeApi;
};

type ExtensionHarness = {
  baseDir: string;
  cwd: string;
  handlers: Record<string, MockHandler>;
  registeredEvents: string[];
  prompts: string[];
  debugPath: string;
  cleanup: () => Promise<void>;
};

type ExtensionHarnessOptions = {
  cwd?: string;
  hasUI?: boolean;
  selectResponse?: string;
  inputResponse?: string;
  statusUpdates?: Array<{ key: string; value: string | undefined }>;
  notifications?: Array<{ message: string; level: string }>;
  extensionConfig?: PermissionSystemExtensionConfig;
  activeAgentName?: string | null;
};

const INHERITED_SUBAGENT_ENV_KEYS = [
  ...SUBAGENT_ENV_HINT_KEYS,
  SUBAGENT_PARENT_SESSION_ENV_KEY,
] as const;

async function withIsolatedSubagentEnv<T>(operation: () => Promise<T>): Promise<T> {
  const originalValues = new Map<string, string | undefined>();
  for (const key of INHERITED_SUBAGENT_ENV_KEYS) {
    originalValues.set(key, process.env[key]);
    delete process.env[key];
  }

  try {
    return await operation();
  } finally {
    for (const [key, value] of originalValues.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function readLogUntil(logPath: string, predicate: (content: string) => boolean): Promise<string> {
  let lastContent = "";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (existsSync(logPath)) {
      lastContent = readFileSync(logPath, "utf8");
      if (predicate(lastContent)) {
        return lastContent;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return lastContent;
}

function createToolCallHarness(
  config: GlobalPermissionConfig,
  toolNames: readonly string[],
  options: ExtensionHarnessOptions = {},
): ExtensionHarness {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-runtime-"));
  const cwd = options.cwd || baseDir;
  const prompts: string[] = [];
  const handlers: Record<string, MockHandler> = {};
  const registeredEvents: string[] = [];
  const extensionConfigPath = join(baseDir, "extension-config.json");
  const logsDir = join(baseDir, "extension-logs");
  const debugPath = join(logsDir, "pi-permission-system-debug.jsonl");
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalConfigPath = process.env[CONFIG_PATH_ENV_KEY];
  const originalLogsDir = process.env[LOGS_DIR_ENV_KEY];

  mkdirSync(join(baseDir, "agents"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(baseDir, "pi-permissions.jsonc"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  writeFileSync(
    extensionConfigPath,
    `${JSON.stringify(options.extensionConfig ?? DEFAULT_EXTENSION_CONFIG, null, 2)}\n`,
    "utf8",
  );

  process.env.PI_CODING_AGENT_DIR = baseDir;
  process.env[CONFIG_PATH_ENV_KEY] = extensionConfigPath;
  process.env[LOGS_DIR_ENV_KEY] = logsDir;
  try {
    piPermissionSystemExtension({
      on: (name: string, handler: MockHandler): void => {
        registeredEvents.push(name);
        handlers[name] = handler;
      },
      registerCommand: (): void => {},
      getAllTools: (): Array<{ name: string }> => toolNames.map((name) => ({ name })),
      setActiveTools: (): void => {},
      registerProvider: (): void => {},
      events: {
        emit: (): void => {},
      },
    } as never);
  } finally {
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
  }

  return {
    baseDir,
    cwd,
    handlers,
    registeredEvents,
    prompts,
    debugPath,
    cleanup: async (): Promise<void> => {
      await Promise.resolve(handlers.session_shutdown?.({}, createMockContext(cwd, prompts, options)));
      if (originalConfigPath === undefined) {
        delete process.env[CONFIG_PATH_ENV_KEY];
      } else {
        process.env[CONFIG_PATH_ENV_KEY] = originalConfigPath;
      }
      if (originalLogsDir === undefined) {
        delete process.env[LOGS_DIR_ENV_KEY];
      } else {
        process.env[LOGS_DIR_ENV_KEY] = originalLogsDir;
      }
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

function createMockContext(
  cwd: string,
  prompts: string[],
  options: ExtensionHarnessOptions = {},
): Record<string, unknown> {
  return {
    cwd,
    hasUI: options.hasUI === true,
    sessionManager: {
      getEntries: (): unknown[] => options.activeAgentName === undefined
        ? []
        : [{ type: "custom", customType: "active_agent", data: { name: options.activeAgentName } }],
      getSessionId: (): string => "test-session",
      getSessionDir: (): string => cwd,
    },
    ui: {
      notify: (message: string, level: string): void => {
        options.notifications?.push({ message, level });
      },
      setStatus: (key: string, value: string | undefined): void => {
        options.statusUpdates?.push({ key, value });
      },
      select: async (title: string): Promise<string | undefined> => {
        prompts.push(title);
        return options.selectResponse ?? "Allow Once";
      },
      input: async (): Promise<string | undefined> => options.inputResponse,
    },
  };
}

async function runToolCall(
  harness: ExtensionHarness,
  event: Record<string, unknown>,
  options: ExtensionHarnessOptions = {},
): Promise<Record<string, unknown>> {
  const handler = harness.handlers.tool_call;
  assert.equal(typeof handler, "function");

  const result = await withIsolatedSubagentEnv(async () => Promise.resolve(
    handler(event, createMockContext(harness.cwd, harness.prompts, options)),
  ));
  return (result ?? {}) as Record<string, unknown>;
}

async function runInput(
  harness: ExtensionHarness,
  text: string,
  options: ExtensionHarnessOptions = {},
): Promise<Record<string, unknown>> {
  const handler = harness.handlers.input;
  assert.equal(typeof handler, "function");

  const result = await withIsolatedSubagentEnv(async () => Promise.resolve(
    handler({ text }, createMockContext(harness.cwd, harness.prompts, options)),
  ));
  return (result ?? {}) as Record<string, unknown>;
}

await runAsyncTest("Extension registers only one supported session_start lifecycle handler", async () => {
  const harness = createToolCallHarness({ defaultPolicy: { tools: "allow", bash: "allow", mcp: "allow", skills: "allow", special: "allow" } }, []);

  try {
    assert.equal(harness.registeredEvents.includes("session_switch"), false);
    assert.equal(harness.registeredEvents.filter((eventName) => eventName === "session_start").length, 1);
  } finally {
    await harness.cleanup();
  }
});

await runAsyncTest("Extension exposes a runtime YOLO API for other extensions", async () => {
  const statusUpdates: Array<{ key: string; value: string | undefined }> = [];
  const harness = createToolCallHarness(
    { defaultPolicy: { tools: "allow", bash: "allow", mcp: "allow", skills: "allow", special: "allow" } },
    [],
    { hasUI: true, statusUpdates },
  );

  try {
    const globalScope = globalThis as GlobalWithPermissionSystem;
    const api = globalScope.__piPermissionSystem;
    assert.ok(api);
    assert.equal(api.getYoloMode(), false);

    await Promise.resolve(harness.handlers.session_start?.({ reason: "startup" }, createMockContext(harness.cwd, harness.prompts, { hasUI: true, statusUpdates })));

    const transient = api.toggleYoloMode({ persist: false, source: "test-extension" });
    assert.deepEqual(transient, { yoloMode: true, changed: true, persisted: false });
    assert.equal(loadPermissionSystemConfig().config.yoloMode, false);
    const enabledStatus = statusUpdates.at(-1);
    assert.equal(enabledStatus?.key, "pi-permission-system");
    assert.equal(enabledStatus?.value, "yolo");

    const persisted = api.setYoloMode(false, { source: "test-extension" });
    assert.deepEqual(persisted, { yoloMode: false, changed: true, persisted: true });
    assert.equal(loadPermissionSystemConfig().config.yoloMode, false);
    const disabledStatus = statusUpdates.at(-1);
    assert.equal(disabledStatus?.key, "pi-permission-system");
    assert.equal(disabledStatus?.value, undefined);
  } finally {
    await harness.cleanup();
  }

  assert.equal((globalThis as GlobalWithPermissionSystem).__piPermissionSystem, undefined);
});

await runAsyncTest("Extension dedupes identical permission parse warnings across lifecycle re-entry", async () => {
  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createToolCallHarness(
    { defaultPolicy: { tools: "allow", bash: "allow", mcp: "allow", skills: "allow", special: "allow" } },
    ["read", "write"],
    { hasUI: true, notifications },
  );

  try {
    mkdirSync(join(harness.cwd, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(harness.cwd, ".pi", "agent", "pi-permissions.jsonc"),
      `{
  "tools": {
    "read": "allow",,
  }
}
`,
      "utf8",
    );

    const ctx = createMockContext(harness.cwd, harness.prompts, { hasUI: true, notifications });
    await Promise.resolve(harness.handlers.session_start?.({ reason: "startup" }, ctx));
    await Promise.resolve(harness.handlers.before_agent_start?.({ systemPrompt: "" }, ctx));
    await Promise.resolve(harness.handlers.before_agent_start?.({ systemPrompt: "" }, ctx));

    const warnings = notifications.filter((entry) => entry.level === "warning");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]?.message || "", /Failed to parse permission config at/);
    assert.equal((warnings[0]?.message || "").includes("\n"), false);
  } finally {
    await harness.cleanup();
  }
});

runTest("Permission-system extension config defaults debug and yolo mode off", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-config-"));
  const configPath = join(baseDir, "config.json");

  try {
    const result = loadPermissionSystemConfig(configPath);
    assert.equal(result.created, true);
    assert.equal(result.warning, undefined);
    assert.deepEqual(result.config, DEFAULT_EXTENSION_CONFIG);
    assert.equal(existsSync(configPath), true);

    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(raw).sort(), ["debug", "enabled", "forwardedPromptTimeoutSeconds", "yoloMode"]);
    assert.equal(raw.enabled, true);
    assert.equal(raw.debug, false);
    assert.equal(raw.yoloMode, false);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

runTest("Permission-system extension config loads debug and yolo mode when explicitly enabled", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-config-yolo-"));
  const configPath = join(baseDir, "config.json");

  try {
    writeFileSync(
      configPath,
      `${JSON.stringify({
        debug: true,
        yoloMode: true,
      }, null, 2)}\n`,
      "utf8",
    );

    const result = loadPermissionSystemConfig(configPath);
    assert.equal(result.created, false);
    assert.equal(result.warning, undefined);
    assert.deepEqual(result.config, {
      enabled: true,
      debug: true,
      yoloMode: true,
      forwardedPromptTimeoutSeconds: 30,
    });
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

runTest("Permission-system extension config accepts JSONC comments and trailing commas", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-config-jsonc-"));
  const configPath = join(baseDir, "config.json");

  try {
    writeFileSync(
      configPath,
      `{
  // Local extension toggles
  "debug": true,
  "yoloMode": true,
}
`,
      "utf8",
    );

    const result = loadPermissionSystemConfig(configPath);
    assert.equal(result.created, false);
    assert.equal(result.warning, undefined);
    assert.deepEqual(result.config, {
      enabled: true,
      debug: true,
      yoloMode: true,
      forwardedPromptTimeoutSeconds: 30,
    });
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

runTest("Permission-system extension config reports one-line JSONC parse warnings", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-config-parse-"));
  const configPath = join(baseDir, "config.json");

  try {
    writeFileSync(
      configPath,
      `{
  "debug": true,,
  "yoloMode": false
}
`,
      "utf8",
    );

    const result = loadPermissionSystemConfig(configPath);
    assert.equal(result.created, false);
    assert.deepEqual(result.config, DEFAULT_EXTENSION_CONFIG);
    assert.match(result.warning || "", /Failed to parse permission-system config at/);
    assert.match(result.warning || "", /line 2, column/);
    assert.match(result.warning || "", /using default extension config\./);
    assert.equal((result.warning || "").includes("\n"), false);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

runTest("Permission-system extension config normalizes invalid persisted values back to defaults", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-config-invalid-"));
  const configPath = join(baseDir, "config.json");

  try {
    writeFileSync(
      configPath,
      `${JSON.stringify({
        debug: "true",
        yoloMode: 1,
      }, null, 2)}\n`,
      "utf8",
    );

    const result = loadPermissionSystemConfig(configPath);
    assert.equal(result.created, false);
    assert.equal(result.warning, undefined);
    assert.deepEqual(result.config, DEFAULT_EXTENSION_CONFIG);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

runTest("Permission-system extension config save persists normalized config", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-config-save-"));
  const configPath = join(baseDir, "config.json");

  try {
    const saved = savePermissionSystemConfig(
      {
        debug: true,
        yoloMode: true,
        forwardedPromptTimeoutSeconds: 30,
      },
      configPath,
    );

    assert.equal(saved.success, true);

    const result = loadPermissionSystemConfig(configPath);
    assert.equal(result.warning, undefined);
    assert.deepEqual(result.config, {
      enabled: true,
      debug: true,
      yoloMode: true,
      forwardedPromptTimeoutSeconds: 30,
    });
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

runTest("Yolo mode only auto-approves ask-state permissions", () => {
  assert.equal(shouldAutoApprovePermissionState("ask", DEFAULT_EXTENSION_CONFIG), false);
  assert.equal(
    shouldAutoApprovePermissionState("ask", { ...DEFAULT_EXTENSION_CONFIG, yoloMode: true }),
    true,
  );
  assert.equal(
    shouldAutoApprovePermissionState("deny", { ...DEFAULT_EXTENSION_CONFIG, yoloMode: true }),
    false,
  );
  assert.equal(
    shouldAutoApprovePermissionState("allow", { ...DEFAULT_EXTENSION_CONFIG, yoloMode: true }),
    false,
  );
});

runTest("Yolo mode resolves ask permissions without UI or delegation forwarding", () => {
  assert.equal(
    canResolveAskPermissionRequest({
      config: DEFAULT_EXTENSION_CONFIG,
      hasUI: false,
      isSubagent: false,
    }),
    false,
  );
  assert.equal(
    canResolveAskPermissionRequest({
      config: { ...DEFAULT_EXTENSION_CONFIG, yoloMode: true },
      hasUI: false,
      isSubagent: false,
    }),
    true,
  );
  assert.equal(
    canResolveAskPermissionRequest({
      config: DEFAULT_EXTENSION_CONFIG,
      hasUI: false,
      isSubagent: true,
    }),
    true,
  );
});

runTest("Permission-system status is only exposed when yolo mode is enabled", () => {
  assert.equal(getPermissionSystemStatus(DEFAULT_EXTENSION_CONFIG), undefined);
  assert.equal(
    getPermissionSystemStatus({ ...DEFAULT_EXTENSION_CONFIG, yoloMode: true }),
    "yolo",
  );
});

runTest("System prompt sanitizer removes the Available tools section and surrounding boilerplate", () => {
  const prompt = [
    "Available tools:",
    "- read: Read file contents",
    "- mcp: Discover, inspect, and call MCP tools across configured servers",
    "",
    "In addition to the tools above, you may have access to other custom tools depending on the project.",
    "",
    "Guidelines:",
    "- Use mcp for MCP discovery first: search by capability, describe one exact tool name, then call it.",
    "- Be concise in your responses",
  ].join("\n");

  const result = sanitizeAvailableToolsSection(prompt, ["read", "mcp"]);

  assert.equal(result.removed, true);
  assert.equal(result.prompt.includes("Available tools:"), false);
  assert.equal(result.prompt.includes("In addition to the tools above"), false);
  assert.match(result.prompt, /Guidelines:/);
  assert.match(result.prompt, /Use mcp for MCP discovery first/i);
});

runTest("System prompt sanitizer removes denied tool guidelines while keeping global guidance", () => {
  const prompt = [
    "Guidelines:",
    "- Use task when work SHOULD be delegated to one or more specialized agents instead of handled entirely in the current session.",
    "- Use mcp for MCP discovery first: search by capability, describe one exact tool name, then call it.",
    "- Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)",
    "- Be concise in your responses",
    "- Show file paths clearly when working with files",
  ].join("\n");

  const result = sanitizeAvailableToolsSection(prompt, ["bash", "grep", "mcp"]);

  assert.equal(result.removed, true);
  assert.equal(result.prompt.includes("Use task when work SHOULD"), false);
  assert.match(result.prompt, /Use mcp for MCP discovery first/i);
  assert.match(result.prompt, /Prefer grep\/find\/ls tools over bash/i);
  assert.match(result.prompt, /Be concise in your responses/);
  assert.match(result.prompt, /Show file paths clearly when working with files/);
});

runTest("System prompt sanitizer removes inactive built-in write guidance", () => {
  const prompt = [
    "Guidelines:",
    "- Use write only for new files or complete rewrites",
    "- When summarizing your actions, output plain text directly - do NOT use cat or bash to display what you did",
    "- Be concise in your responses",
  ].join("\n");

  const result = sanitizeAvailableToolsSection(prompt, ["read"]);

  assert.equal(result.removed, true);
  assert.equal(result.prompt.includes("Use write only for new files or complete rewrites"), false);
  assert.equal(result.prompt.includes("do NOT use cat or bash to display what you did"), false);
  assert.match(result.prompt, /Be concise in your responses/);
});

runTest("Before-agent-start cache dedupes unchanged active-tool exposure and prompt state", () => {
  const allowedTools = ["read", "mcp"];
  const activeToolsKey = createActiveToolsCacheKey(allowedTools);
  const promptStateKey = createBeforeAgentStartPromptStateKey({
    agentName: "code",
    cwd: "C:/workspace/project",
    permissionStamp: "permissions-v1",
    systemPrompt: "Available tools:\n- read\n- mcp",
    allowedToolNames: allowedTools,
  });

  assert.equal(shouldApplyCachedAgentStartState(null, activeToolsKey), true);
  assert.equal(shouldApplyCachedAgentStartState(activeToolsKey, activeToolsKey), false);
  assert.equal(shouldApplyCachedAgentStartState(null, promptStateKey), true);
  assert.equal(shouldApplyCachedAgentStartState(promptStateKey, promptStateKey), false);
});

runTest("Before-agent-start prompt cache invalidates on permission changes while runtime enforcement stays authoritative", () => {
  const { manager, globalConfigPath, cleanup } = createManager({
    defaultPolicy: {
      tools: "allow",
      bash: "allow",
      mcp: "allow",
      skills: "allow",
      special: "allow",
    },
    tools: {
      write: "deny",
    },
    bash: {},
    mcp: {},
    skills: {},
    special: {},
  });

  try {
    const baselineStamp = manager.getPolicyCacheStamp();
    const baselineKey = createBeforeAgentStartPromptStateKey({
      agentName: null,
      cwd: "C:/workspace/project",
      permissionStamp: baselineStamp,
      systemPrompt: "Available tools:\n- read\n- write",
      allowedToolNames: ["read"],
    });

    assert.equal(shouldApplyCachedAgentStartState(baselineKey, baselineKey), false);
    assert.equal(manager.checkPermission("write", {}, undefined).state, "deny");

    const updatedConfig = `${JSON.stringify({
      defaultPolicy: {
        tools: "allow",
        bash: "allow",
        mcp: "allow",
        skills: "allow",
        special: "allow",
      },
      tools: {
        write: "allow",
      },
      bash: {},
      mcp: {},
      skills: {},
      special: {},
    }, null, 2)}\n`;

    let updatedStamp = baselineStamp;
    for (let attempt = 0; attempt < 10 && updatedStamp === baselineStamp; attempt += 1) {
      const waitUntil = Date.now() + 2;
      while (Date.now() < waitUntil) {
        // Wait for the filesystem timestamp granularity to advance.
      }

      writeFileSync(globalConfigPath, updatedConfig, "utf8");
      updatedStamp = manager.getPolicyCacheStamp();
    }

    assert.notEqual(updatedStamp, baselineStamp);

    const invalidatedKey = createBeforeAgentStartPromptStateKey({
      agentName: null,
      cwd: "C:/workspace/project",
      permissionStamp: updatedStamp,
      systemPrompt: "Available tools:\n- read\n- write",
      allowedToolNames: ["read", "write"],
    });

    assert.equal(shouldApplyCachedAgentStartState(baselineKey, invalidatedKey), true);
    assert.equal(manager.checkPermission("write", {}, undefined).state, "allow");
  } finally {
    cleanup();
  }
});

await runAsyncTest("before_agent_start returns cached sanitized prompts on repeated identical turns", async () => {
  const harness = createToolCallHarness(
    {
      defaultPolicy: { tools: "allow", bash: "ask", mcp: "ask", skills: "deny", special: "allow" },
      skills: { "allowed-skill": "allow", "blocked-skill": "deny" },
    },
    ["read"],
  );
  const allowedSkillPath = join(harness.cwd, "skills", "allowed", "SKILL.md");
  const blockedSkillPath = join(harness.cwd, "skills", "blocked", "SKILL.md");
  const prompt = [
    '<active_agent name="orchestrator" mode="direct">',
    "<available_skills>",
    "  <skill>",
    "    <name>allowed-skill</name>",
    "    <description>Allowed skill</description>",
    `    <location>${allowedSkillPath}</location>`,
    "  </skill>",
    "  <skill>",
    "    <name>blocked-skill</name>",
    "    <description>Blocked skill</description>",
    `    <location>${blockedSkillPath}</location>`,
    "  </skill>",
    "</available_skills>",
  ].join("\n");

  try {
    const ctx = createMockContext(harness.cwd, harness.prompts);
    const firstResult = await Promise.resolve(harness.handlers.before_agent_start?.({ systemPrompt: prompt }, ctx)) as Record<string, unknown> | undefined;
    const secondResult = await Promise.resolve(harness.handlers.before_agent_start?.({ systemPrompt: prompt }, ctx)) as Record<string, unknown> | undefined;

    for (const result of [firstResult, secondResult]) {
      const systemPrompt = String(result?.systemPrompt ?? "");
      assert.equal(systemPrompt.includes("allowed-skill"), true, "Allowed skill should remain visible");
      assert.equal(systemPrompt.includes("blocked-skill"), false, "Blocked skill should stay hidden on every turn");
      assert.equal(systemPrompt.includes("<available_skills>"), true, "Sanitized skill section should be returned each turn");
    }
  } finally {
    await harness.cleanup();
  }
});

await runAsyncTest("Permission-system logger writes review entries without debug and debug entries only when debug is enabled", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-logs-"));
  const logsDir = join(baseDir, "logs");
  const debugPath = join(logsDir, "debug.jsonl");
  const config = { ...DEFAULT_EXTENSION_CONFIG };
  const logger = createPermissionSystemLogger({
    getConfig: () => config,
    debugPath,
    ensureLogsDirectory: () => {
      mkdirSync(logsDir, { recursive: true });
      return undefined;
    },
  });

  try {
    const initialDebugWarning = logger.debug("debug.disabled", { sample: true });
    const disabledReviewWarning = logger.review("permission_request.waiting", {
      toolName: "bash",
      command: "git status --short",
      commandMetadata: { present: true, length: 18, sha256: "test" },
    });

    assert.equal(initialDebugWarning, undefined);
    assert.equal(disabledReviewWarning, undefined);
    await logger.flush();
    assert.equal(existsSync(debugPath), true);
    const disabledReviewContent = readFileSync(debugPath, "utf8");
    assert.match(disabledReviewContent, /permission_request\.waiting/);
    assert.match(disabledReviewContent, /"stream":"review"/);
    assert.doesNotMatch(disabledReviewContent, /debug\.disabled/);

    config.debug = true;
    const reviewWarning = logger.review("permission_request.waiting", {
      toolName: "bash",
      command: "git status --short",
      commandMetadata: { present: true, length: 18, sha256: "test" },
    });
    assert.equal(reviewWarning, undefined);
    await logger.flush();
    const reviewContent = readFileSync(debugPath, "utf8");
    assert.match(reviewContent, /permission_request\.waiting/);
    assert.match(reviewContent, /"stream":"review"/);
    assert.match(reviewContent, /commandMetadata/);
    assert.match(reviewContent, /"command":"git status --short"/);

    const enabledDebugWarning = logger.debug("debug.enabled", { sample: true });
    assert.equal(enabledDebugWarning, undefined);
    await logger.flush();
    const debugContent = readFileSync(debugPath, "utf8");
    assert.match(debugContent, /debug\.enabled/);
    assert.match(debugContent, /"stream":"debug"/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

runTest("BashFilter uses opencode-style last-match hierarchy", () => {
  const filter = new BashFilter(
    {
      "*": "ask",
      "git *": "deny",
      "git status *": "ask",
      "git status": "allow",
    },
    "deny",
  );

  const exact = filter.check("git status");
  assert.equal(exact.state, "allow");
  assert.equal(commandPattern(exact), "git status");

  const subcommand = filter.check("git status --short");
  assert.equal(subcommand.state, "ask");
  assert.equal(commandPattern(subcommand), "git status *");

  const generic = filter.check("git commit -m test");
  assert.equal(generic.state, "deny");
  assert.equal(commandPattern(generic), "git *");
});

await runAsyncTest("OpenCode-style Allow Once approves only the current request", async () => {
  const harness = createToolCallHarness(
    {
      defaultPolicy: { tools: "allow", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    },
    ["bash"],
  );

  try {
    const first = await runToolCall(
      harness,
      {
        toolName: "bash",
        toolCallId: "allow-once-first",
        input: { command: "git status --short" },
      },
      { hasUI: true, selectResponse: "Allow Once" },
    );
    assert.deepEqual(first, {});

    const second = await runToolCall(harness, {
      toolName: "bash",
      toolCallId: "allow-once-second",
      input: { command: "git status --short" },
    });
    assert.equal(second.block, true);
    assert.match(String(second.reason), /requires approval, but no interactive UI is available/i);
  } finally {
    await harness.cleanup();
  }
});

await runAsyncTest("OpenCode-style Allow Always approves matching requests for this session", async () => {
  const harness = createToolCallHarness(
    {
      defaultPolicy: { tools: "allow", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    },
    ["bash"],
  );

  try {
    const first = await runToolCall(
      harness,
      {
        toolName: "bash",
        toolCallId: "allow-always-first",
        input: { command: "git status --short" },
      },
      { hasUI: true, selectResponse: "Allow Always" },
    );
    assert.deepEqual(first, {});

    const second = await runToolCall(harness, {
      toolName: "bash",
      toolCallId: "allow-always-second",
      input: { command: "git status --short" },
    });
    assert.deepEqual(second, {});
  } finally {
    await harness.cleanup();
  }
});

await runAsyncTest("OpenCode-style Reject with Reason prompts for feedback and returns it to the agent", async () => {
  const harness = createToolCallHarness(
    {
      defaultPolicy: { tools: "allow", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    },
    ["bash"],
  );

  try {
    const result = await runToolCall(
      harness,
      {
        toolName: "bash",
        toolCallId: "reject-with-reason",
        input: { command: "git status --short" },
      },
      { hasUI: true, selectResponse: "Reject with Reason", inputResponse: "Use read-only inspection instead" },
    );

    assert.equal(result.block, true);
    assert.match(String(result.reason), /User denied bash command 'git status --short'\./);
    assert.match(String(result.reason), /Reason: Use read-only inspection instead\./);
  } finally {
    await harness.cleanup();
  }
});

runTest("PermissionManager canonical built-in permission checking", () => {
  const { manager, cleanup } = createManager({
    defaultPolicy: {
      tools: "deny",
      bash: "ask",
      mcp: "ask",
      skills: "ask",
      special: "ask",
    },
    tools: {
      read: "allow",
    },
  });

  try {
    const readResult = manager.checkPermission("read", {});
    assert.equal(readResult.state, "allow");
    assert.equal(readResult.source, "tool");

    const writeResult = manager.checkPermission("write", {});
    assert.equal(writeResult.state, "deny");
    assert.equal(writeResult.source, "tool");
  } finally {
    cleanup();
  }
});

runTest("Bash patterns stay higher priority than tool-level bash fallback", () => {
  const { manager, cleanup } = createManager(
    {
      defaultPolicy: {
        tools: "ask",
        bash: "ask",
        mcp: "ask",
        skills: "ask",
        special: "ask",
      },
      bash: {
        "rm -rf *": "deny",
      },
    },
    {
      reviewer: `---
name: reviewer
permission:
  tools:
    bash: allow
---
`,
    },
  );

  try {
    const denied = manager.checkPermission("bash", { command: "rm -rf build" }, "reviewer");
    assert.equal(denied.state, "deny");
    assert.equal(denied.source, "bash");
    assert.equal(commandPattern(denied), "rm -rf *");

    const fallback = manager.checkPermission("bash", { command: "echo hello" }, "reviewer");
    assert.equal(fallback.state, "allow");
    assert.equal(fallback.source, "bash");
    assert.equal(commandPattern(fallback), undefined);
  } finally {
    cleanup();
  }
});

runTest("MCP wildcard matching uses the registered mcp tool", () => {
  const { manager, cleanup } = createManager({
    defaultPolicy: {
      tools: "ask",
      bash: "ask",
      mcp: "ask",
      skills: "ask",
      special: "ask",
    },
    mcp: {
      "*": "deny",
      "research_*": "ask",
      "research_query-*": "allow",
    },
  });

  try {
    const queryDocs = manager.checkPermission("mcp", { tool: "research:query-docs" });
    assert.equal(queryDocs.state, "allow");
    assert.equal(queryDocs.source, "mcp");
    assert.equal(queryDocs.matchedPattern, "research_query-*");
    assert.equal(queryDocs.target, "research_query-docs");

    const resolve = manager.checkPermission("mcp", { tool: "research:resolve-context" });
    assert.equal(resolve.state, "ask");
    assert.equal(resolve.matchedPattern, "research_*");
    assert.equal(resolve.target, "research_resolve-context");

    const unknown = manager.checkPermission("mcp", { tool: "search:provider" });
    assert.equal(unknown.state, "deny");
    assert.equal(unknown.matchedPattern, "*");
    assert.equal(unknown.target, "search_provider");
  } finally {
    cleanup();
  }
});

runTest("Arbitrary extension tools use exact-name tool permissions instead of MCP fallback", () => {
  const { manager, cleanup } = createManager({
    defaultPolicy: {
      tools: "deny",
      bash: "ask",
      mcp: "allow",
      skills: "ask",
      special: "ask",
    },
    tools: {
      third_party_tool: "allow",
    },
    mcp: {
      "*": "deny",
    },
  });

  try {
    const allowed = manager.checkPermission("third_party_tool", {});
    assert.equal(allowed.state, "allow");
    assert.equal(allowed.source, "tool");

    const fallback = manager.checkPermission("another_extension_tool", {});
    assert.equal(fallback.state, "deny");
    assert.equal(fallback.source, "default");
  } finally {
    cleanup();
  }
});

runTest("Tool permissions support wildcard patterns for extension tools", () => {
  const { manager, cleanup } = createManager({
    defaultPolicy: {
      tools: "deny",
      bash: "ask",
      mcp: "ask",
      skills: "ask",
      special: "ask",
    },
    tools: {
      "*": "ask",
      "context7_*": "allow",
    },
  });

  try {
    const context7 = manager.checkPermission("context7_query-docs", {});
    assert.equal(context7.state, "allow");
    assert.equal(context7.source, "tool");
    assert.equal(context7.matchedPattern, "context7_*");
    assert.equal(manager.getToolPermission("context7_query-docs"), "allow");

    const unknown = manager.checkPermission("unknown_extension_tool", {});
    assert.equal(unknown.state, "ask");
    assert.equal(unknown.source, "tool");
    assert.equal(unknown.matchedPattern, "*");
    assert.equal(manager.getToolPermission("unknown_extension_tool"), "ask");
  } finally {
    cleanup();
  }
});

runTest("Tool permission wildcards use last matching rule wins", () => {
  const { manager, cleanup } = createManager({
    defaultPolicy: {
      tools: "deny",
      bash: "ask",
      mcp: "ask",
      skills: "ask",
      special: "ask",
    },
    tools: {
      "context7_*": "allow",
      "*": "ask",
    },
  });

  try {
    const context7 = manager.checkPermission("context7_query-docs", {});
    assert.equal(context7.state, "ask");
    assert.equal(context7.source, "tool");
    assert.equal(context7.matchedPattern, "*");
  } finally {
    cleanup();
  }
});

runTest("Skill permission matching", () => {
  const { manager, cleanup } = createManager({
    defaultPolicy: {
      tools: "ask",
      bash: "ask",
      mcp: "ask",
      skills: "ask",
      special: "ask",
    },
    skills: {
      "*": "ask",
      "web-*": "deny",
      "requesting-code-review": "allow",
    },
  });

  try {
    const allowed = manager.checkPermission("skill", { name: "requesting-code-review" });
    assert.equal(allowed.state, "allow");
    assert.equal(allowed.matchedPattern, "requesting-code-review");
    assert.equal(allowed.source, "skill");

    const denied = manager.checkPermission("skill", { name: "web-design-guidelines" });
    assert.equal(denied.state, "deny");
    assert.equal(denied.matchedPattern, "web-*");

    const fallback = manager.checkPermission("skill", { name: "unknown-skill" });
    assert.equal(fallback.state, "ask");
    assert.equal(fallback.matchedPattern, "*");
  } finally {
    cleanup();
  }
});

runTest("MCP proxy tool infers server-prefixed aliases from configured server names", () => {
  const { manager, cleanup } = createManager(
    {
      defaultPolicy: {
        tools: "ask",
        bash: "ask",
        mcp: "ask",
        skills: "ask",
        special: "ask",
      },
      mcp: {
        "exa_*": "deny",
        exa_get_code_context_exa: "allow",
      },
    },
    {},
    {
      mcpServerNames: ["exa"],
    },
  );

  try {
    const result = manager.checkPermission("mcp", { tool: "get_code_context_exa" });
    assert.equal(result.state, "allow");
    assert.equal(result.source, "mcp");
    assert.equal(result.matchedPattern, "exa_get_code_context_exa");
    assert.equal(result.target, "exa_get_code_context_exa");
  } finally {
    cleanup();
  }
});

runTest("MCP describe mode normalizes qualified tool names without duplicating server prefixes", () => {
  const { manager, cleanup } = createManager(
    {
      defaultPolicy: {
        tools: "ask",
        bash: "ask",
        mcp: "ask",
        skills: "ask",
        special: "ask",
      },
      mcp: {
        "exa_*": "deny",
        exa_web_search_exa: "allow",
      },
    },
    {},
    {
      mcpServerNames: ["exa"],
    },
  );

  try {
    const result = manager.checkPermission("mcp", { describe: "exa:web_search_exa", server: "exa" });
    assert.equal(result.state, "allow");
    assert.equal(result.source, "mcp");
    assert.equal(result.matchedPattern, "exa_web_search_exa");
    assert.equal(result.target, "exa_web_search_exa");
  } finally {
    cleanup();
  }
});

runTest("Canonical tools map directly without legacy aliases", () => {
  const { manager, cleanup } = createManager({
    defaultPolicy: {
      tools: "ask",
      bash: "ask",
      mcp: "ask",
      skills: "ask",
      special: "ask",
    },
    tools: {
      find: "allow",
      ls: "deny",
    },
  });

  try {
    const findResult = manager.checkPermission("find", {});
    assert.equal(findResult.state, "allow");
    assert.equal(findResult.source, "tool");

    const lsResult = manager.checkPermission("ls", {});
    assert.equal(lsResult.state, "deny");
    assert.equal(lsResult.source, "tool");
  } finally {
    cleanup();
  }
});

runTest("tools.mcp acts as fallback allow for unmatched MCP targets", () => {
  const { manager, cleanup } = createManager(
    {
      defaultPolicy: {
        tools: "ask",
        bash: "ask",
        mcp: "ask",
        skills: "ask",
        special: "ask",
      },
    },
    {
      reviewer: `---
name: reviewer
permission:
  tools:
    mcp: allow
---
`,
    },
  );

  try {
    const result = manager.checkPermission("mcp", { tool: "exa:web_search_exa" }, "reviewer");
    assert.equal(result.state, "allow");
    assert.equal(result.source, "tool");
    assert.equal(result.target, "exa_web_search_exa");
  } finally {
    cleanup();
  }
});

runTest("specific MCP rules override tools.mcp fallback", () => {
  const { manager, cleanup } = createManager(
    {
      defaultPolicy: {
        tools: "ask",
        bash: "ask",
        mcp: "ask",
        skills: "ask",
        special: "ask",
      },
    },
    {
      reviewer: `---
name: reviewer
permission:
  tools:
    mcp: allow
  mcp:
    exa_web_search_exa: deny
---
`,
    },
    {
      mcpServerNames: ["exa"],
    },
  );

  try {
    const result = manager.checkPermission("mcp", { tool: "web_search_exa" }, "reviewer");
    assert.equal(result.state, "deny");
    assert.equal(result.source, "mcp");
    assert.equal(result.matchedPattern, "exa_web_search_exa");
    assert.equal(result.target, "exa_web_search_exa");
  } finally {
    cleanup();
  }
});

runTest("specific MCP rules still win when tools.mcp is deny", () => {
  const { manager, cleanup } = createManager(
    {
      defaultPolicy: {
        tools: "ask",
        bash: "ask",
        mcp: "ask",
        skills: "ask",
        special: "ask",
      },
    },
    {
      reviewer: `---
name: reviewer
permission:
  tools:
    mcp: deny
  mcp:
    exa_web_search_exa: allow
---
`,
    },
    {
      mcpServerNames: ["exa"],
    },
  );

  try {
    const allowed = manager.checkPermission("mcp", { tool: "web_search_exa" }, "reviewer");
    assert.equal(allowed.state, "allow");
    assert.equal(allowed.source, "mcp");
    assert.equal(allowed.matchedPattern, "exa_web_search_exa");
    assert.equal(allowed.target, "exa_web_search_exa");

    const fallback = manager.checkPermission("mcp", { tool: "other_exa" }, "reviewer");
    assert.equal(fallback.state, "deny");
    assert.equal(fallback.source, "tool");
    assert.equal(fallback.target, "exa_other_exa");
  } finally {
    cleanup();
  }
});

runTest("partial agent defaultPolicy overrides preserve global defaults", () => {
  const { manager, cleanup } = createManager(
    {
      defaultPolicy: {
        tools: "deny",
        bash: "deny",
        mcp: "deny",
        skills: "deny",
        special: "deny",
      },
    },
    {
      reviewer: `---
name: reviewer
permission:
  defaultPolicy:
    mcp: allow
---
`,
    },
  );

  try {
    const readResult = manager.checkPermission("read", {}, "reviewer");
    assert.equal(readResult.state, "deny");
    assert.equal(readResult.source, "tool");

    const mcpResult = manager.checkPermission("mcp", { tool: "exa:web_search_exa" }, "reviewer");
    assert.equal(mcpResult.state, "allow");
    assert.equal(mcpResult.source, "default");
  } finally {
    cleanup();
  }
});

runTest("Agent frontmatter canonical tools resolve correctly", () => {
  const { manager, cleanup } = createManager(
    {
      defaultPolicy: {
        tools: "deny",
        bash: "ask",
        mcp: "ask",
        skills: "ask",
        special: "ask",
      },
    },
    {
      reviewer: `---
name: reviewer
permission:
  find: allow
  ls: deny
---
`,
    },
  );

  try {
    const findResult = manager.checkPermission("find", {}, "reviewer");
    assert.equal(findResult.state, "allow");
    assert.equal(findResult.source, "tool");

    const lsResult = manager.checkPermission("ls", {}, "reviewer");
    assert.equal(lsResult.state, "deny");
    assert.equal(lsResult.source, "tool");
  } finally {
    cleanup();
  }
});

runTest("Only canonical built-ins support top-level shorthand in agent frontmatter", () => {
  const { manager, cleanup } = createManager(
    {
      defaultPolicy: {
        tools: "deny",
        bash: "ask",
        mcp: "deny",
        skills: "ask",
        special: "ask",
      },
    },
    {
      reviewer: `---
name: reviewer
permission:
  find: allow
  task: allow
  mcp: allow
---
`,
    },
  );

  try {
    const findResult = manager.checkPermission("find", {}, "reviewer");
    assert.equal(findResult.state, "allow");
    assert.equal(findResult.source, "tool");

    const taskResult = manager.checkPermission("task", {}, "reviewer");
    assert.equal(taskResult.state, "deny");
    assert.equal(taskResult.source, "default");

    const mcpResult = manager.checkPermission("mcp", { tool: "exa:web_search_exa" }, "reviewer");
    assert.equal(mcpResult.state, "deny");
    assert.equal(mcpResult.source, "default");
  } finally {
    cleanup();
  }
});

runTest("task uses exact-name tool permissions like any registered extension tool", () => {
  const { manager, cleanup } = createManager(
    {
      defaultPolicy: {
        tools: "deny",
        bash: "ask",
        mcp: "allow",
        skills: "ask",
        special: "ask",
      },
      tools: {
        task: "allow",
      },
    },
  );

  try {
    const taskResult = manager.checkPermission("task", {});
    assert.equal(taskResult.state, "allow");
    assert.equal(taskResult.source, "tool");
  } finally {
    cleanup();
  }
});

runTest("Tool registry resolves event tool names from string and object payloads", () => {
  assert.equal(getToolNameFromValue("  read  "), "read");
  assert.equal(getToolNameFromValue({ toolName: "write" }), "write");
  assert.equal(getToolNameFromValue({ name: "find" }), "find");
  assert.equal(getToolNameFromValue({ tool: "grep" }), "grep");
  assert.equal(getToolNameFromValue({}), null);
});

runTest("Tool registry blocks unregistered tools and handles aliases", () => {
  const registeredTools = [{ toolName: "mcp" }, { toolName: "read" }, { toolName: "bash" }];

  const unknownCheck = checkRequestedToolRegistration("third_party_tool", registeredTools);
  assert.equal(unknownCheck.status, "unregistered");
  if (unknownCheck.status === "unregistered") {
    assert.deepEqual(unknownCheck.availableToolNames, ["bash", "mcp", "read"]);
  }

  const aliasCheck = checkRequestedToolRegistration("legacy_read", registeredTools, { legacy_read: "read" });
  assert.equal(aliasCheck.status, "registered");

  const missingNameCheck = checkRequestedToolRegistration("   ", registeredTools);
  assert.equal(missingNameCheck.status, "missing-tool-name");
});

runTest("getToolPermission returns tool-level policy for canonical and extension tools", () => {
  const { manager, cleanup } = createManager(
    {
      defaultPolicy: {
        tools: "ask",
        bash: "ask",
        mcp: "ask",
        skills: "ask",
        special: "ask",
      },
    },
    {
      reviewer: `---
name: reviewer
permission:
  tools:
    bash: deny
    read: deny
    task: allow
---
`,
    },
  );

  try {
    const bashPermission = manager.getToolPermission("bash", "reviewer");
    assert.equal(bashPermission, "deny");

    const taskPermission = manager.getToolPermission("task", "reviewer");
    assert.equal(taskPermission, "allow");

    const readPermission = manager.getToolPermission("read", "reviewer");
    assert.equal(readPermission, "deny");

    const defaultBashPermission = manager.getToolPermission("bash");
    assert.equal(defaultBashPermission, "ask");

    const { manager: manager2, cleanup: cleanup2 } = createManager({
      defaultPolicy: {
        tools: "deny",
        bash: "ask",
        mcp: "ask",
        skills: "ask",
        special: "ask",
      },
      tools: {
        bash: "allow",
      },
    });

    try {
      const globalBashPermission = manager2.getToolPermission("bash");
      assert.equal(globalBashPermission, "allow");
    } finally {
      cleanup2();
    }
  } finally {
    cleanup();
  }
});

runTest("hasAllowedSkills detects explicitly allowed skills", () => {
  // Agent with specific allowed skills
  const { manager, cleanup } = createManager(
    {
      defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "deny", special: "ask" },
      skills: { "allowed-skill": "allow" },
    },
    {},
  );

  try {
    assert.equal(manager.hasAllowedSkills(), true);
  } finally {
    cleanup();
  }
});

runTest("hasAllowedSkills returns false when no skills are allowed", () => {
  const { manager, cleanup } = createManager(
    {
      defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "deny", special: "ask" },
    },
    {},
  );

  try {
    assert.equal(manager.hasAllowedSkills(), false);
  } finally {
    cleanup();
  }
});

runTest("hasAllowedSkills returns true when default skills policy is not deny", () => {
  const { manager, cleanup } = createManager(
    {
      defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "allow", special: "ask" },
    },
    {},
  );

  try {
    assert.equal(manager.hasAllowedSkills(), true);
  } finally {
    cleanup();
  }
});

runTest("hasAllowedSkills respects per-agent skill allow overrides", () => {
  const { manager, cleanup } = createManager(
    {
      defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "deny", special: "ask" },
      skills: { "*": "deny", "reviewer-skill": "allow" },
    },
    {},
  );

  try {
    assert.equal(manager.hasAllowedSkills(), true);
  } finally {
    cleanup();
  }
});

runTest("hasAllowedSkills returns false for agent with all denied skills", () => {
  const { manager, cleanup } = createManager(
    {
      defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "deny", special: "ask" },
      skills: { "*": "deny" },
    },
    {},
  );

  try {
    assert.equal(manager.hasAllowedSkills(), false);
  } finally {
    cleanup();
  }
});

runTest("getToolPermission supports arbitrary extension tool names", () => {
  const { manager, cleanup } = createManager({
    defaultPolicy: {
      tools: "deny",
      bash: "ask",
      mcp: "allow",
      skills: "ask",
      special: "ask",
    },
    tools: {
      third_party_tool: "allow",
    },
  });

  try {
    const explicitPermission = manager.getToolPermission("third_party_tool");
    assert.equal(explicitPermission, "allow");

    const fallbackPermission = manager.getToolPermission("missing_extension_tool");
    assert.equal(fallbackPermission, "deny");
  } finally {
    cleanup();
  }
});

runTest("Model option compatibility detects unsupported temperature by api provider and model", () => {
  const cases = [
    {
      model: { api: "openai-codex-responses", id: "gpt-5", provider: "openai", reasoning: false },
      expected: "api 'openai-codex-responses' does not support temperature",
    },
    {
      model: { api: "openai-responses", id: "gpt-5", provider: "openai-codex", reasoning: false },
      expected: "provider 'openai-codex' does not support temperature",
    },
    {
      model: { api: "openai-responses", id: "codex-mini-latest", provider: "openai", reasoning: false },
      expected: "model 'codex-mini-latest' does not support temperature",
    },
    {
      model: { api: "azure-openai-responses", id: "o4-mini", provider: "azure", reasoning: true },
      expected: "reasoning model 'o4-mini' accepts only the provider default temperature",
    },
    {
      model: { api: "openai-responses", id: "gpt-5", provider: "openai", reasoning: false },
      expected: undefined,
    },
  ] as const;

  for (const { model, expected } of cases) {
    assert.equal(getUnsupportedTemperatureReason(model), expected);
  }
});

runTest("Model option compatibility strips unsupported temperature payloads only when present", () => {
  const payload = { messages: [], temperature: 0.2, model: "codex-mini" };
  assert.deepEqual(stripUnsupportedTemperatureFromPayload(payload), {
    messages: [],
    model: "codex-mini",
  });
  assert.deepEqual(payload, { messages: [], temperature: 0.2, model: "codex-mini" });

  const withoutTemperature = { messages: [], model: "gpt-5" };
  assert.equal(stripUnsupportedTemperatureFromPayload(withoutTemperature), withoutTemperature);
  assert.equal(stripUnsupportedTemperatureFromPayload(null), null);
  assert.deepEqual(stripUnsupportedTemperatureFromPayload(["temperature", 0.2]), ["temperature", 0.2]);
});

runTest("Yolo mode bypasses delegated ask routing when no parent forwarding target is available", () => {
  const targetSessionId = resolvePermissionForwardingTargetSessionId({
    hasUI: false,
    isSubagent: true,
    currentSessionId: "child-session",
    env: {},
  });

  assert.equal(targetSessionId, null);
  assert.equal(
    canResolveAskPermissionRequest({
      config: { ...DEFAULT_EXTENSION_CONFIG, yoloMode: true },
      hasUI: false,
      isSubagent: true,
    }),
    true,
  );
  assert.equal(
    shouldAutoApprovePermissionState("ask", { ...DEFAULT_EXTENSION_CONFIG, yoloMode: true }),
    true,
  );
});

runTest("Permission forwarding resolves the parent interactive session from subagent runtime env", () => {
  const targetSessionId = resolvePermissionForwardingTargetSessionId({
    hasUI: false,
    isSubagent: true,
    currentSessionId: "child-session",
    env: {
      PI_AGENT_ROUTER_PARENT_SESSION_ID: "parent-session",
    },
  });

  assert.equal(targetSessionId, "parent-session");
});

runTest("Permission forwarding does not guess a target session when subagent runtime env is missing", () => {
  const targetSessionId = resolvePermissionForwardingTargetSessionId({
    hasUI: false,
    isSubagent: true,
    currentSessionId: "child-session",
    env: {},
  });

  assert.equal(targetSessionId, null);
});

runTest("Permission forwarding root honors explicit shared runtime and default precedence", () => {
  const cases = [
    {
      name: "explicit override",
      options: {
        defaultAgentDir: "/default-agent",
        isSubagent: true,
        env: {
          [PERMISSION_FORWARDING_AGENT_DIR_ENV_KEY]: "/explicit-agent",
          [PI_DELEGATED_AUTH_RUNTIME_DIR_ENV_KEY]: "/delegated-runtime",
          [PI_AGENT_ROUTER_SHARED_AGENT_DIR_ENV_KEY]: "/shared-runtime",
          [PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR_ENV_KEY]: "/policy-agent",
        },
      },
      expectedRoot: "/explicit-agent",
    },
    {
      name: "delegated auth runtime dir",
      options: {
        defaultAgentDir: "/default-agent",
        isSubagent: true,
        env: {
          [PI_DELEGATED_AUTH_RUNTIME_DIR_ENV_KEY]: "/delegated-runtime",
          [PI_AGENT_ROUTER_SHARED_AGENT_DIR_ENV_KEY]: "/shared-runtime",
          [PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR_ENV_KEY]: "/policy-agent",
        },
      },
      expectedRoot: "/delegated-runtime",
    },
    {
      name: "legacy shared runtime dir",
      options: {
        defaultAgentDir: "/default-agent",
        isSubagent: true,
        env: {
          [PI_AGENT_ROUTER_SHARED_AGENT_DIR_ENV_KEY]: "/shared-runtime",
          [PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR_ENV_KEY]: "/policy-agent",
        },
      },
      expectedRoot: "/shared-runtime",
    },
    {
      name: "policy agent dir fallback",
      options: {
        defaultAgentDir: "/isolated-agent-home",
        isSubagent: true,
        env: {
          [PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR_ENV_KEY]: "/policy-agent",
        },
      },
      expectedRoot: "/policy-agent",
    },
    {
      name: "default fallback",
      options: {
        defaultAgentDir: "/default-agent",
        isSubagent: false,
        env: {
          [PI_DELEGATED_AUTH_RUNTIME_DIR_ENV_KEY]: "/delegated-runtime",
          [PI_AGENT_ROUTER_SHARED_AGENT_DIR_ENV_KEY]: "/shared-runtime",
          [PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR_ENV_KEY]: "/policy-agent",
        },
      },
      expectedRoot: "/default-agent",
    },
  ] as const;

  for (const { name, options, expectedRoot } of cases) {
    assert.equal(
      resolvePermissionForwardingRootDir(options),
      join(expectedRoot, "sessions", "permission-forwarding"),
      name,
    );
  }
});

runTest("Permission forwarding uses session-scoped directories per interactive session", () => {
  const forwardingRoot = join(tmpdir(), "pi-permission-system-forwarding-root");
  const sessionA = createPermissionForwardingLocation(forwardingRoot, "session-a");
  const sessionB = createPermissionForwardingLocation(forwardingRoot, "session-b");

  assert.notEqual(sessionA.sessionRootDir, sessionB.sessionRootDir);
  assert.notEqual(sessionA.requestsDir, sessionB.requestsDir);
  assert.notEqual(sessionA.responsesDir, sessionB.responsesDir);
});

runTest("Permission forwarding request routing only matches the intended UI session", () => {
  assert.equal(
    isForwardedPermissionRequestForSession({ targetSessionId: "session-a" }, "session-a"),
    true,
  );
  assert.equal(
    isForwardedPermissionRequestForSession({ targetSessionId: "session-a" }, "session-b"),
    false,
  );
});

runTest("Permission forwarding rejects unresolved sentinel session ids", () => {
  const targetSessionId = resolvePermissionForwardingTargetSessionId({
    hasUI: true,
    isSubagent: false,
    currentSessionId: "unknown",
  });

  assert.equal(targetSessionId, null);
});

type CreateManagerWithProjectOptions = CreateManagerOptions & {
  projectConfig?: AgentPermissions;
  projectAgentFiles?: Record<string, string>;
};

function createManagerWithProject(
  config: GlobalPermissionConfig,
  agentFiles: Record<string, string> = {},
  options: CreateManagerWithProjectOptions = {},
) {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-proj-test-"));
  const globalConfigPath = join(baseDir, "pi-permissions.jsonc");
  const agentsDir = join(baseDir, "agents");
  const projectRoot = join(baseDir, "project");
  const projectGlobalConfigPath = join(projectRoot, "pi-permissions.jsonc");
  const projectAgentsDir = join(projectRoot, "agents");

  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(projectAgentsDir, { recursive: true });

  writeFileSync(globalConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  if (options.projectConfig) {
    writeFileSync(projectGlobalConfigPath, `${JSON.stringify(options.projectConfig, null, 2)}\n`, "utf8");
  }

  for (const [name, content] of Object.entries(agentFiles)) {
    writeFileSync(join(agentsDir, `${name}.md`), content, "utf8");
  }

  for (const [name, content] of Object.entries(options.projectAgentFiles ?? {})) {
    writeFileSync(join(projectAgentsDir, `${name}.md`), content, "utf8");
  }

  const manager = new PermissionManager({
    globalConfigPath,
    agentsDir,
    projectGlobalConfigPath,
    projectAgentsDir,
    mcpServerNames: options.mcpServerNames,
  });

  return {
    manager,
    cleanup: (): void => {
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

runTest("Project-level config cannot relax global bash deny floors", () => {
  const { manager, cleanup } = createManagerWithProject(
    {
      defaultPolicy: {
        tools: "allow",
        bash: "ask",
        mcp: "ask",
        skills: "ask",
        special: "ask",
      },
      bash: {
        "rm -rf *": "deny",
      },
    },
    {},
    {
      projectConfig: {
        bash: {
          "rm -rf build": "allow",
        },
      },
    },
  );

  try {
    const deniedBuild = manager.checkPermission("bash", { command: "rm -rf build" });
    assert.equal(deniedBuild.state, "deny");
    assert.equal(commandPattern(deniedBuild), "rm -rf *");

    const denied = manager.checkPermission("bash", { command: "rm -rf node_modules" });
    assert.equal(denied.state, "deny");
    assert.equal(commandPattern(denied), "rm -rf *");
  } finally {
    cleanup();
  }
});

runTest("System-agent config overrides project-level bash patterns", () => {
  const { manager, cleanup } = createManagerWithProject(
    {
      defaultPolicy: {
        tools: "allow",
        bash: "ask",
        mcp: "ask",
        skills: "ask",
        special: "ask",
      },
    },
    {
      reviewer: `---
name: reviewer
permission:
  bash:
    "git log *": allow
---
`,
    },
    {
      projectConfig: {
        bash: {
          "git *": "deny",
        },
      },
    },
  );

  try {
    const allowed = manager.checkPermission("bash", { command: "git log --oneline" }, "reviewer");
    assert.equal(allowed.state, "allow");
    assert.equal(commandPattern(allowed), "git log *");

    const denied = manager.checkPermission("bash", { command: "git status" }, "reviewer");
    assert.equal(denied.state, "deny");
    assert.equal(commandPattern(denied), "git *");
  } finally {
    cleanup();
  }
});

runTest("Project-agent config cannot relax system-agent tool deny floors", () => {
  const { manager, cleanup } = createManagerWithProject(
    {
      defaultPolicy: {
        tools: "ask",
        bash: "ask",
        mcp: "ask",
        skills: "ask",
        special: "ask",
      },
    },
    {
      reviewer: `---
name: reviewer
permission:
  tools:
    read: deny
---
`,
    },
    {
      projectAgentFiles: {
        reviewer: `---
name: reviewer
permission:
  tools:
    read: allow
---
`,
      },
    },
  );

  try {
    const result = manager.checkPermission("read", {}, "reviewer");
    assert.equal(result.state, "deny");
    assert.equal(result.source, "tool");
  } finally {
    cleanup();
  }
});

runTest("Full precedence chain preserves trusted system-agent overrides while global deny floors constrain project defaults", () => {
  const { manager, cleanup } = createManagerWithProject(
    {
      defaultPolicy: {
        tools: "deny",
        bash: "ask",
        mcp: "ask",
        skills: "ask",
        special: "ask",
      },
    },
    {
      reviewer: `---
name: reviewer
permission:
  defaultPolicy:
    tools: ask
---
`,
    },
    {
      projectConfig: {
        defaultPolicy: {
          tools: "allow",
        },
      },
      projectAgentFiles: {
        reviewer: `---
name: reviewer
permission:
  defaultPolicy:
    tools: deny
---
`,
      },
    },
  );

  try {
    const reviewerResult = manager.checkPermission("custom_extension_tool", {}, "reviewer");
    assert.equal(reviewerResult.state, "deny");
    assert.equal(reviewerResult.source, "default");

    const globalResult = manager.checkPermission("custom_extension_tool", {});
    assert.equal(globalResult.state, "deny");
    assert.equal(globalResult.source, "default");
  } finally {
    cleanup();
  }
});

runTest("Project-agent applies even without a matching system-agent file", () => {
  const { manager, cleanup } = createManagerWithProject(
    {
      defaultPolicy: {
        tools: "allow",
        bash: "ask",
        mcp: "ask",
        skills: "ask",
        special: "ask",
      },
    },
    {},
    {
      projectAgentFiles: {
        reviewer: `---
name: reviewer
permission:
  tools:
    read: deny
---
`,
      },
    },
  );

  try {
    const agentResult = manager.checkPermission("read", {}, "reviewer");
    assert.equal(agentResult.state, "deny");
    assert.equal(agentResult.source, "tool");

    const globalResult = manager.checkPermission("read", {});
    assert.equal(globalResult.state, "allow");
    assert.equal(globalResult.source, "tool");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// PI_CODING_AGENT_DIR support
// ---------------------------------------------------------------------------

runTest("PermissionManager reads config from PI_CODING_AGENT_DIR when set", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-envdir-"));
  const agentsDir = join(baseDir, "agents");
  mkdirSync(agentsDir, { recursive: true });

  const config: GlobalPermissionConfig = {
    defaultPolicy: { tools: "deny", bash: "deny", mcp: "deny", skills: "deny", special: "deny" },
    tools: { read: "allow" },
    bash: {},
    mcp: {},
    skills: {},
    special: {},
  };
  writeFileSync(join(baseDir, "pi-permissions.jsonc"), JSON.stringify(config), "utf8");

  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = baseDir;
  try {
    const manager = new PermissionManager();
    const result = manager.checkPermission("read", {});
    assert.equal(result.state, "allow");

    const result2 = manager.checkPermission("write", {});
    assert.equal(result2.state, "deny");
  } finally {
    if (original !== undefined) {
      process.env.PI_CODING_AGENT_DIR = original;
    } else {
      delete process.env.PI_CODING_AGENT_DIR;
    }
    rmSync(baseDir, { recursive: true, force: true });
  }
});

runTest("PermissionManager accepts JSONC comments and trailing commas in policy files", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-jsonc-"));
  const agentsDir = join(baseDir, "agents");
  const projectRoot = join(baseDir, "project");
  const projectGlobalConfigPath = join(projectRoot, "pi-permissions.jsonc");
  const projectAgentsDir = join(projectRoot, "agents");

  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(projectAgentsDir, { recursive: true });

  writeFileSync(
    join(baseDir, "pi-permissions.jsonc"),
    `{
  // Global defaults still apply.
  "defaultPolicy": {
    "tools": "deny",
    "bash": "deny",
    "mcp": "deny",
    "skills": "deny",
    "special": "deny",
  },
  "tools": {
    "read": "allow",
  },
}
`,
    "utf8",
  );
  writeFileSync(
    projectGlobalConfigPath,
    `{
  "tools": {
    "write": "allow",
  },
}
`,
    "utf8",
  );

  try {
    const manager = new PermissionManager({
      globalConfigPath: join(baseDir, "pi-permissions.jsonc"),
      agentsDir,
      projectGlobalConfigPath,
      projectAgentsDir,
    });

    assert.equal(manager.checkPermission("read", {}).state, "allow");
    assert.equal(manager.checkPermission("write", {}).state, "allow");
    assert.equal(manager.checkPermission("ls", {}).state, "deny");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

runTest("PermissionManager warns once with a one-line fallback warning when a policy file has invalid JSONC", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-invalid-jsonc-"));
  const agentsDir = join(baseDir, "agents");
  const globalConfigPath = join(baseDir, "pi-permissions.jsonc");
  const warnings: string[] = [];

  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    globalConfigPath,
    `{
  "tools": {
    "read": "allow",,
  }
}
`,
    "utf8",
  );

  try {
    const manager = new PermissionManager({
      globalConfigPath,
      agentsDir,
      onWarning: (message) => {
        warnings.push(message);
      },
    });

    assert.equal(manager.checkPermission("read", {}).state, "ask");
    assert.equal(manager.checkPermission("read", {}).state, "ask");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] || "", /Failed to parse permission config at/);
    assert.match(warnings[0] || "", /line 3, column \d+/);
    assert.match(warnings[0] || "", /using ask fallback\./);
    assert.equal((warnings[0] || "").includes("\n"), false);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Skill prompt sanitization - multi-block regression tests
// ---------------------------------------------------------------------------

runTest("parseAllSkillPromptSections finds every available_skills block", () => {
  const prompt = [
    "Some preamble",
    "<available_skills>",
    "  <skill>",
    "    <name>skill-one</name>",
    "    <description>First skill</description>",
    "    <location>/path/to/one</location>",
    "  </skill>",
    "</available_skills>",
    "Some content between",
    "<available_skills>",
    "  <skill>",
    "    <name>skill-two</name>",
    "    <description>Second skill</description>",
    "    <location>/path/to/two</location>",
    "  </skill>",
    "</available_skills>",
    "Footer",
  ].join("\n");

  const sections = parseAllSkillPromptSections(prompt);

  assert.equal(sections.length, 2);
  assert.equal(sections[0].entries[0]?.name, "skill-one");
  assert.equal(sections[1].entries[0]?.name, "skill-two");
});

runTest("REGRESSION: resolveSkillPromptEntries sanitizes every available_skills block", () => {
  const { manager, cleanup } = createManager({
    defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    skills: {
      "visible-skill": "allow",
      "denied-skill": "deny",
    },
  });

  try {
    const prompt = [
      "System prompt start",
      "<available_skills>",
      "  <skill>",
      "    <name>visible-skill</name>",
      "    <description>Allowed skill</description>",
      "    <location>/skills/visible/index.ts</location>",
      "  </skill>",
      "  <skill>",
      "    <name>denied-skill</name>",
      "    <description>Denied in first block</description>",
      "    <location>/skills/blocked/one.ts</location>",
      "  </skill>",
      "</available_skills>",
      "Agent identity section",
      "<available_skills>",
      "  <skill>",
      "    <name>denied-skill</name>",
      "    <description>Denied in second block</description>",
      "    <location>/skills/blocked/two.ts</location>",
      "  </skill>",
      "</available_skills>",
      "System prompt end",
    ].join("\n");

    const result = resolveSkillPromptEntries(prompt, manager, null, "/cwd");

    assert.equal(result.prompt.includes("denied-skill"), false, "Denied skill should be removed from every block");
    assert.equal(result.prompt.includes("visible-skill"), true, "Visible skill should remain in the prompt");
    assert.equal((result.prompt.match(/<available_skills>/g) || []).length, 1, "Fully denied blocks should be removed");
    assert.deepEqual(
      result.entries.map((entry) => `${entry.name}:${entry.state}`),
      ["visible-skill:allow", "denied-skill:deny", "denied-skill:deny"],
      "Tracked skill entries should retain denied skills for path enforcement",
    );
  } finally {
    cleanup();
  }
});

runTest("resolveSkillPromptEntries hides ask skills from the system prompt", () => {
  const { manager, cleanup } = createManager({
    defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    skills: {},
  });

  try {
    const prompt = [
      "System prompt start",
      "<available_skills>",
      "  <skill>",
      "    <name>unlisted-skill</name>",
      "    <description>Not explicitly allowed by active agent frontmatter</description>",
      "    <location>/skills/unlisted/SKILL.md</location>",
      "  </skill>",
      "</available_skills>",
      "System prompt end",
    ].join("\n");

    const result = resolveSkillPromptEntries(prompt, manager, null, "/cwd");

    assert.equal(result.prompt.includes("unlisted-skill"), false, "Ask/unlisted skills should not be advertised");
    assert.equal(result.prompt.includes("<available_skills>"), false, "Empty skill blocks should be removed");
    assert.deepEqual(
      result.entries.map((entry) => `${entry.name}:${entry.state}`),
      ["unlisted-skill:ask"],
      "Ask skills should remain tracked for path enforcement",
    );
  } finally {
    cleanup();
  }
});

runTest("resolveSkillPromptEntries prunes hidden skill routing rows from project instructions", () => {
  const { manager, cleanup } = createManager({
    defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "deny", special: "ask" },
    skills: {
      "allowed-skill": "allow",
      "hidden-skill": "deny",
    },
  });

  try {
    const prompt = [
      "<project_instructions path=\"/workspace/AGENTS.md\">",
      "<skill_routing>",
      "| Task Area | Skill |",
      "| --- | --- |",
      "| Allowed workflow | `allowed-skill` |",
      "| Hidden workflow | `hidden-skill` |",
      "- Load `hidden-skill` before hidden tasks",
      "</skill_routing>",
      "</project_instructions>",
      "<available_skills>",
      "  <skill>",
      "    <name>allowed-skill</name>",
      "    <description>Allowed skill</description>",
      "    <location>/skills/allowed/SKILL.md</location>",
      "  </skill>",
      "  <skill>",
      "    <name>hidden-skill</name>",
      "    <description>Hidden skill</description>",
      "    <location>/skills/hidden/SKILL.md</location>",
      "  </skill>",
      "</available_skills>",
    ].join("\n");

    const result = resolveSkillPromptEntries(prompt, manager, null, "/cwd");

    assert.equal(result.prompt.includes("allowed-skill"), true, "Allowed skill references should remain visible");
    assert.equal(result.prompt.includes("hidden-skill"), false, "Hidden skill references should be pruned from prompt context");
    assert.equal(result.prompt.includes("| Hidden workflow |"), false, "Hidden skill table rows should be removed");
    assert.equal(result.prompt.includes("Load `hidden-skill`"), false, "Hidden skill list items should be removed");
  } finally {
    cleanup();
  }
});

runTest("REGRESSION: resolveSkillPromptEntries keeps denied skills available for path matching", () => {
  const { manager, cleanup } = createManager({
    defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    skills: {
      "blocked-skill": "deny",
    },
  });

  try {
    const prompt = [
      "System prompt start",
      "<available_skills>",
      "  <skill>",
      "    <name>blocked-skill</name>",
      "    <description>Blocked skill</description>",
      "    <location>@./skills/blocked/entry.ts</location>",
      "  </skill>",
      "</available_skills>",
      "Middle section",
      "<available_skills>",
      "  <skill>",
      "    <name>visible-skill</name>",
      "    <description>Visible skill</description>",
      "    <location>@./skills/visible/entry.ts</location>",
      "  </skill>",
      "</available_skills>",
      "System prompt end",
    ].join("\n");

    const result = resolveSkillPromptEntries(prompt, manager, null, "/cwd");
    const visiblePath = resolve("/cwd", "./skills/visible/file.ts");
    const blockedPath = resolve("/cwd", "./skills/blocked/file.ts");
    const matchedVisibleSkill = findSkillPathMatch(process.platform === "win32" ? visiblePath.toLowerCase() : visiblePath, result.entries);
    const matchedBlockedSkill = findSkillPathMatch(process.platform === "win32" ? blockedPath.toLowerCase() : blockedPath, result.entries);

    assert.equal(matchedVisibleSkill?.name, "visible-skill");
    assert.equal(matchedBlockedSkill?.name, "blocked-skill");
    assert.equal(matchedBlockedSkill?.state, "deny");
  } finally {
    cleanup();
  }
});

await runAsyncTest("explicit /skill command overrides agent frontmatter skill deny", async () => {
  const notifications: Array<{ message: string; level: string }> = [];
  const harness = createToolCallHarness(
    {
      defaultPolicy: { tools: "allow", bash: "ask", mcp: "ask", skills: "allow", special: "allow" },
    },
    ["read"],
    { hasUI: true, notifications },
  );
  const deniedByAgentSkillPath = join(harness.cwd, "skills", "frontmatter-denied", "SKILL.md");
  const prompt = [
    '<active_agent name="orchestrator" mode="direct">',
    "<available_skills>",
    "  <skill>",
    "    <name>frontmatter-denied-skill</name>",
    "    <description>Denied only by orchestrator frontmatter</description>",
    `    <location>${deniedByAgentSkillPath}</location>`,
    "  </skill>",
    "</available_skills>",
  ].join("\n");

  try {
    writeFileSync(join(harness.baseDir, "agents", "orchestrator.md"), [
      "---",
      "name: orchestrator",
      "permission:",
      "  skills:",
      "    '*': deny",
      "---",
      "",
    ].join("\n"), "utf8");

    const ctx = createMockContext(harness.cwd, harness.prompts, { hasUI: true, notifications });
    const startResult = await Promise.resolve(harness.handlers.before_agent_start?.({ systemPrompt: prompt }, ctx)) as Record<string, unknown> | undefined;
    assert.equal(String(startResult?.systemPrompt ?? "").includes("frontmatter-denied-skill"), false);

    const inputResult = await runInput(harness, "/skill:frontmatter-denied-skill", { hasUI: true, notifications });
    assert.deepEqual(inputResult, { action: "continue" });
    assert.equal(notifications.length, 0);
    assert.equal(harness.prompts.length, 0);

    const readResult = await runToolCall(harness, {
      toolName: "read",
      toolCallId: "frontmatter-denied-explicit-skill-read",
      input: { path: deniedByAgentSkillPath },
    });
    assert.deepEqual(readResult, {});
  } finally {
    await harness.cleanup();
  }
});

await runAsyncTest("tool_call blocks direct reads of denied skill files even when read is allowed", async () => {
  const harness = createToolCallHarness(
    {
      defaultPolicy: { tools: "allow", bash: "ask", mcp: "ask", skills: "ask", special: "allow" },
      skills: { "blocked-skill": "deny" },
    },
    ["read"],
  );
  const blockedSkillPath = join(harness.cwd, "skills", "blocked", "SKILL.md");
  const prompt = [
    '<active_agent name="orchestrator" mode="direct">',
    "<available_skills>",
    "  <skill>",
    "    <name>blocked-skill</name>",
    "    <description>Blocked skill</description>",
    `    <location>${blockedSkillPath}</location>`,
    "  </skill>",
    "</available_skills>",
  ].join("\n");

  try {
    const ctx = createMockContext(harness.cwd, harness.prompts);
    const startResult = await Promise.resolve(harness.handlers.before_agent_start?.({ systemPrompt: prompt }, ctx)) as Record<string, unknown> | undefined;
    assert.equal(String(startResult?.systemPrompt ?? "").includes("blocked-skill"), false);

    const result = await runToolCall(harness, {
      toolName: "read",
      toolCallId: "skill-read-denied",
      input: { path: blockedSkillPath },
    });

    assert.equal(result.block, true);
    assert.match(String(result.reason), /not permitted to access this skill/);
  } finally {
    await harness.cleanup();
  }
});

await runAsyncTest("tool_call blocks reads below denied skill directories", async () => {
  const harness = createToolCallHarness(
    {
      defaultPolicy: { tools: "allow", bash: "ask", mcp: "ask", skills: "ask", special: "allow" },
      skills: { "blocked-skill": "deny" },
    },
    ["read"],
  );
  const blockedSkillRoot = join(harness.cwd, "skills", "blocked");
  const blockedSkillEntry = join(blockedSkillRoot, "SKILL.md");
  const blockedSkillNestedPath = join(blockedSkillRoot, "references", "notes.md");
  const prompt = [
    '<active_agent name="orchestrator" mode="direct">',
    "<available_skills>",
    "  <skill>",
    "    <name>blocked-skill</name>",
    "    <description>Blocked skill</description>",
    `    <location>${blockedSkillEntry}</location>`,
    "  </skill>",
    "</available_skills>",
  ].join("\n");

  try {
    const ctx = createMockContext(harness.cwd, harness.prompts);
    await Promise.resolve(harness.handlers.before_agent_start?.({ systemPrompt: prompt }, ctx));

    const result = await runToolCall(harness, {
      toolName: "read",
      toolCallId: "skill-read-denied-nested",
      input: { path: blockedSkillNestedPath },
    });

    assert.equal(result.block, true);
    assert.match(String(result.reason), /not permitted to access this skill/);
  } finally {
    await harness.cleanup();
  }
});

await runAsyncTest("tool_call blocks project skill reads even when the skill was absent from the prompt", async () => {
  const harness = createToolCallHarness(
    {
      defaultPolicy: { tools: "allow", bash: "ask", mcp: "ask", skills: "allow", special: "allow" },
      skills: { "hidden-skill": "deny" },
    },
    ["read"],
  );
  const hiddenSkillPath = join(harness.cwd, ".pi", "agent", "skills", "hidden-skill", "SKILL.md");

  try {
    const ctx = createMockContext(harness.cwd, harness.prompts);
    await Promise.resolve(harness.handlers.before_agent_start?.({ systemPrompt: "No skill list in this prompt" }, ctx));

    const result = await runToolCall(harness, {
      toolName: "read",
      toolCallId: "hidden-skill-read-denied",
      input: { path: hiddenSkillPath },
    });

    assert.equal(result.block, true);
    assert.match(String(result.reason), /not permitted to access this skill/);
  } finally {
    await harness.cleanup();
  }
});

await runAsyncTest("tool_call still allows reads for explicitly allowed skill files", async () => {
  const harness = createToolCallHarness(
    {
      defaultPolicy: { tools: "allow", bash: "ask", mcp: "ask", skills: "deny", special: "allow" },
      skills: { "allowed-skill": "allow" },
    },
    ["read"],
  );
  const allowedSkillPath = join(harness.cwd, "skills", "allowed", "SKILL.md");
  const prompt = [
    '<active_agent name="orchestrator" mode="direct">',
    "<available_skills>",
    "  <skill>",
    "    <name>allowed-skill</name>",
    "    <description>Allowed skill</description>",
    `    <location>${allowedSkillPath}</location>`,
    "  </skill>",
    "</available_skills>",
  ].join("\n");

  try {
    const ctx = createMockContext(harness.cwd, harness.prompts);
    const startResult = await Promise.resolve(harness.handlers.before_agent_start?.({ systemPrompt: prompt }, ctx)) as Record<string, unknown> | undefined;
    assert.equal(String(startResult?.systemPrompt ?? prompt).includes("allowed-skill"), true);

    const result = await runToolCall(harness, {
      toolName: "read",
      toolCallId: "skill-read-allowed",
      input: { path: allowedSkillPath },
    });

    assert.deepEqual(result, {});
  } finally {
    await harness.cleanup();
  }
});

await runAsyncTest("tool_call allows read of allowed skill even when read tool is deny", async () => {
  const harness = createToolCallHarness(
    {
      defaultPolicy: { tools: "allow", bash: "ask", mcp: "ask", skills: "deny", special: "allow" },
      tools: { read: "deny" },
      skills: { "allowed-skill": "allow" },
    },
    ["read"],
  );
  const allowedSkillPath = join(harness.cwd, "skills", "allowed", "SKILL.md");
  const prompt = [
    '<active_agent name="orchestrator" mode="direct">',
    "<available_skills>",
    "  <skill>",
    "    <name>allowed-skill</name>",
    "    <description>Allowed skill</description>",
    `    <location>${allowedSkillPath}</location>`,
    "  </skill>",
    "</available_skills>",
  ].join("\n");

  try {
    const ctx = createMockContext(harness.cwd, harness.prompts);
    const startResult = await Promise.resolve(harness.handlers.before_agent_start?.({ systemPrompt: prompt }, ctx)) as Record<string, unknown> | undefined;
    assert.equal(String(startResult?.systemPrompt ?? prompt).includes("allowed-skill"), true);

    const result = await runToolCall(harness, {
      toolName: "read",
      toolCallId: "skill-read-overrides-read-deny",
      input: { path: allowedSkillPath },
    });

    assert.deepEqual(result, {});
  } finally {
    await harness.cleanup();
  }
});

await runAsyncTest("tool_call allows read of allowed skill even when tools default policy is deny", async () => {
  const harness = createToolCallHarness(
    {
      defaultPolicy: { tools: "deny", bash: "ask", mcp: "ask", skills: "deny", special: "allow" },
      skills: { "allowed-skill": "allow" },
    },
    ["read"],
  );
  const allowedSkillPath = join(harness.cwd, "skills", "allowed", "SKILL.md");
  const prompt = [
    '<active_agent name="orchestrator" mode="direct">',
    "<available_skills>",
    "  <skill>",
    "    <name>allowed-skill</name>",
    "    <description>Allowed skill</description>",
    `    <location>${allowedSkillPath}</location>`,
    "  </skill>",
    "</available_skills>",
  ].join("\n");

  try {
    const ctx = createMockContext(harness.cwd, harness.prompts);
    const startResult = await Promise.resolve(harness.handlers.before_agent_start?.({ systemPrompt: prompt }, ctx)) as Record<string, unknown> | undefined;
    assert.equal(String(startResult?.systemPrompt ?? prompt).includes("allowed-skill"), true);

    const result = await runToolCall(harness, {
      toolName: "read",
      toolCallId: "skill-read-overrides-tools-deny",
      input: { path: allowedSkillPath },
    });

    assert.deepEqual(result, {});
  } finally {
    await harness.cleanup();
  }
});

await runAsyncTest("tool_call still blocks read of non-skill file when read tool is deny", async () => {
  const harness = createToolCallHarness(
    {
      defaultPolicy: { tools: "allow", bash: "ask", mcp: "ask", skills: "allow", special: "allow" },
      tools: { read: "deny" },
    },
    ["read"],
  );
  const nonSkillPath = join(harness.cwd, "src", "main.ts");

  try {
    const ctx = createMockContext(harness.cwd, harness.prompts);
    await Promise.resolve(harness.handlers.before_agent_start?.({ systemPrompt: "No skills in this prompt" }, ctx));

    const result = await runToolCall(harness, {
      toolName: "read",
      toolCallId: "non-skill-read-denied",
      input: { path: nonSkillPath },
    });

    assert.equal(result.block, true);
    assert.match(String(result.reason), /not permitted to run 'read'/);
  } finally {
    await harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// external_directory special permission
// ---------------------------------------------------------------------------

runTest("external_directory permission falls back to special default policy when not explicitly configured", () => {
  const { manager, cleanup } = createManager({
    defaultPolicy: {
      tools: "allow",
      bash: "allow",
      mcp: "allow",
      skills: "allow",
      special: "ask",
    },
  });

  try {
    const result = manager.checkPermission("external_directory", {});
    assert.equal(result.state, "ask");
    assert.equal(result.source, "special");
    assert.equal(result.matchedPattern, undefined);
  } finally {
    cleanup();
  }
});

runTest("external_directory permission respects explicit deny in special config", () => {
  const { manager, cleanup } = createManager({
    defaultPolicy: {
      tools: "allow",
      bash: "allow",
      mcp: "allow",
      skills: "allow",
      special: "ask",
    },
    special: {
      external_directory: "deny",
    },
  });

  try {
    const result = manager.checkPermission("external_directory", {});
    assert.equal(result.state, "deny");
    assert.equal(result.source, "special");
    assert.equal(result.matchedPattern, "external_directory");
  } finally {
    cleanup();
  }
});

runTest("external_directory permission can be explicitly allowed", () => {
  const { manager, cleanup } = createManager({
    defaultPolicy: {
      tools: "allow",
      bash: "allow",
      mcp: "allow",
      skills: "allow",
      special: "deny",
    },
    special: {
      external_directory: "allow",
    },
  });

  try {
    const result = manager.checkPermission("external_directory", {});
    assert.equal(result.state, "allow");
    assert.equal(result.source, "special");
    assert.equal(result.matchedPattern, "external_directory");
  } finally {
    cleanup();
  }
});

runTest("external_directory permission respects per-agent override", () => {
  const { manager, cleanup } = createManager(
    {
      defaultPolicy: {
        tools: "allow",
        bash: "allow",
        mcp: "allow",
        skills: "allow",
        special: "ask",
      },
      special: {
        external_directory: "deny",
      },
    },
    {
      trusted: `---
name: trusted
permission:
  special:
    external_directory: allow
---
`,
    },
  );

  try {
    // Global policy denies external_directory
    const globalResult = manager.checkPermission("external_directory", {});
    assert.equal(globalResult.state, "deny");

    // Trusted agent overrides to allow
    const agentResult = manager.checkPermission("external_directory", {}, "trusted");
    assert.equal(agentResult.state, "allow");
    assert.equal(agentResult.source, "special");
  } finally {
    cleanup();
  }
});

runTest("external_directory permission is independent of doom_loop in the same special config", () => {
  const { manager, cleanup } = createManager({
    defaultPolicy: {
      tools: "allow",
      bash: "allow",
      mcp: "allow",
      skills: "allow",
      special: "ask",
    },
    special: {
      doom_loop: "deny",
      external_directory: "allow",
    },
  });

  try {
    const doomResult = manager.checkPermission("doom_loop", {});
    assert.equal(doomResult.state, "deny");
    assert.equal(doomResult.matchedPattern, "doom_loop");

    const extResult = manager.checkPermission("external_directory", {});
    assert.equal(extResult.state, "allow");
    assert.equal(extResult.matchedPattern, "external_directory");
  } finally {
    cleanup();
  }
});

await runAsyncTest("tool_call blocks path-bearing tools outside cwd when external_directory is denied", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "pi-permission-system-boundary-"));
  const cwd = join(rootDir, "repo");
  const siblingPath = join(rootDir, "repo-sibling", "secret.txt");
  mkdirSync(join(rootDir, "repo-sibling"), { recursive: true });

  const harness = createToolCallHarness(
    {
      defaultPolicy: { tools: "allow", bash: "allow", mcp: "allow", skills: "allow", special: "ask" },
      special: { external_directory: "deny" },
    },
    ["read"],
    { cwd },
  );

  try {
    const result = await runToolCall(harness, {
      toolName: "read",
      toolCallId: "external-deny",
      input: { path: siblingPath },
    });

    assert.equal(result.block, true);
    assert.match(String(result.reason), /external directory permission denial/i);
    assert.match(String(result.reason), /repo-sibling/);
  } finally {
    await harness.cleanup();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

await runAsyncTest("tool_call allows path-bearing tools inside cwd without external_directory prompt", async () => {
  const harness = createToolCallHarness(
    {
      defaultPolicy: { tools: "allow", bash: "allow", mcp: "allow", skills: "allow", special: "ask" },
      special: { external_directory: "deny" },
    },
    ["read"],
  );

  try {
    const result = await runToolCall(harness, {
      toolName: "read",
      toolCallId: "internal-allow",
      input: { path: join(harness.cwd, "src", "index.ts") },
    });

    assert.deepEqual(result, {});
    assert.deepEqual(harness.prompts, []);
  } finally {
    await harness.cleanup();
  }
});

await runAsyncTest("tool_call blocks external_directory ask when no confirmation channel is available", async () => {
  const harness = createToolCallHarness(
    {
      defaultPolicy: { tools: "allow", bash: "allow", mcp: "allow", skills: "allow", special: "ask" },
      special: { external_directory: "ask" },
    },
    ["write"],
  );

  try {
    const result = await runToolCall(harness, {
      toolName: "write",
      toolCallId: "external-ask-no-ui",
      input: { path: join(harness.cwd, "..", "outside.txt"), content: "blocked" },
    });

    assert.equal(result.block, true);
    assert.match(String(result.reason), /requires approval, but no interactive UI is available/i);
  } finally {
    await harness.cleanup();
  }
});

await runAsyncTest("tool_call prompts for external_directory and then falls through to normal tool policy", async () => {
  const harness = createToolCallHarness(
    {
      defaultPolicy: { tools: "allow", bash: "allow", mcp: "allow", skills: "allow", special: "ask" },
      special: { external_directory: "ask" },
    },
    ["grep"],
  );

  try {
    const externalPath = join(harness.cwd, "..", "external-search-root");
    const result = await runToolCall(
      harness,
      {
        toolName: "grep",
        toolCallId: "external-ask-approved",
        input: { pattern: "needle", path: externalPath },
      },
      { hasUI: true, selectResponse: "Allow Once" },
    );

    assert.deepEqual(result, {});
    assert.equal(harness.prompts.length, 1);
    assert.match(harness.prompts[0], /external directory access/i);
    assert.match(harness.prompts[0], /grep/);
    assert.match(harness.prompts[0], /external-search-root/);
  } finally {
    await harness.cleanup();
  }
});

await runAsyncTest("tool_call skips external_directory checks for optional path tools without a path", async () => {
  const harness = createToolCallHarness(
    {
      defaultPolicy: { tools: "allow", bash: "allow", mcp: "allow", skills: "allow", special: "ask" },
      special: { external_directory: "deny" },
    },
    ["find"],
  );

  try {
    const result = await runToolCall(harness, {
      toolName: "find",
      toolCallId: "find-default-cwd",
      input: { pattern: "*.ts" },
    });

    assert.deepEqual(result, {});
    assert.deepEqual(harness.prompts, []);
  } finally {
    await harness.cleanup();
  }
});

await runAsyncTest("edit ask prompts summarize structured hashline edits without raw content", async () => {
  const harness = createToolCallHarness(
    {
      defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    },
    ["edit"],
  );

  try {
    const result = await runToolCall(
      harness,
      {
        toolName: "edit",
        toolCallId: "structured-edit-summary",
        input: {
          path: "src/example.ts",
          edits: [
            {
              op: "replace",
              pos: "12#ZP:const before = true;",
              end: "14#MQ:const after = true;",
              lines: ["const secretToken = 'should-not-appear';", "const publicValue = true;"],
            },
            {
              op: "append",
              pos: "20#VR:export {};",
              lines: ["export const ok = true;"],
            },
          ],
        },
      },
      { hasUI: true, selectResponse: "Reject" },
    );

    assert.equal(result.block, true);
    assert.equal(harness.prompts.length, 1);
    assert.match(harness.prompts[0], /tool 'edit'/);
    assert.match(harness.prompts[0], /for 'src\/example\.ts'/);
    assert.match(harness.prompts[0], /2 edits: edit #1 replaces 2 lines at 12#ZP:const before = true; through 14#MQ:const after = true;/);
    assert.match(harness.prompts[0], /plus 1 additional edit/);
    assert.equal(harness.prompts[0].includes("should-not-appear"), false);
  } finally {
    await harness.cleanup();
  }
});

await runAsyncTest("extension structured edit ask prompts use content-safe summaries", async () => {
  const harness = createToolCallHarness(
    {
      defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    },
    ["hashedit"],
  );

  try {
    const result = await runToolCall(
      harness,
      {
        toolName: "hashedit",
        toolCallId: "extension-structured-edit-summary",
        input: {
          path: "src/example.ts",
          edits: [
            {
              op: "append",
              pos: "EOF",
              lines: ["const secretToken = 'should-not-appear';"],
            },
            {
              op: "delete",
              pos: "12#ZP:const before = true;",
              end: "14#MQ:const after = true;",
            },
          ],
        },
      },
      { hasUI: true, selectResponse: "Reject" },
    );

    assert.equal(result.block, true);
    assert.equal(harness.prompts.length, 1);
    assert.match(harness.prompts[0], /tool 'hashedit'/);
    assert.match(harness.prompts[0], /for 'src\/example\.ts'/);
    assert.match(harness.prompts[0], /2 edits: edit #1 appends 1 line after EOF/);
    assert.match(harness.prompts[0], /plus 1 additional edit/);
    assert.equal(harness.prompts[0].includes("should-not-appear"), false);
    assert.doesNotMatch(harness.prompts[0], /\{"path":/);
  } finally {
    await harness.cleanup();
  }
});

await runAsyncTest("extension structured edit tools participate in external_directory checks", async () => {
  const harness = createToolCallHarness(
    {
      defaultPolicy: { tools: "allow", bash: "allow", mcp: "allow", skills: "allow", special: "ask" },
      special: { external_directory: "deny" },
    },
    ["hashedit"],
  );

  try {
    const externalPath = join(harness.cwd, "..", "external-hashline-target.ts");
    const result = await runToolCall(harness, {
      toolName: "hashedit",
      toolCallId: "extension-structured-edit-external",
      input: {
        path: externalPath,
        edits: [{ op: "append", pos: "EOF", lines: ["export const ok = true;"] }],
      },
    });

    assert.equal(result.block, true);
    assert.match(String(result.reason), /external directory/i);
    assert.match(String(result.reason), /hashedit/);
    assert.match(String(result.reason), /external-hashline-target\.ts/);
  } finally {
    await harness.cleanup();
  }
});


await runAsyncTest("generic ask prompts include serialized tool input for informed approval", async () => {
  const harness = createToolCallHarness(
    {
      defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    },
    ["weather_lookup"],
  );

  try {
    const result = await runToolCall(
      harness,
      {
        toolName: "weather_lookup",
        toolCallId: "generic-tool-input",
        input: { city: "Chicago", units: "metric" },
      },
      { hasUI: true, selectResponse: "Reject" },
    );

    assert.equal(result.block, true);
    assert.equal(harness.prompts.length, 1);
    assert.match(harness.prompts[0], /weather_lookup/);
    assert.match(harness.prompts[0], /\{"city":"Chicago","units":"metric"\}/);
  } finally {
    await harness.cleanup();
  }
});

await runAsyncTest("debug review entries include requested bash commands", async () => {
  const harness = createToolCallHarness(
    {
      defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    },
    ["bash"],
    { extensionConfig: { ...DEFAULT_EXTENSION_CONFIG, debug: true } },
  );

  try {
    const result = await runToolCall(harness, {
      toolName: "bash",
      toolCallId: "review-bash-command",
      input: { command: "git status --short" },
    });

    assert.equal(result.block, true);
    const debugContent = await readLogUntil(harness.debugPath, (content) => content.includes("commandMetadata"));
    assert.match(debugContent, /commandMetadata/);
    assert.match(debugContent, /"command":"git status --short"/);
    assert.match(debugContent, /"toolInput":\{"command":"git status --short"\}/);
  } finally {
    await harness.cleanup();
  }
});

await runAsyncTest("debug review entries include raw tool input and responsible agent metadata", async () => {
  const harness = createToolCallHarness(
    {
      defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    },
    ["secret_lookup"],
    { extensionConfig: { ...DEFAULT_EXTENSION_CONFIG, debug: true } },
  );

  try {
    const result = await runToolCall(harness, {
      toolName: "secret_lookup",
      toolCallId: "raw-tool-input",
      input: { token: "super-secret-token", query: "customer record" },
    }, { activeAgentName: "reviewer" });

    assert.equal(result.block, true);
    const debugContent = await readLogUntil(harness.debugPath, (content) => content.includes("toolInput"));
    assert.match(debugContent, /"agentName":"reviewer"/);
    assert.match(debugContent, /Agent 'reviewer' requested tool/);
    assert.match(debugContent, /"toolInput":\{"token":"super-secret-token","query":"customer record"\}/);
    assert.match(debugContent, /super-secret-token/);
    assert.match(debugContent, /customer record/);
  } finally {
    await harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Targeted smoke test: skill read denial via agent-level '*': deny
// ---------------------------------------------------------------------------

await runAsyncTest("TARGETED SMOKE: agent 'code' with '*': deny blocked from reading 'test-driven-development/SKILL.md'", async () => {
  const harness = createToolCallHarness(
    {
      defaultPolicy: { tools: "allow", bash: "ask", mcp: "ask", skills: "allow", special: "allow" },
    },
    ["read"],
  );
  const tddSkillPath = join(harness.cwd, ".pi", "agent", "skills", "test-driven-development", "SKILL.md");

  try {
    writeFileSync(join(harness.baseDir, "agents", "code.md"), [
      "---",
      "name: code",
      "permission:",
      "  skills:",
      "    '*': deny",
      "---",
      "",
    ].join("\n"), "utf8");

    const ctx = createMockContext(harness.cwd, harness.prompts);
    await Promise.resolve(harness.handlers.before_agent_start?.(
      { systemPrompt: '<active_agent name="code" mode="delegated">\nNo skills listed.' },
      ctx,
    ));

    // ---- Check 1: The read IS blocked ----
    const result = await runToolCall(harness, {
      toolName: "read",
      toolCallId: "tdd-skill-read-denied",
      input: { path: tddSkillPath },
    });
    assert.equal(result.block, true, "CHECK 1 FAILED: Read of skill denied via '*': deny must be blocked");
    console.log("  [PASS] CHECK 1: block = true (read correctly denied)");

    // ---- Check 2: Reason does NOT contain the skill name ----
    const reason = String(result.reason ?? "");
    const nameLeaked = reason.includes("test-driven-development");
    console.log("  [CHECK 2] Skill name leaked: " + nameLeaked);
    console.log("  [CHECK 2] Reason text: " + reason);
    assert.equal(nameLeaked, false, "CHECK 2 FAILED: Deny reason leaks the skill name—security concern");

    // ---- Check 3: yoloMode does NOT auto-approve a deny-state read ----
    const { savePermissionSystemConfig, DEFAULT_EXTENSION_CONFIG } = await import("../src/extension-config.js");
    savePermissionSystemConfig({ ...DEFAULT_EXTENSION_CONFIG, yoloMode: true });
    const yoloResult = await runToolCall(harness, {
      toolName: "read",
      toolCallId: "tdd-skill-read-yolo",
      input: { path: tddSkillPath },
    });
    assert.equal(yoloResult.block, true, "CHECK 3 FAILED: yoloMode must NOT auto-approve denied skill read");
    console.log("  [PASS] CHECK 3: yoloMode does NOT auto-approve deny-state read");
    savePermissionSystemConfig({ ...DEFAULT_EXTENSION_CONFIG, yoloMode: false });

    // ---- Check 4: inferSkillEntryFromReadPath correctly identifies the skill ----
    // Non-skill path should NOT be blocked by skill policy
    const nonSkillResult = await runToolCall(harness, {
      toolName: "read",
      toolCallId: "non-skill-check",
      input: { path: join(harness.cwd, "src", "main.ts") },
    });
    assert.deepEqual(nonSkillResult, {}, "CHECK 4 FAILED: Non-skill reads should pass through unblocked");
    // The skill path IS blocked with skill-specific reason (not "not permitted to run 'read'")
    // This proves inference found "test-driven-development"
    assert.equal(reason.includes("not permitted to access this skill"), true, "CHECK 4 FAILED: Block was not skill-specific");
    console.log("  [PASS] CHECK 4: inferSkillEntryFromReadPath correctly identifies 'test-driven-development'");
  } finally {
    await harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Issue #23 Baseline: Current pattern matching behavior before session
// approval features are added.
// ---------------------------------------------------------------------------

runTest("ISSUE23-BASELINE: PermissionManager wildcard star matches zero-or-more", () => {
  const { manager, cleanup } = createManager({
    defaultPolicy: { tools: "deny", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    bash: { "git *": "allow" },
  });
  try {
    const r1 = manager.checkPermission("bash", { command: "git status" });
    assert.equal(r1.state, "allow");
    assert.equal(commandPattern(r1), "git *");

    const r2 = manager.checkPermission("bash", { command: "git commit -m test" });
    assert.equal(r2.state, "allow");
    assert.equal(commandPattern(r2), "git *");
  } finally { cleanup(); }
});

runTest("ISSUE23-BASELINE: PermissionManager last-match-wins with wildcard patterns", () => {
  const { manager, cleanup } = createManager({
    defaultPolicy: { tools: "deny", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    bash: { "git *": "deny", "git status *": "allow", "git status": "deny" },
  });
  try {
    const r1 = manager.checkPermission("bash", { command: "git status" });
    assert.equal(r1.state, "deny");
    assert.equal(commandPattern(r1), "git status");

    const r2 = manager.checkPermission("bash", { command: "git status --short" });
    assert.equal(r2.state, "allow");
    assert.equal(commandPattern(r2), "git status *");
  } finally { cleanup(); }
});

runTest("Permission-system extension config normalizes forwardedPromptTimeoutSeconds", () => {
  assert.equal(
    normalizePermissionSystemConfig({ forwardedPromptTimeoutSeconds: 45 }).forwardedPromptTimeoutSeconds,
    45,
  );
  assert.equal(
    normalizePermissionSystemConfig({ forwardedPromptTimeoutSeconds: null }).forwardedPromptTimeoutSeconds,
    null,
  );
  assert.equal(
    normalizePermissionSystemConfig({ forwardedPromptTimeoutSeconds: false }).forwardedPromptTimeoutSeconds,
    null,
  );
  assert.equal(
    normalizePermissionSystemConfig({}).forwardedPromptTimeoutSeconds,
    30,
  );
  assert.equal(
    normalizePermissionSystemConfig({ forwardedPromptTimeoutSeconds: 0 }).forwardedPromptTimeoutSeconds,
    30,
  );
  assert.equal(
    normalizePermissionSystemConfig({ forwardedPromptTimeoutSeconds: -10 }).forwardedPromptTimeoutSeconds,
    30,
  );
  assert.equal(
    normalizePermissionSystemConfig({ forwardedPromptTimeoutSeconds: "abc" }).forwardedPromptTimeoutSeconds,
    30,
  );
});

await runAsyncTest("Forwarded permission warning is only shown when debug config is true", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-fwd-debug-"));
  const sessionId = "test-session";
  process.env[PERMISSION_FORWARDING_AGENT_DIR_ENV_KEY] = baseDir;

  const location = createPermissionForwardingLocation(
    join(baseDir, "sessions", "permission-forwarding"),
    sessionId,
  );
  mkdirSync(location.requestsDir, { recursive: true });
  mkdirSync(location.responsesDir, { recursive: true });

  const notifications: Array<{ message: string; level: string }> = [];

  try {
    writeFileSync(
      join(location.requestsDir, "req-debug-false.json"),
      JSON.stringify({
        id: "req-debug-false",
        responseNonce: "nonce-f",
        createdAt: Date.now(),
        requesterSessionId: "sub-session",
        targetSessionId: sessionId,
        requesterAgentName: "git",
        message: "Allow read?",
      }),
      "utf8",
    );

    setExtensionConfig({ debug: false, yoloMode: false, forwardedPromptTimeoutSeconds: 30 });
    await processForwardedPermissionRequests(
      createMockContext(baseDir, [], { hasUI: true, notifications }) as never,
      { preserveLocation: true },
    );

    const warningNotifications = notifications.filter(
      (n) => n.level === "warning" && n.message.includes("waiting for permission approval"),
    );
    assert.equal(warningNotifications.length, 0, "Should not show warning when debug is false");

    writeFileSync(
      join(location.requestsDir, "req-debug-true.json"),
      JSON.stringify({
        id: "req-debug-true",
        responseNonce: "nonce-t",
        createdAt: Date.now(),
        requesterSessionId: "sub-session",
        targetSessionId: sessionId,
        requesterAgentName: "git",
        message: "Allow read?",
      }),
      "utf8",
    );

    setExtensionConfig({ debug: true, yoloMode: false, forwardedPromptTimeoutSeconds: 30 });
    await processForwardedPermissionRequests(
      createMockContext(baseDir, [], { hasUI: true, notifications }) as never,
      { preserveLocation: true },
    );

    const warningNotificationsDebug = notifications.filter(
      (n) => n.level === "warning" && n.message.includes("waiting for permission approval"),
    );
    assert.equal(warningNotificationsDebug.length, 1, "Should show exactly one warning when debug is true");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
    delete process.env[PERMISSION_FORWARDING_AGENT_DIR_ENV_KEY];
  }
});

await runAsyncTest("Forwarded permission prompt reflects configured timeout", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-fwd-timeout-"));
  const sessionId = "test-session";
  process.env[PERMISSION_FORWARDING_AGENT_DIR_ENV_KEY] = baseDir;

  const location = createPermissionForwardingLocation(
    join(baseDir, "sessions", "permission-forwarding"),
    sessionId,
  );
  mkdirSync(location.requestsDir, { recursive: true });
  mkdirSync(location.responsesDir, { recursive: true });

  try {
    const prompts45: string[] = [];
    writeFileSync(
      join(location.requestsDir, "req-timeout-45.json"),
      JSON.stringify({
        id: "req-timeout-45",
        responseNonce: "nonce-45",
        createdAt: Date.now(),
        requesterSessionId: "sub-session",
        targetSessionId: sessionId,
        requesterAgentName: "git",
        message: "Allow read?",
      }),
      "utf8",
    );

    setExtensionConfig({ debug: false, yoloMode: false, forwardedPromptTimeoutSeconds: 45 });
    await processForwardedPermissionRequests(
      createMockContext(baseDir, prompts45, { hasUI: true, selectResponse: "Allow Once" }) as never,
      { preserveLocation: true },
    );

    assert.ok(
      prompts45.some((p) => p.includes("45 seconds")),
      `Expected prompt to include "45 seconds", got: ${prompts45.join("\n")}`,
    );

    const promptsUnlimited: string[] = [];
    writeFileSync(
      join(location.requestsDir, "req-timeout-unlimited.json"),
      JSON.stringify({
        id: "req-timeout-unlimited",
        responseNonce: "nonce-ul",
        createdAt: Date.now(),
        requesterSessionId: "sub-session",
        targetSessionId: sessionId,
        requesterAgentName: "git",
        message: "Allow read?",
      }),
      "utf8",
    );

    setExtensionConfig({ debug: false, yoloMode: false, forwardedPromptTimeoutSeconds: null });
    await processForwardedPermissionRequests(
      createMockContext(baseDir, promptsUnlimited, { hasUI: true, selectResponse: "Allow Once" }) as never,
      { preserveLocation: true },
    );

    assert.ok(
      promptsUnlimited.some((p) => p.includes("indefinitely")),
      `Expected prompt to include "indefinitely", got: ${promptsUnlimited.join("\n")}`,
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
    delete process.env[PERMISSION_FORWARDING_AGENT_DIR_ENV_KEY];
  }
});

console.log("All permission system tests passed.");
