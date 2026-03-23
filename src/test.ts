import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BashFilter } from "./bash-filter.js";
import { DEFAULT_EXTENSION_CONFIG, loadPermissionSystemConfig, savePermissionSystemConfig } from "./extension-config.js";
import { createPermissionSystemLogger } from "./logging.js";
import {
  createPermissionForwardingLocation,
  isForwardedPermissionRequestForSession,
  resolvePermissionForwardingTargetSessionId,
} from "./permission-forwarding.js";
import { PermissionManager } from "./permission-manager.js";
import { checkRequestedToolRegistration, getToolNameFromValue } from "./tool-registry.js";
import type { GlobalPermissionConfig } from "./types.js";
import { canResolveAskPermissionRequest, shouldAutoApprovePermissionState } from "./yolo-mode.js";

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
    cleanup: (): void => {
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

function runTest(name: string, testFn: () => void): void {
  testFn();
  console.log(`[PASS] ${name}`);
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

console.log("All permission system tests passed.");
