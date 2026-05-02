import assert from "node:assert/strict";

import { registerConfiguredShortcuts, type ShortcutActionDefinition } from "../src/shortcuts.js";
import type { PermissionSystemExtensionConfig } from "../src/extension-config.js";
import { runTest } from "./test-harness.js";

type ShortcutRegistration = {
  shortcut: string;
  description?: string;
};

runTest("registerConfiguredShortcuts registers configured actions and skips null bindings", () => {
  const calls: ShortcutRegistration[] = [];
  const warnings: string[] = [];

  const config: PermissionSystemExtensionConfig = {
    debugLog: false,
    permissionReviewLog: true,
    yoloMode: false,
    shortcutBindings: {
      toggleYoloMode: "f8",
    },
  };

  const actions: ShortcutActionDefinition[] = [
    {
      id: "toggleYoloMode",
      description: "Toggle YOLO",
      getShortcut: (value) => value.shortcutBindings.toggleYoloMode,
      handler: () => {},
    },
    {
      id: "disabled",
      description: "Disabled action",
      getShortcut: () => null,
      handler: () => {},
    },
  ];

  registerConfiguredShortcuts(
    {
      registerShortcut: (shortcut: string, options: { description?: string }) => {
        calls.push({ shortcut, description: options.description });
      },
    } as never,
    config,
    actions,
    (warning) => {
      warnings.push(warning);
    },
  );

  assert.deepEqual(calls, [{ shortcut: "f8", description: "Toggle YOLO" }]);
  assert.deepEqual(warnings, []);
});

runTest("registerConfiguredShortcuts reports registration failures", () => {
  const warnings: string[] = [];

  const config: PermissionSystemExtensionConfig = {
    debugLog: false,
    permissionReviewLog: true,
    yoloMode: false,
    shortcutBindings: {
      toggleYoloMode: "f8",
    },
  };

  registerConfiguredShortcuts(
    {
      registerShortcut: () => {
        throw new Error("already bound");
      },
    } as never,
    config,
    [
      {
        id: "toggleYoloMode",
        description: "Toggle YOLO",
        getShortcut: (value) => value.shortcutBindings.toggleYoloMode,
        handler: () => {},
      },
    ],
    (warning) => {
      warnings.push(warning);
    },
  );

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Failed to register shortcut 'f8'/);
});

console.log("All permission-system shortcuts tests passed.");
