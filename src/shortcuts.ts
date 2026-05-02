import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import type { PermissionSystemExtensionConfig } from "./extension-config.js";

export type ShortcutActionDefinition = {
  id: string;
  description: string;
  getShortcut: (config: PermissionSystemExtensionConfig) => string | null;
  handler: (ctx: ExtensionContext) => Promise<void> | void;
};

export function registerConfiguredShortcuts(
  pi: ExtensionAPI,
  config: PermissionSystemExtensionConfig,
  actions: readonly ShortcutActionDefinition[],
  notifyWarning: (message: string) => void,
): void {
  for (const action of actions) {
    const shortcut = action.getShortcut(config);
    if (!shortcut) {
      continue;
    }

    try {
      pi.registerShortcut(shortcut, {
        description: action.description,
        handler: action.handler,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notifyWarning(`Failed to register shortcut '${shortcut}' (${action.id}): ${message}`);
    }
  }
}
