import { homedir } from "node:os";
import { dirname, join, normalize, resolve, sep } from "node:path";

import { PermissionManager } from "./permission-manager.js";
import type { PermissionState } from "./types.js";

const AVAILABLE_SKILLS_OPEN_TAG = "<available_skills>";
const AVAILABLE_SKILLS_CLOSE_TAG = "</available_skills>";
const SKILL_BLOCK_PATTERN = "<skill>([\\s\\S]*?)<\\/skill>";
const SKILL_NAME_REGEX = /<name>([\s\S]*?)<\/name>/;
const SKILL_DESCRIPTION_REGEX = /<description>([\s\S]*?)<\/description>/;
const SKILL_LOCATION_REGEX = /<location>([\s\S]*?)<\/location>/;

type ParsedSkillPromptEntry = {
  name: string;
  description: string;
  location: string;
};

export type SkillPromptEntry = {
  name: string;
  description: string;
  location: string;
  state: PermissionState;
  normalizedLocation: string;
  normalizedBaseDir: string;
};

export type SkillPromptSection = {
  start: number;
  end: number;
  entries: ParsedSkillPromptEntry[];
};

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function encodeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizePathForComparison(pathValue: string, cwd: string): string {
  const trimmed = pathValue.trim().replace(/^['"]|['"]$/g, "");
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

function isPathWithinDirectory(pathValue: string, directory: string): boolean {
  if (!pathValue || !directory) {
    return false;
  }

  if (pathValue === directory) {
    return true;
  }

  const prefix = directory.endsWith(sep) ? directory : `${directory}${sep}`;
  return pathValue.startsWith(prefix);
}

function parseSkillEntries(sectionBody: string): ParsedSkillPromptEntry[] {
  const entries: ParsedSkillPromptEntry[] = [];
  const skillBlockRegex = new RegExp(SKILL_BLOCK_PATTERN, "g");

  for (const match of sectionBody.matchAll(skillBlockRegex)) {
    const block = match[1];
    const nameMatch = block.match(SKILL_NAME_REGEX);
    const descriptionMatch = block.match(SKILL_DESCRIPTION_REGEX);
    const locationMatch = block.match(SKILL_LOCATION_REGEX);

    if (!nameMatch || !descriptionMatch || !locationMatch) {
      continue;
    }

    const name = decodeXml(nameMatch[1].trim());
    const description = decodeXml(descriptionMatch[1].trim());
    const location = decodeXml(locationMatch[1].trim());

    if (!name || !location) {
      continue;
    }

    entries.push({ name, description, location });
  }

  return entries;
}

export function parseSkillPromptSection(prompt: string): SkillPromptSection | null {
  const start = prompt.indexOf(AVAILABLE_SKILLS_OPEN_TAG);
  if (start === -1) {
    return null;
  }

  const closeStart = prompt.indexOf(AVAILABLE_SKILLS_CLOSE_TAG, start + AVAILABLE_SKILLS_OPEN_TAG.length);
  if (closeStart === -1) {
    return null;
  }

  const end = closeStart + AVAILABLE_SKILLS_CLOSE_TAG.length;
  const sectionBody = prompt.slice(start + AVAILABLE_SKILLS_OPEN_TAG.length, closeStart);

  return {
    start,
    end,
    entries: parseSkillEntries(sectionBody),
  };
}

export function parseAllSkillPromptSections(prompt: string): SkillPromptSection[] {
  const sections: SkillPromptSection[] = [];
  let searchStart = 0;

  while (searchStart < prompt.length) {
    const start = prompt.indexOf(AVAILABLE_SKILLS_OPEN_TAG, searchStart);
    if (start === -1) {
      break;
    }

    const closeStart = prompt.indexOf(AVAILABLE_SKILLS_CLOSE_TAG, start + AVAILABLE_SKILLS_OPEN_TAG.length);
    if (closeStart === -1) {
      break;
    }

    const end = closeStart + AVAILABLE_SKILLS_CLOSE_TAG.length;
    const sectionBody = prompt.slice(start + AVAILABLE_SKILLS_OPEN_TAG.length, closeStart);
    sections.push({
      start,
      end,
      entries: parseSkillEntries(sectionBody),
    });
    searchStart = end;
  }

  return sections;
}

function resolvePermissionState(
  skillName: string,
  permissionManager: PermissionManager,
  agentName: string | null,
  cache: Map<string, PermissionState>,
): PermissionState {
  const cachedState = cache.get(skillName);
  if (cachedState) {
    return cachedState;
  }

  const state = permissionManager.checkPermission("skill", { name: skillName }, agentName ?? undefined).state;
  cache.set(skillName, state);
  return state;
}

function createResolvedSkillEntry(
  entry: ParsedSkillPromptEntry,
  state: PermissionState,
  cwd: string,
): SkillPromptEntry {
  return {
    name: entry.name,
    description: entry.description,
    location: entry.location,
    state,
    normalizedLocation: normalizePathForComparison(entry.location, cwd),
    normalizedBaseDir: normalizePathForComparison(dirname(entry.location), cwd),
  };
}

function renderAvailableSkillsSection(entries: readonly SkillPromptEntry[]): string {
  return [
    AVAILABLE_SKILLS_OPEN_TAG,
    ...entries.flatMap((entry) => [
      "  <skill>",
      `    <name>${encodeXml(entry.name)}</name>`,
      `    <description>${encodeXml(entry.description)}</description>`,
      `    <location>${encodeXml(entry.location)}</location>`,
      "  </skill>",
    ]),
    AVAILABLE_SKILLS_CLOSE_TAG,
  ].join("\n");
}

function removePromptRange(prompt: string, start: number, end: number): string {
  const beforeSection = prompt.slice(0, start).replace(/\n+$/, "");
  const afterSection = prompt.slice(end);
  return `${beforeSection}${afterSection}`;
}

export function resolveSkillPromptEntries(
  prompt: string,
  permissionManager: PermissionManager,
  agentName: string | null,
  cwd: string,
): { prompt: string; entries: SkillPromptEntry[] } {
  const sections = parseAllSkillPromptSections(prompt);
  if (sections.length === 0) {
    return { prompt, entries: [] };
  }

  const permissionCache = new Map<string, PermissionState>();
  const visibleEntries: SkillPromptEntry[] = [];
  const replacements: Array<{ start: number; end: number; content: string }> = [];

  for (const section of sections) {
    const resolvedEntries = section.entries.map((entry) => {
      const state = resolvePermissionState(entry.name, permissionManager, agentName, permissionCache);
      return createResolvedSkillEntry(entry, state, cwd);
    });

    const visibleSectionEntries = resolvedEntries.filter((entry) => entry.state !== "deny");
    visibleEntries.push(...visibleSectionEntries);

    if (visibleSectionEntries.length === resolvedEntries.length) {
      continue;
    }

    replacements.push({
      start: section.start,
      end: section.end,
      content: visibleSectionEntries.length > 0 ? renderAvailableSkillsSection(visibleSectionEntries) : "",
    });
  }

  if (replacements.length === 0) {
    return { prompt, entries: visibleEntries };
  }

  let sanitizedPrompt = prompt;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const replacement = replacements[i];
    sanitizedPrompt = replacement.content.length > 0
      ? `${sanitizedPrompt.slice(0, replacement.start)}${replacement.content}${sanitizedPrompt.slice(replacement.end)}`
      : removePromptRange(sanitizedPrompt, replacement.start, replacement.end);
  }

  return {
    prompt: sanitizedPrompt,
    entries: visibleEntries,
  };
}

export function findSkillPathMatch(normalizedPath: string, entries: readonly SkillPromptEntry[]): SkillPromptEntry | null {
  if (!normalizedPath || entries.length === 0) {
    return null;
  }

  for (const entry of entries) {
    if (entry.normalizedLocation && normalizedPath === entry.normalizedLocation) {
      return entry;
    }
  }

  let bestMatch: SkillPromptEntry | null = null;
  for (const entry of entries) {
    if (!entry.normalizedBaseDir || !isPathWithinDirectory(normalizedPath, entry.normalizedBaseDir)) {
      continue;
    }

    if (!bestMatch || entry.normalizedBaseDir.length > bestMatch.normalizedBaseDir.length) {
      bestMatch = entry;
    }
  }

  return bestMatch;
}
