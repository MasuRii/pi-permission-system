import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { BashFilter } from "../src/bash-filter.js";
import {
  createActiveToolsCacheKey,
  createBeforeAgentStartPromptStateKey,
  shouldApplyCachedAgentStartState,
} from "../src/before-agent-start-cache.js";
import { CONFIG_PATH, DEFAULT_EXTENSION_CONFIG, loadPermissionSystemConfig, savePermissionSystemConfig } from "../src/extension-config.js";
import { createPermissionSystemLogger } from "../src/logging.js";
import {
  createPermissionForwardingLocation,
  isForwardedPermissionRequestForSession,
  resolvePermissionForwardingTargetSessionId,
} from "../src/permission-forwarding.js";
import piPermissionSystemExtension from "../src/index.js";
import { PermissionManager } from "../src/permission-manager.js";
import {
  parseAllSkillPromptSections,
  resolveSkillPromptEntries,
  findSkillPathMatch,
} from "../src/skill-prompt-sanitizer.js";
import { checkRequestedToolRegistration, getToolNameFromValue } from "../src/tool-registry.js";
import { getPermissionSystemStatus } from "../src/status.js";
import { sanitizeAvailableToolsSection } from "../src/system-prompt-sanitizer.js";
import type { AgentPermissions, GlobalPermissionConfig } from "../src/types.js";
import { canResolveAskPermissionRequest, shouldAutoApprovePermissionState } from "../src/yolo-mode.js";
import { runAsyncTest, runTest } from "./test-harness.js";

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

type ExtensionHarness = {
  baseDir: string;
  cwd: string;
  handlers: Record<string, MockHandler>;
  prompts: string[];
  cleanup: () => Promise<void>;
};

type ExtensionHarnessOptions = {
  cwd?: string;
  hasUI?: boolean;
  selectResponse?: string;
  inputResponse?: string;
};

function createToolCallHarness(
  config: GlobalPermissionConfig,
  toolNames: readonly string[],
  options: ExtensionHarnessOptions = {},
): ExtensionHarness {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-runtime-"));
  const cwd = options.cwd || baseDir;
  const prompts: string[] = [];
  const handlers: Record<string, MockHandler> = {};
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalExtensionConfig = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : null;

  mkdirSync(join(baseDir, "agents"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(baseDir, "pi-permissions.jsonc"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  writeFileSync(CONFIG_PATH, `${JSON.stringify(DEFAULT_EXTENSION_CONFIG, null, 2)}\n`, "utf8");

  process.env.PI_CODING_AGENT_DIR = baseDir;
  try {
    piPermissionSystemExtension({
      on: (name: string, handler: MockHandler): void => {
        handlers[name] = handler;
      },
      registerCommand: (): void => {},
      getAllTools: (): Array<{ name: string }> => toolNames.map((name) => ({ name })),
      setActiveTools: (): void => {},
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
    prompts,
    cleanup: async (): Promise<void> => {
      await Promise.resolve(handlers.session_shutdown?.({}, createMockContext(cwd, prompts, options)));
      if (originalExtensionConfig === null) {
        if (existsSync(CONFIG_PATH)) {
          unlinkSync(CONFIG_PATH);
        }
      } else {
        writeFileSync(CONFIG_PATH, originalExtensionConfig, "utf8");
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
      getEntries: (): unknown[] => [],
      getSessionId: (): string => "test-session",
      getSessionDir: (): string => cwd,
    },
    ui: {
      notify: (): void => {},
      setStatus: (): void => {},
      select: async (title: string): Promise<string | undefined> => {
        prompts.push(title);
        return options.selectResponse ?? "Yes";
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

  const result = await Promise.resolve(handler(event, createMockContext(harness.cwd, harness.prompts, options)));
  return (result ?? {}) as Record<string, unknown>;
}

runTest("Permission-system extension config defaults debug off, review log on, and yolo mode off", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-config-"));
  const configPath = join(baseDir, "config.json");

  try {
    const result = loadPermissionSystemConfig(configPath);
    assert.equal(result.created, true);
    assert.equal(result.warning, undefined);
    assert.deepEqual(result.config, DEFAULT_EXTENSION_CONFIG);
    assert.equal(existsSync(configPath), true);

    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    assert.equal(raw.debugLog, false);
    assert.equal(raw.permissionReviewLog, true);
    assert.equal(raw.yoloMode, false);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

runTest("Permission-system extension config loads yolo mode when explicitly enabled", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-config-yolo-"));
  const configPath = join(baseDir, "config.json");

  try {
    writeFileSync(
      configPath,
      `${JSON.stringify({
        debugLog: true,
        permissionReviewLog: false,
        yoloMode: true,
      }, null, 2)}\n`,
      "utf8",
    );

    const result = loadPermissionSystemConfig(configPath);
    assert.equal(result.created, false);
    assert.equal(result.warning, undefined);
    assert.deepEqual(result.config, {
      debugLog: true,
      permissionReviewLog: false,
      yoloMode: true,
    });
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
        debugLog: "true",
        permissionReviewLog: null,
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
        debugLog: true,
        permissionReviewLog: false,
        yoloMode: true,
      },
      configPath,
    );

    assert.equal(saved.success, true);

    const result = loadPermissionSystemConfig(configPath);
    assert.equal(result.warning, undefined);
    assert.deepEqual(result.config, {
      debugLog: true,
      permissionReviewLog: false,
      yoloMode: true,
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

runTest("Permission-system logger respects debug toggle and keeps review log enabled by default", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-logs-"));
  const logsDir = join(baseDir, "logs");
  const debugLogPath = join(logsDir, "debug.jsonl");
  const reviewLogPath = join(logsDir, "review.jsonl");
  const config = { ...DEFAULT_EXTENSION_CONFIG };
  const logger = createPermissionSystemLogger({
    getConfig: () => config,
    debugLogPath,
    reviewLogPath,
    ensureLogsDirectory: () => {
      mkdirSync(logsDir, { recursive: true });
      return undefined;
    },
  });

  try {
    const initialDebugWarning = logger.debug("debug.disabled", { sample: true });
    const reviewWarning = logger.review("permission_request.waiting", { toolName: "write" });

    assert.equal(initialDebugWarning, undefined);
    assert.equal(reviewWarning, undefined);
    assert.equal(existsSync(debugLogPath), false);
    assert.equal(existsSync(reviewLogPath), true);
    assert.match(readFileSync(reviewLogPath, "utf8"), /permission_request\.waiting/);

    config.debugLog = true;
    const enabledDebugWarning = logger.debug("debug.enabled", { sample: true });
    assert.equal(enabledDebugWarning, undefined);
    assert.equal(existsSync(debugLogPath), true);
    assert.match(readFileSync(debugLogPath, "utf8"), /debug\.enabled/);
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
  assert.equal(exact.matchedPattern, "git status");

  const subcommand = filter.check("git status --short");
  assert.equal(subcommand.state, "ask");
  assert.equal(subcommand.matchedPattern, "git status *");

  const generic = filter.check("git commit -m test");
  assert.equal(generic.state, "deny");
  assert.equal(generic.matchedPattern, "git *");
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
    assert.equal(denied.matchedPattern, "rm -rf *");

    const fallback = manager.checkPermission("bash", { command: "echo hello" }, "reviewer");
    assert.equal(fallback.state, "allow");
    assert.equal(fallback.source, "bash");
    assert.equal(fallback.matchedPattern, undefined);
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

runTest("Project-level config overrides base bash patterns", () => {
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
    const allowed = manager.checkPermission("bash", { command: "rm -rf build" });
    assert.equal(allowed.state, "allow");
    assert.equal(allowed.matchedPattern, "rm -rf build");

    const denied = manager.checkPermission("bash", { command: "rm -rf node_modules" });
    assert.equal(denied.state, "deny");
    assert.equal(denied.matchedPattern, "rm -rf *");
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
    assert.equal(allowed.matchedPattern, "git log *");

    const denied = manager.checkPermission("bash", { command: "git status" }, "reviewer");
    assert.equal(denied.state, "deny");
    assert.equal(denied.matchedPattern, "git *");
  } finally {
    cleanup();
  }
});

runTest("Project-agent config overrides system-agent tool rules", () => {
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
    assert.equal(result.state, "allow");
    assert.equal(result.source, "tool");
  } finally {
    cleanup();
  }
});

runTest("Full precedence chain base < project < system-agent < project-agent for defaultPolicy", () => {
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
    assert.equal(globalResult.state, "allow");
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
    assert.deepEqual(result.entries.map((entry) => entry.name), ["visible-skill"], "Tracked skill entries should exclude denied skills");
  } finally {
    cleanup();
  }
});

runTest("REGRESSION: resolveSkillPromptEntries keeps only visible skills available for path matching", () => {
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
    assert.equal(matchedBlockedSkill, null, "Denied skills should not remain in tracked entries");
  } finally {
    cleanup();
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
      { hasUI: true, selectResponse: "Yes" },
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
      { hasUI: true, selectResponse: "No" },
    );

    assert.equal(result.block, true);
    assert.equal(harness.prompts.length, 1);
    assert.match(harness.prompts[0], /weather_lookup/);
    assert.match(harness.prompts[0], /\{"city":"Chicago","units":"metric"\}/);
  } finally {
    await harness.cleanup();
  }
});

console.log("All permission system tests passed.");
