import { homedir } from "node:os";
import { join, normalize, resolve, sep } from "node:path";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { PermissionState } from "./types.js";

export function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

export function getNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Normalizes an agent-name-like value to a non-empty trimmed string, or null.
 * Semantically equivalent to {@link getNonEmptyString}; kept as a named alias
 * for call-site readability where the value represents an agent name.
 */
export function normalizeAgentName(value: unknown): string | null {
  return getNonEmptyString(value);
}

/**
 * Normalizes a list of names (trim + drop empty) and returns the first name
 * for which `matchSingle` returns a non-null match, or null when no name
 * matches. Shared by wildcard and permission-pattern matching so the
 * normalize-and-search loop is defined once.
 */
export function findFirstMatchForNames<TMatch>(
  names: readonly string[],
  matchSingle: (name: string) => TMatch | null,
): TMatch | null {
  const normalizedNames = names.map((value) => value.trim()).filter((value) => value.length > 0);
  for (const name of normalizedNames) {
    const match = matchSingle(name);
    if (match) {
      return match;
    }
  }
  return null;
}

export function isPermissionState(value: unknown): value is PermissionState {
  return value === "allow" || value === "deny" || value === "ask";
}

export function normalizePathForComparison(pathValue: string, cwd: string): string {
  const trimmed = pathValue.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) {
    return "";
  }

  let normalizedPath = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;

  if (normalizedPath === "~") {
    normalizedPath = homedir();
  } else if (normalizedPath.startsWith("~/") || normalizedPath.startsWith("~\\")) {
    normalizedPath = join(homedir(), normalizedPath.slice(2));
  }

  const absolutePath = resolve(cwd, normalizedPath);
  const normalizedAbsolutePath = normalize(absolutePath);
  return process.platform === "win32" ? normalizedAbsolutePath.toLowerCase() : normalizedAbsolutePath;
}

export function normalizePathResourceForPermission(pathValue: string, cwd: string): string {
  const normalizedPath = normalizePathForComparison(pathValue, cwd).replaceAll("\\", "/");
  if (!normalizedPath) {
    return "";
  }

  const driveRootMatch = normalizedPath.match(/^([a-z]):\/+$/iu);
  if (driveRootMatch?.[1]) {
    return `${driveRootMatch[1].toLowerCase()}:/`;
  }

  if (/^\/+$/u.test(normalizedPath)) {
    return "/";
  }

  return normalizedPath
    .replace(/^([A-Z]):/u, (_, drive: string) => `${drive.toLowerCase()}:`)
    .replace(/\/+$/u, "");
}

export function isPathWithinDirectory(pathValue: string, directory: string): boolean {
  if (!pathValue || !directory) {
    return false;
  }

  if (pathValue === directory) {
    return true;
  }

  const prefix = directory.endsWith(sep) ? directory : `${directory}${sep}`;
  return pathValue.startsWith(prefix);
}

type StackNode = { indent: number; target: Record<string, unknown> };

function isPrototypePollutionKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

export function parseSimpleYamlMap(input: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: StackNode[] = [{ indent: -1, target: root }];

  const lines = input.split(/\r?\n/);
  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) {
      continue;
    }

    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim().replace(/^["']|["']$/g, "");
    if (isPrototypePollutionKey(key)) {
      continue;
    }

    const rawValue = line.slice(separatorIndex + 1).trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const current = stack[stack.length - 1].target;

    if (!rawValue) {
      const child: Record<string, unknown> = {};
      current[key] = child;
      stack.push({ indent, target: child });
      continue;
    }

    let scalar = rawValue;
    if ((scalar.startsWith('"') && scalar.endsWith('"')) || (scalar.startsWith("'") && scalar.endsWith("'"))) {
      scalar = scalar.slice(1, -1);
    }

    current[key] = scalar;
  }

  return root;
}

export function normalizeLineEndings(prompt: string): string {
  return prompt.replace(/\r\n/g, "\n");
}

/**
 * Some hosts (e.g. OMP) pass `systemPrompt` as `string[]`; classic Pi used `string`.
 * Normalize both shapes (and unexpected values) to a single string.
 */
export function normalizeSystemPromptText(systemPrompt: unknown): string {
  if (typeof systemPrompt === "string") {
    return systemPrompt;
  }

  if (Array.isArray(systemPrompt)) {
    return systemPrompt
      .filter((part): part is string => typeof part === "string")
      .join("\n\n");
  }

  return "";
}

export function extractFrontmatter(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return "";
  }

  const end = normalized.indexOf("\n---", 4);
  if (end === -1) {
    return "";
  }

  return normalized.slice(4, end);
}

export const PERMISSION_SYSTEM_COMMAND_DESCRIPTION = "Configure pi-permission-system debug logging and yolo-mode behavior";

/**
 * Builds the `/permission-system` command handler shared by the standalone
 * config-modal registration and the index.ts wiring. Enforces the interactive
 * TUI requirement once so both registration sites stay in sync.
 */
export function createPermissionSystemCommandHandler(
  openModal: (ctx: ExtensionCommandContext) => Promise<void>,
): (args: string, ctx: ExtensionCommandContext) => Promise<void> {
  return async (_args: string, ctx: ExtensionCommandContext) => {
    if (!ctx.hasUI) {
      ctx.ui.notify("/permission-system requires interactive TUI mode.", "warning");
      return;
    }
    await openModal(ctx);
  };
}
