import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "bun:test";

import {
  DEFAULT_EXTENSION_CONFIG,
  loadPermissionSystemConfig,
  savePermissionSystemConfig,
  type PermissionSystemExtensionConfig,
} from "./extension-config.js";

mock.module("@mariozechner/pi-coding-agent", () => ({
  getSettingsListTheme: () => ({}),
}));

mock.module("@mariozechner/pi-tui", () => ({
  Box: class {},
  Container: class {
    addChild(): void {}
    render(): string[] {
      return [];
    }
    invalidate(): void {}
  },
  SettingsList: class {
    handleInput(): void {}
    updateValue(): void {}
    render(): string[] {
      return [];
    }
    invalidate(): void {}
  },
  Spacer: class {},
  Text: class {},
  truncateToWidth: (text: string) => text,
  visibleWidth: (text: string) => text.length,
}));

const { registerPermissionSystemCommand } = await import("./config-modal.js");

type Notification = { message: string; level: "info" | "warning" | "error" };

type CommandContextStub = {
  hasUI: boolean;
  ui: {
    notify(message: string, level: "info" | "warning" | "error"): void;
    custom<T>(renderer: (...args: unknown[]) => unknown, options?: unknown): Promise<T>;
  };
};

function runTest(name: string, testFn: () => void): void {
  testFn();
  console.log(`[PASS] ${name}`);
}

async function runAsyncTest(name: string, testFn: () => Promise<void>): Promise<void> {
  await testFn();
  console.log(`[PASS] ${name}`);
}

function createCommandContext(
  hasUI: boolean,
): { ctx: CommandContextStub; notifications: Notification[]; getCustomCalls(): number } {
  const notifications: Notification[] = [];
  let customCalls = 0;

  return {
    ctx: {
      hasUI,
      ui: {
        notify(message: string, level: "info" | "warning" | "error") {
          notifications.push({ message, level });
        },
        async custom<T>(_renderer: (...args: unknown[]) => unknown, _options?: unknown): Promise<T> {
          customCalls += 1;
          return undefined as T;
        },
      },
    },
    notifications,
    getCustomCalls: () => customCalls,
  };
}

function lastNotification(notifications: Notification[]): Notification {
  return notifications[notifications.length - 1] as Notification;
}

runTest("permission-system command completions expose top-level config actions", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-command-completions-"));
  const configPath = join(baseDir, "config.json");
  let config: PermissionSystemExtensionConfig = { ...DEFAULT_EXTENSION_CONFIG };

  try {
    const controller = {
      getConfig: () => config,
      setConfig: (next: PermissionSystemExtensionConfig) => {
        config = next;
      },
      getConfigPath: () => configPath,
    };

    let definition: {
      description: string;
      getArgumentCompletions?: (argumentPrefix: string) => Array<{ value: string; label: string; description?: string }> | null;
      handler: (args: string, ctx: CommandContextStub) => Promise<void>;
    } | null = null;

    registerPermissionSystemCommand(
      {
        registerCommand(_name: string, nextDefinition: typeof definition) {
          definition = nextDefinition;
        },
      } as never,
      controller as never,
    );

    assert.ok(definition !== null);
    assert.ok(typeof definition?.getArgumentCompletions === "function");

    const topLevel = definition?.getArgumentCompletions?.("");
    assert.ok(Array.isArray(topLevel));
    assert.ok(topLevel?.some((item) => item.value === "show"));
    assert.ok(topLevel?.some((item) => item.value === "reset"));

    const filtered = definition?.getArgumentCompletions?.("pa");
    assert.deepEqual(filtered?.map((item) => item.value), ["path"]);
    assert.equal(definition?.getArgumentCompletions?.("path extra"), null);
    assert.equal(definition?.getArgumentCompletions?.("zzz"), null);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

await runAsyncTest("permission-system command handlers manage config summary, persistence, and modal routing", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-command-"));
  const configPath = join(baseDir, "config.json");
  let config: PermissionSystemExtensionConfig = {
    debugLog: true,
    permissionReviewLog: false,
    yoloMode: true,
  };

  try {
    const initialSave = savePermissionSystemConfig(config, configPath);
    assert.equal(initialSave.success, true);

    const controller = {
      getConfig: () => config,
      setConfig: (next: PermissionSystemExtensionConfig) => {
        const normalized = loadPermissionSystemConfig(configPath).config;
        const saved = savePermissionSystemConfig(next, configPath);
        assert.equal(saved.success, true);
        config = loadPermissionSystemConfig(configPath).config;
        assert.notDeepEqual(config, normalized);
      },
      getConfigPath: () => configPath,
    };

    let registeredName = "";
    let definition: {
      description: string;
      getArgumentCompletions?: (argumentPrefix: string) => Array<{ value: string; label: string; description?: string }> | null;
      handler: (args: string, ctx: CommandContextStub) => Promise<void>;
    } | null = null;

    registerPermissionSystemCommand(
      {
        registerCommand(name: string, nextDefinition: typeof definition) {
          registeredName = name;
          definition = nextDefinition;
        },
      } as never,
      controller as never,
    );

    assert.equal(registeredName, "permission-system");
    assert.ok(definition !== null);
    assert.ok((definition?.description ?? "").includes("Configure pi-permission-system"));

    const infoCtx = createCommandContext(true);
    await definition?.handler("show", infoCtx.ctx);
    assert.ok(lastNotification(infoCtx.notifications).message.includes("yoloMode=on"));
    assert.ok(lastNotification(infoCtx.notifications).message.includes("debugLog=on"));

    await definition?.handler("path", infoCtx.ctx);
    assert.equal(lastNotification(infoCtx.notifications).message, `permission-system config: ${configPath}`);

    await definition?.handler("help", infoCtx.ctx);
    assert.ok(lastNotification(infoCtx.notifications).message.includes("Usage: /permission-system"));

    await definition?.handler("reset", infoCtx.ctx);
    assert.deepEqual(config, DEFAULT_EXTENSION_CONFIG);
    assert.equal(lastNotification(infoCtx.notifications).message, "Permission system settings reset to defaults.");

    const persisted = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(persisted, DEFAULT_EXTENSION_CONFIG);

    await definition?.handler("unknown", infoCtx.ctx);
    assert.equal(lastNotification(infoCtx.notifications).level, "warning");
    assert.ok(lastNotification(infoCtx.notifications).message.includes("Usage: /permission-system"));

    const headlessCtx = createCommandContext(false);
    await definition?.handler("", headlessCtx.ctx);
    assert.equal(lastNotification(headlessCtx.notifications).message, "/permission-system requires interactive TUI mode.");

    const modalCtx = createCommandContext(true);
    await definition?.handler("", modalCtx.ctx);
    assert.equal(modalCtx.getCustomCalls(), 1);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

console.log("All permission-system config-modal tests passed.");
