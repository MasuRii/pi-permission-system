import { appendFileSync } from "node:fs";

import {
  EXTENSION_ID,
  ensurePermissionSystemLogsDirectory,
  getPermissionSystemDebugLogPath,
  getPermissionSystemReviewLogPath,
  type PermissionSystemExtensionConfig,
} from "./extension-config.js";

export function safeJsonStringify(value: unknown): string | undefined {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, currentValue) => {
    if (currentValue instanceof Error) {
      return {
        name: currentValue.name,
        message: currentValue.message,
        stack: currentValue.stack,
      };
    }

    if (typeof currentValue === "bigint") {
      return currentValue.toString();
    }

    if (typeof currentValue === "object" && currentValue !== null) {
      if (seen.has(currentValue)) {
        return "[Circular]";
      }
      seen.add(currentValue);
    }

    return currentValue;
  });
}

export interface PermissionSystemLogger {
  debug: (event: string, details?: Record<string, unknown>) => string | undefined;
  review: (event: string, details?: Record<string, unknown>) => string | undefined;
}

interface PermissionSystemLoggerOptions {
  getConfig: () => PermissionSystemExtensionConfig;
  debugLogPath?: string;
  reviewLogPath?: string;
  ensureLogsDirectory?: () => string | undefined;
}

export function createPermissionSystemLogger(options: PermissionSystemLoggerOptions): PermissionSystemLogger {
  const getDebugLogPath = (): string => options.debugLogPath ?? getPermissionSystemDebugLogPath();
  const getReviewLogPath = (): string => options.reviewLogPath ?? getPermissionSystemReviewLogPath();
  const ensureLogsDirectory = options.ensureLogsDirectory ?? (() => ensurePermissionSystemLogsDirectory());

  const writeLine = (stream: "debug" | "review", path: string, event: string, details: Record<string, unknown>): string | undefined => {
    const directoryError = ensureLogsDirectory();
    if (directoryError) {
      return directoryError;
    }

    try {
      const line = safeJsonStringify({
        timestamp: new Date().toISOString(),
        extension: EXTENSION_ID,
        stream,
        event,
        ...details,
      });
      if (!line) {
        return `Failed to write permission-system ${stream} log '${path}': event could not be serialized.`;
      }
      appendFileSync(path, `${line}\n`, "utf-8");
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Failed to write permission-system ${stream} log '${path}': ${message}`;
    }
  };

  const debug = (event: string, details: Record<string, unknown> = {}): string | undefined => {
    if (!options.getConfig().debugLog) {
      return undefined;
    }

    return writeLine("debug", getDebugLogPath(), event, details);
  };

  const review = (event: string, details: Record<string, unknown> = {}): string | undefined => {
    if (!options.getConfig().permissionReviewLog) {
      return undefined;
    }

    return writeLine("review", getReviewLogPath(), event, details);
  };

  return { debug, review };
}
