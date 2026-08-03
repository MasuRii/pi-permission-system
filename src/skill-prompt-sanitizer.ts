import { dirname } from "node:path";

import { isPathWithinDirectory, normalizePathForComparison } from "./common.js";
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

function lineContainsBacktickedHiddenSkill(line: string, hiddenSkillNames: ReadonlySet<string>): boolean {
  if (hiddenSkillNames.size === 0 || !line.includes("`")) {
    return false;
  }

  for (const match of line.matchAll(/`([^`]+)`/g)) {
    const skillName = decodeXml(match[1]?.trim() ?? "");
    if (skillName && hiddenSkillNames.has(skillName)) {
      return true;
    }
  }

  return false;
}

function isStructuredSkillReferenceLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") || /^[-*+]\s+/.test(trimmed);
}

function pruneHiddenStructuredSkillReferences(prompt: string, hiddenSkillNames: ReadonlySet<string>): string {
  if (hiddenSkillNames.size === 0) {
    return prompt;
  }

  const lines = prompt.split("\n");
  let removed = false;
  const prunedLines = lines.filter((line) => {
    if (isStructuredSkillReferenceLine(line) && lineContainsBacktickedHiddenSkill(line, hiddenSkillNames)) {
      removed = true;
      return false;
    }

    return true;
  });

  return removed ? prunedLines.join("\n").replace(/\n{3,}/g, "\n\n") : prompt;
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
  const enforcementEntries: SkillPromptEntry[] = [];
  const hiddenSkillNames = new Set<string>();
  const replacements: Array<{ start: number; end: number; content: string }> = [];

  for (const section of sections) {
    const resolvedEntries = section.entries.map((entry) => {
      const state = resolvePermissionState(entry.name, permissionManager, agentName, permissionCache);
      return createResolvedSkillEntry(entry, state, cwd);
    });
    enforcementEntries.push(...resolvedEntries);

    // The system prompt is an advertised capability list. Denied skills are
    // hidden and stay tracked for read-path enforcement. Ask skills remain
    // advertised so the model can discover them; loading one triggers the
    // interactive confirmation in the read-path check.
    const visibleSectionEntries = resolvedEntries.filter((entry) => entry.state !== "deny");
    for (const entry of resolvedEntries) {
      if (entry.state === "deny") {
        hiddenSkillNames.add(entry.name);
      }
    }

    if (visibleSectionEntries.length === resolvedEntries.length) {
      continue;
    }

    replacements.push({
      start: section.start,
      end: section.end,
      content: visibleSectionEntries.length > 0 ? renderAvailableSkillsSection(visibleSectionEntries) : "",
    });
  }

  let sanitizedPrompt = prompt;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const replacement = replacements[i];
    sanitizedPrompt = replacement.content.length > 0
      ? `${sanitizedPrompt.slice(0, replacement.start)}${replacement.content}${sanitizedPrompt.slice(replacement.end)}`
      : removePromptRange(sanitizedPrompt, replacement.start, replacement.end);
  }

  sanitizedPrompt = pruneHiddenStructuredSkillReferences(sanitizedPrompt, hiddenSkillNames);

  return {
    prompt: sanitizedPrompt,
    entries: enforcementEntries,
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
