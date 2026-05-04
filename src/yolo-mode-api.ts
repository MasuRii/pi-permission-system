export interface YoloModeControlOptions {
  persist?: boolean;
  source?: string;
}

export interface YoloModeControlResult {
  yoloMode: boolean;
  changed: boolean;
  persisted: boolean;
  error?: string;
}

export interface PiPermissionSystemRuntimeApi {
  getYoloMode(): boolean;
  setYoloMode(enabled: boolean, options?: YoloModeControlOptions): YoloModeControlResult;
  toggleYoloMode(options?: YoloModeControlOptions): YoloModeControlResult;
}

type GlobalWithPermissionSystemRuntimeApi = typeof globalThis & {
  __piPermissionSystem?: PiPermissionSystemRuntimeApi;
};

export function registerPiPermissionSystemRuntimeApi(
  api: PiPermissionSystemRuntimeApi,
): PiPermissionSystemRuntimeApi {
  const globalScope = globalThis as GlobalWithPermissionSystemRuntimeApi;
  globalScope.__piPermissionSystem = api;
  return api;
}

export function unregisterPiPermissionSystemRuntimeApi(api?: PiPermissionSystemRuntimeApi): void {
  const globalScope = globalThis as GlobalWithPermissionSystemRuntimeApi;
  if (api !== undefined && globalScope.__piPermissionSystem !== undefined && globalScope.__piPermissionSystem !== api) {
    return;
  }

  delete globalScope.__piPermissionSystem;
}

export function getPiPermissionSystemRuntimeApi(): PiPermissionSystemRuntimeApi | null {
  const globalScope = globalThis as GlobalWithPermissionSystemRuntimeApi;
  return globalScope.__piPermissionSystem ?? null;
}
