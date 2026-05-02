import type { ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { EXTENSION_ID, type PermissionSystemExtensionConfig } from "./extension-config.js";
import { isYoloModeEnabled } from "./yolo-mode.js";

export const PERMISSION_SYSTEM_STATUS_KEY = EXTENSION_ID;

type PermissionStatusContext = Pick<ExtensionContext, "hasUI" | "ui"> | Pick<ExtensionCommandContext, "ui">;

export function getPermissionSystemStatus(config: PermissionSystemExtensionConfig): string | undefined {
  if (!isYoloModeEnabled(config)) {
    return undefined;
  }

  return config.yoloStatusMessage ?? undefined;
}

export function syncPermissionSystemStatus(
  ctx: PermissionStatusContext,
  config: PermissionSystemExtensionConfig,
): void {
  ctx.ui.setStatus(PERMISSION_SYSTEM_STATUS_KEY, getPermissionSystemStatus(config));
}
