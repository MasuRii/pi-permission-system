export interface SanitizeSystemPromptResult {
  prompt: string;
  removed: boolean;
}

type ToolPromptEntry = {
  name: string;
  lines: string[];
};

type ToolPromptSection = {
  start: number;
  end: number;
  entries: ToolPromptEntry[];
};

const AVAILABLE_TOOLS_SECTION_HEADER = "Available tools:";

function normalizePrompt(prompt: string): string {
  return (prompt || "").replace(/\r\n/g, "\n");
}

function collapseExtraBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trimEnd();
}

function parseAvailableToolsSection(systemPrompt: string): ToolPromptSection | null {
  const lines = normalizePrompt(systemPrompt).split("\n");
  const start = lines.findIndex((line) => line.trim() === AVAILABLE_TOOLS_SECTION_HEADER);
  if (start === -1) {
    return null;
  }

  const entries: ToolPromptEntry[] = [];
  let index = start + 1;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (!trimmed.startsWith("- ")) {
      break;
    }

    const match = trimmed.match(/^\-\s+([^:]+):/);
    if (!match) {
      break;
    }

    const entryLines = [line];
    index += 1;

    while (index < lines.length) {
      const nextLine = lines[index];
      const nextTrimmed = nextLine.trim();

      if (!nextTrimmed) {
        entryLines.push(nextLine);
        index += 1;
        continue;
      }

      if (nextTrimmed.startsWith("- ")) {
        break;
      }

      if (!/^\s/.test(nextLine)) {
        break;
      }

      entryLines.push(nextLine);
      index += 1;
    }

    while (entryLines.length > 0 && entryLines[entryLines.length - 1].trim().length === 0) {
      entryLines.pop();
    }

    entries.push({
      name: match[1].trim(),
      lines: entryLines,
    });
  }

  if (entries.length === 0) {
    return null;
  }

  return {
    start,
    end: index,
    entries,
  };
}

export function sanitizeAvailableToolsSection(
  systemPrompt: string,
  allowedToolNames: readonly string[],
): SanitizeSystemPromptResult {
  const section = parseAvailableToolsSection(systemPrompt);
  if (!section) {
    return { prompt: systemPrompt, removed: false };
  }

  const allowedTools = new Set(allowedToolNames.map((toolName) => toolName.trim()).filter(Boolean));
  const visibleEntries = section.entries.filter((entry) => allowedTools.has(entry.name));

  if (visibleEntries.length === section.entries.length) {
    return { prompt: systemPrompt, removed: false };
  }

  const lines = normalizePrompt(systemPrompt).split("\n");
  const replacement = visibleEntries.length > 0
    ? [lines[section.start], ...visibleEntries.flatMap((entry) => entry.lines)]
    : [];

  return {
    prompt: collapseExtraBlankLines([
      ...lines.slice(0, section.start),
      ...replacement,
      ...lines.slice(section.end),
    ].join("\n")),
    removed: true,
  };
}
