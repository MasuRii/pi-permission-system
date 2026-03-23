import type { PermissionSystemExtensionConfig } from "./extension-config.js";
import type { PermissionState } from "./types.js";

export interface AskPermissionResolutionOptions {
  config: PermissionSystemExtensionConfig;
  hasUI: boolean;
  isSubagent: boolean;
}

export function isYoloModeEnabled(config: PermissionSystemExtensionConfig): boolean {
  return config.yoloMode === true;
}

export function shouldAutoApprovePermissionState(
  state: PermissionState,
  config: PermissionSystemExtensionConfig,
): boolean {
  return state === "ask" && isYoloModeEnabled(config);
}

export function canResolveAskPermissionRequest(options: AskPermissionResolutionOptions): boolean {
  return options.hasUI || options.isSubagent || isYoloModeEnabled(options.config);
}
