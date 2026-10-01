import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveActiveTools } from "../src/active-tools.js";
import { CONFIG_PATH_ENV_KEY, DEFAULT_EXTENSION_CONFIG, LOGS_DIR_ENV_KEY } from "../src/extension-config.js";
import piPermissionSystemExtension from "../src/index.js";

type MockHandler = (...args: any[]) => unknown;

let failures = 0;

async function runTest(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`[PASS] ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`[FAIL] ${name}`);
    console.error(error);
  }
}

const REGISTERED = new Set(["read", "bash", "edit", "write", "grep", "codemode", "tool_search", "powershell", "mcp_search"]);

await runTest("resolveActiveTools keeps the active set when nothing is denied", () => {
  const result = resolveActiveTools({
    activeToolNames: ["read", "bash", "edit", "write"],
    registeredToolNames: REGISTERED,
    hiddenByPolicy: new Set(),
    isToolExposed: () => true,
  });
  assert.deepEqual(result.activeToolNames, ["read", "bash", "edit", "write"]);
  assert.equal(result.changed, false);
  assert.equal(result.hiddenByPolicy.size, 0);
});

await runTest("resolveActiveTools never adds inactive registered tools", () => {
  const result = resolveActiveTools({
    activeToolNames: ["read", "bash"],
    registeredToolNames: REGISTERED,
    hiddenByPolicy: new Set(),
    isToolExposed: () => true,
  });
  assert.deepEqual(result.activeToolNames, ["read", "bash"]);
  assert.equal(result.changed, false);
});

await runTest("resolveActiveTools removes denied tools and remembers them", () => {
  const result = resolveActiveTools({
    activeToolNames: ["read", "powershell", "bash"],
    registeredToolNames: REGISTERED,
    hiddenByPolicy: new Set(),
    isToolExposed: (name) => name !== "powershell",
  });
  assert.deepEqual(result.activeToolNames, ["read", "bash"]);
  assert.equal(result.changed, true);
  assert.deepEqual([...result.hiddenByPolicy], ["powershell"]);
});

await runTest("resolveActiveTools restores a tool it hid once policy allows it", () => {
  const result = resolveActiveTools({
    activeToolNames: ["read", "bash"],
    registeredToolNames: REGISTERED,
    hiddenByPolicy: new Set(["powershell"]),
    isToolExposed: () => true,
  });
  assert.deepEqual(result.activeToolNames, ["read", "bash", "powershell"]);
  assert.equal(result.changed, true);
  assert.equal(result.hiddenByPolicy.size, 0);
});

await runTest("resolveActiveTools keeps a hidden tool hidden while still denied or unregistered", () => {
  const result = resolveActiveTools({
    activeToolNames: ["read"],
    registeredToolNames: new Set(["read", "powershell"]),
    hiddenByPolicy: new Set(["powershell", "mcp_gone"]),
    isToolExposed: (name) => name !== "powershell",
  });
  assert.deepEqual(result.activeToolNames, ["read"]);
  assert.equal(result.changed, false);
  assert.deepEqual([...result.hiddenByPolicy].sort(), ["mcp_gone", "powershell"]);
});

await runTest("resolveActiveTools leaves unregistered active names to Pi", () => {
  const result = resolveActiveTools({
    activeToolNames: ["read", "unknown_tool"],
    registeredToolNames: new Set(["read"]),
    hiddenByPolicy: new Set(),
    isToolExposed: () => false,
  });
  assert.deepEqual(result.activeToolNames, ["unknown_tool"]);
  assert.equal(result.changed, true);
});

type Harness = {
  handlers: Record<string, MockHandler>;
  active: string[];
  setActiveToolsCalls: string[][];
  writePolicy: (config: Record<string, unknown>) => void;
  ctx: Record<string, unknown>;
  cleanup: () => Promise<void>;
};

function createHarness(config: Record<string, unknown>, registered: readonly string[], initialActive: readonly string[]): Harness {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-active-tools-"));
  const saved = {
    agentDir: process.env.PI_CODING_AGENT_DIR,
    configPath: process.env[CONFIG_PATH_ENV_KEY],
    logsDir: process.env[LOGS_DIR_ENV_KEY],
  };
  const extensionConfigPath = join(baseDir, "extension-config.json");
  const writePolicy = (policy: Record<string, unknown>): void => {
    writeFileSync(join(baseDir, "pi-permissions.jsonc"), `${JSON.stringify(policy, null, 2)}\n`, "utf8");
  };

  mkdirSync(join(baseDir, "agents"), { recursive: true });
  writePolicy(config);
  writeFileSync(extensionConfigPath, `${JSON.stringify(DEFAULT_EXTENSION_CONFIG, null, 2)}\n`, "utf8");
  process.env.PI_CODING_AGENT_DIR = baseDir;
  process.env[CONFIG_PATH_ENV_KEY] = extensionConfigPath;
  process.env[LOGS_DIR_ENV_KEY] = join(baseDir, "logs");

  const handlers: Record<string, MockHandler> = {};
  const harness: Harness = {
    handlers,
    active: [...initialActive],
    setActiveToolsCalls: [],
    writePolicy,
    ctx: {
      cwd: baseDir,
      hasUI: false,
      sessionManager: {
        getEntries: (): unknown[] => [],
        getSessionId: (): string => "test-session",
        getSessionDir: (): string => baseDir,
      },
      ui: { notify: (): void => {}, setStatus: (): void => {} },
    },
    cleanup: async (): Promise<void> => {
      await Promise.resolve(handlers.session_shutdown?.({}, harness.ctx));
      for (const [key, value] of [
        ["PI_CODING_AGENT_DIR", saved.agentDir],
        [CONFIG_PATH_ENV_KEY, saved.configPath],
        [LOGS_DIR_ENV_KEY, saved.logsDir],
      ] as const) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      rmSync(baseDir, { recursive: true, force: true });
    },
  };

  piPermissionSystemExtension({
    on: (name: string, handler: MockHandler): void => {
      handlers[name] = handler;
    },
    registerCommand: (): void => {},
    getAllTools: () => registered.map((name) => ({ name })),
    getActiveTools: () => [...harness.active],
    setActiveTools: (names: string[]): void => {
      harness.setActiveToolsCalls.push([...names]);
      harness.active = [...names];
    },
    registerProvider: (): void => {},
    events: { emit: (): void => {} },
  } as never);

  return harness;
}

const REGISTERED_TOOLS = ["read", "bash", "edit", "write", "grep", "codemode", "tool_search", "powershell", "mcp_search"];
const POLICY = {
  defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
  tools: { read: "allow", codemode: "allow", tool_search: "allow", powershell: "deny" },
};

async function startTurn(harness: Harness): Promise<void> {
  await Promise.resolve(harness.handlers.before_agent_start?.({ systemPrompt: "" }, harness.ctx));
}

await runTest("before_agent_start does not activate inactive codemode, tool_search, or deferred tools", async () => {
  const harness = createHarness(POLICY, REGISTERED_TOOLS, ["read", "bash", "edit", "write"]);
  try {
    await Promise.resolve(harness.handlers.session_start?.({ reason: "startup" }, harness.ctx));
    await startTurn(harness);
    await startTurn(harness);
    assert.deepEqual(harness.setActiveToolsCalls, []);
    assert.deepEqual(harness.active, ["read", "bash", "edit", "write"]);
  } finally {
    await harness.cleanup();
  }
});

await runTest("before_agent_start removes a denied active tool once", async () => {
  const harness = createHarness(POLICY, REGISTERED_TOOLS, ["read", "bash", "powershell"]);
  try {
    await Promise.resolve(harness.handlers.session_start?.({ reason: "startup" }, harness.ctx));
    await startTurn(harness);
    await startTurn(harness);
    assert.deepEqual(harness.setActiveToolsCalls, [["read", "bash"]]);
  } finally {
    await harness.cleanup();
  }
});

await runTest("before_agent_start keeps tools loaded later, such as by tool_search", async () => {
  const harness = createHarness(POLICY, REGISTERED_TOOLS, ["read", "codemode"]);
  try {
    await Promise.resolve(harness.handlers.session_start?.({ reason: "startup" }, harness.ctx));
    await startTurn(harness);
    harness.active = [...harness.active, "mcp_search"];
    await startTurn(harness);
    assert.deepEqual(harness.setActiveToolsCalls, []);
    assert.deepEqual(harness.active, ["read", "codemode", "mcp_search"]);
  } finally {
    await harness.cleanup();
  }
});

await runTest("before_agent_start restores a tool it hid after policy allows it on reload", async () => {
  const harness = createHarness(POLICY, REGISTERED_TOOLS, ["read", "powershell"]);
  try {
    await Promise.resolve(harness.handlers.session_start?.({ reason: "startup" }, harness.ctx));
    await startTurn(harness);
    assert.deepEqual(harness.active, ["read"]);

    harness.writePolicy({ ...POLICY, tools: { ...POLICY.tools, powershell: "allow" } });
    await Promise.resolve(harness.handlers.resources_discover?.({ reason: "reload" }, harness.ctx));
    await startTurn(harness);
    assert.deepEqual(harness.active, ["read", "powershell"]);
  } finally {
    await harness.cleanup();
  }
});

if (failures > 0) {
  throw new Error(`${failures} active tools test(s) failed`);
}
console.log("All active tools tests passed.");
