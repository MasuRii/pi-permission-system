import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BashFilter } from "./bash-filter.js";
import { PermissionManager } from "./permission-manager.js";
import { checkRequestedToolRegistration, getToolNameFromValue } from "./tool-registry.js";
import type { GlobalPermissionConfig } from "./types.js";

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

runTest("PermissionManager built-in permission checking", () => {
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

runTest("MCP wildcard matching", () => {
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
      "subagent_*": "ask",
      "subagent_query-*": "allow",
    },
  });

  try {
    const queryDocs = manager.checkPermission("subagent_query-docs", {});
    assert.equal(queryDocs.state, "allow");
    assert.equal(queryDocs.source, "mcp");
    assert.equal(queryDocs.matchedPattern, "subagent_query-*");

    const resolve = manager.checkPermission("subagent_resolve-context", {});
    assert.equal(resolve.state, "ask");
    assert.equal(resolve.matchedPattern, "subagent_*");

    const unknown = manager.checkPermission("web_search_provider", {});
    assert.equal(unknown.state, "deny");
    assert.equal(unknown.matchedPattern, "*");
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

runTest("task uses tool permissions instead of MCP fallback", () => {
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

  const unknownCheck = checkRequestedToolRegistration("subagent_query-docs", registeredTools);
  assert.equal(unknownCheck.status, "unregistered");
  if (unknownCheck.status === "unregistered") {
    assert.deepEqual(unknownCheck.availableToolNames, ["bash", "mcp", "read"]);
  }

  const aliasCheck = checkRequestedToolRegistration("legacy_read", registeredTools, { legacy_read: "read" });
  assert.equal(aliasCheck.status, "registered");

  const missingNameCheck = checkRequestedToolRegistration("   ", registeredTools);
  assert.equal(missingNameCheck.status, "missing-tool-name");
});

runTest("getToolPermission returns tool-level deny for agent with bash: deny", () => {
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
      orchestrator: `---
name: orchestrator
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
    // Tool-level check for bash should return deny for orchestrator
    const bashPermission = manager.getToolPermission("bash", "orchestrator");
    assert.equal(bashPermission, "deny");

    // Tool-level check for task should return allow
    const taskPermission = manager.getToolPermission("task", "orchestrator");
    assert.equal(taskPermission, "allow");

    // Tool-level check for read should return deny
    const readPermission = manager.getToolPermission("read", "orchestrator");
    assert.equal(readPermission, "deny");

    // When no agent specified, should fall back to default policy
    const defaultBashPermission = manager.getToolPermission("bash");
    assert.equal(defaultBashPermission, "ask");

    // Global config tools setting should work
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

console.log("All permission system tests passed.");
