import { homedir } from "node:os";
import { join, normalize, resolve, sep } from "node:path";

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

    const key = line.slice(0, separatorIndex).trim().replace(/^['"]|['"]$/g, "");
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
