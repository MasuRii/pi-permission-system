import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { SettingItem } from "@mariozechner/pi-tui";

import type { PermissionSystemExtensionConfig } from "./extension-config.js";
import { ZellijModal, ZellijSettingsModal } from "./zellij-modal.js";

interface PermissionSystemConfigController {
  getConfig(): PermissionSystemExtensionConfig;
  setConfig(next: PermissionSystemExtensionConfig, ctx: ExtensionCommandContext): void;
  getConfigPath(): string;
}

interface SettingValueSyncTarget {
  updateValue(id: string, value: string): void;
}

const ON_OFF = ["on", "off"];

function toOnOff(value: boolean): string {
  return value ? "on" : "off";
}

function buildSettingItems(config: PermissionSystemExtensionConfig): SettingItem[] {
  return [
    {
      id: "yoloMode",
      label: "YOLO mode",
      description: "Auto-approve ask-state permission checks, including subagent approval forwarding",
      currentValue: toOnOff(config.yoloMode),
      values: ON_OFF,
    },
    {
      id: "permissionReviewLog",
      label: "Permission review log",
      description: "Write permission request and decision audit events to the extension logs directory",
      currentValue: toOnOff(config.permissionReviewLog),
      values: ON_OFF,
    },
    {
      id: "debugLog",
      label: "Debug logging",
      description: "Write verbose permission-system diagnostics to the extension logs directory",
      currentValue: toOnOff(config.debugLog),
      values: ON_OFF,
    },
  ];
}

function applySetting(
  config: PermissionSystemExtensionConfig,
  id: string,
  value: string,
): PermissionSystemExtensionConfig {
  switch (id) {
    case "yoloMode":
      return { ...config, yoloMode: value === "on" };
    case "permissionReviewLog":
      return { ...config, permissionReviewLog: value === "on" };
    case "debugLog":
      return { ...config, debugLog: value === "on" };
    default:
      return config;
  }
}

function syncSettingValues(settingsList: SettingValueSyncTarget, config: PermissionSystemExtensionConfig): void {
  settingsList.updateValue("yoloMode", toOnOff(config.yoloMode));
  settingsList.updateValue("permissionReviewLog", toOnOff(config.permissionReviewLog));
  settingsList.updateValue("debugLog", toOnOff(config.debugLog));
}

async function openSettingsModal(ctx: ExtensionCommandContext, controller: PermissionSystemConfigController): Promise<void> {
  const overlayOptions = { anchor: "center" as const, width: 82, maxHeight: "85%" as const, margin: 1 };

  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      let current = controller.getConfig();
      let settingsModal: ZellijSettingsModal | null = null;

      settingsModal = new ZellijSettingsModal(
        {
          title: "Permission System Settings",
          description: "Local extension options for permission logging and auto-approval behavior",
          settings: buildSettingItems(current),
          onChange: (id, newValue) => {
            current = applySetting(current, id, newValue);
            controller.setConfig(current, ctx);
            current = controller.getConfig();
            if (settingsModal) {
              syncSettingValues(settingsModal, current);
            }
          },
          onClose: () => done(),
          helpText: `Config file: ${controller.getConfigPath()}`,
          enableSearch: true,
        },
        theme,
      );

      const modal = new ZellijModal(
        settingsModal,
        {
          borderStyle: "rounded",
          titleBar: {
            left: "Permission System Settings",
            right: "pi-permission-system",
          },
          helpUndertitle: {
            text: "Esc: close | ↑↓: navigate | Space: toggle",
            color: "dim",
          },
          overlay: overlayOptions,
        },
        theme,
      );

      return {
        render(width: number) {
          return modal.renderModal(width).lines;
        },
        invalidate() {
          modal.invalidate();
        },
        handleInput(data: string) {
          modal.handleInput(data);
          tui.requestRender();
        },
      };
    },
    { overlay: true, overlayOptions },
  );
}

export function registerPermissionSystemCommand(pi: ExtensionAPI, controller: PermissionSystemConfigController): void {
  pi.registerCommand("permission-system", {
    description: "Configure pi-permission-system logging and yolo-mode behavior",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/permission-system requires interactive TUI mode.", "warning");
        return;
      }

      await openSettingsModal(ctx, controller);
    },
  });
}
