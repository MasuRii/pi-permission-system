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
} from "../src/extension-config.js";
import { runAsyncTest, runTest } from "./test-harness.js";

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

const { registerPermissionSystemCommand } = await import("../src/config-modal.js");

type Notification = { message: string; level: "info" | "warning" | "error" };

type RegisteredCommandDefinition = {
  description: string;
  getArgumentCompletions?: (argumentPrefix: string) => Array<{ value: string; label: string; description?: string }> | null;
  handler: (args: string, ctx: CommandContextStub) => Promise<void>;
};

type CommandContextStub = {
  hasUI: boolean;
  ui: {
    notify(message: string, level: "info" | "warning" | "error"): void;
    custom<T>(renderer: (...args: unknown[]) => unknown, options?: unknown): Promise<T>;
  };
};

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

function getRegisteredDefinition(definition: RegisteredCommandDefinition | null): RegisteredCommandDefinition {
  assert.ok(definition !== null);
  return definition;
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

    let definition: RegisteredCommandDefinition | null = null;

    registerPermissionSystemCommand(
      {
        registerCommand(_name: string, nextDefinition: RegisteredCommandDefinition) {
          definition = nextDefinition;
        },
      } as never,
      controller as never,
    );

    const registeredDefinition = getRegisteredDefinition(definition);
    assert.ok(typeof registeredDefinition.getArgumentCompletions === "function");

    const topLevel = registeredDefinition.getArgumentCompletions("");
    assert.ok(Array.isArray(topLevel));
    assert.ok(topLevel.some((item) => item.value === "show"));
    assert.ok(topLevel.some((item) => item.value === "reset"));

    const filtered = registeredDefinition.getArgumentCompletions("pa");
    assert.deepEqual(filtered?.map((item) => item.value), ["path"]);
    assert.equal(registeredDefinition.getArgumentCompletions("path extra"), null);
    assert.equal(registeredDefinition.getArgumentCompletions("zzz"), null);
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
    let definition: RegisteredCommandDefinition | null = null;

    registerPermissionSystemCommand(
      {
        registerCommand(name: string, nextDefinition: RegisteredCommandDefinition) {
          registeredName = name;
          definition = nextDefinition;
        },
      } as never,
      controller as never,
    );

    assert.equal(registeredName, "permission-system");
    const registeredDefinition = getRegisteredDefinition(definition);
    assert.ok(registeredDefinition.description.includes("Configure pi-permission-system"));

    const infoCtx = createCommandContext(true);
    await registeredDefinition.handler("show", infoCtx.ctx);
    assert.ok(lastNotification(infoCtx.notifications).message.includes("yoloMode=on"));
    assert.ok(lastNotification(infoCtx.notifications).message.includes("debugLog=on"));

    await registeredDefinition.handler("path", infoCtx.ctx);
    assert.equal(lastNotification(infoCtx.notifications).message, `permission-system config: ${configPath}`);

    await registeredDefinition.handler("help", infoCtx.ctx);
    assert.ok(lastNotification(infoCtx.notifications).message.includes("Usage: /permission-system"));

    await registeredDefinition.handler("reset", infoCtx.ctx);
    assert.deepEqual(config, DEFAULT_EXTENSION_CONFIG);
    assert.equal(lastNotification(infoCtx.notifications).message, "Permission system settings reset to defaults.");

    const persisted = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(persisted, DEFAULT_EXTENSION_CONFIG);

    await registeredDefinition.handler("unknown", infoCtx.ctx);
    assert.equal(lastNotification(infoCtx.notifications).level, "warning");
    assert.ok(lastNotification(infoCtx.notifications).message.includes("Usage: /permission-system"));

    const headlessCtx = createCommandContext(false);
    await registeredDefinition.handler("", headlessCtx.ctx);
    assert.equal(lastNotification(headlessCtx.notifications).message, "/permission-system requires interactive TUI mode.");

    const modalCtx = createCommandContext(true);
    await registeredDefinition.handler("", modalCtx.ctx);
    assert.equal(modalCtx.getCustomCalls(), 1);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

console.log("All permission-system config-modal tests passed.");
