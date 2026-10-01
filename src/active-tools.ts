export interface ResolveActiveToolsInput {
  /** Tools Pi currently declares to the model (`pi.getActiveTools()`). */
  activeToolNames: readonly string[];
  /** Every registered tool name (`pi.getAllTools()`). */
  registeredToolNames: ReadonlySet<string>;
  /** Tools this extension removed earlier because policy denied them. */
  hiddenByPolicy: ReadonlySet<string>;
  /** Whether policy lets the model see the tool. */
  isToolExposed: (toolName: string) => boolean;
}

export interface ResolveActiveToolsResult {
  activeToolNames: string[];
  hiddenByPolicy: Set<string>;
  changed: boolean;
}

/**
 * Filters Pi's active tool set by permission policy without adding tools to it.
 *
 * Pi decides which tools are active (`defaultTools`, `--tools`, `tool_search` loads, manual
 * toggles), and tools with `codemode`, `deferred`, or `hidden` exposure are meant to stay
 * inactive until loaded. This only removes denied tools, and restores tools it removed itself
 * once policy allows them again, so policy changes (reload, YOLO, agent switch) round-trip.
 */
export function resolveActiveTools(input: ResolveActiveToolsInput): ResolveActiveToolsResult {
  const next: string[] = [];
  const seen = new Set<string>();
  const hiddenByPolicy = new Set<string>();

  for (const toolName of input.activeToolNames) {
    if (seen.has(toolName)) {
      continue;
    }
    seen.add(toolName);

    if (!input.registeredToolNames.has(toolName) || input.isToolExposed(toolName)) {
      next.push(toolName);
    } else {
      hiddenByPolicy.add(toolName);
    }
  }

  for (const toolName of input.hiddenByPolicy) {
    if (seen.has(toolName)) {
      continue;
    }
    seen.add(toolName);

    if (input.registeredToolNames.has(toolName) && input.isToolExposed(toolName)) {
      next.push(toolName);
    } else {
      // Keep unregistered names too: an MCP server may register the tool again after reconnecting.
      hiddenByPolicy.add(toolName);
    }
  }

  const changed = next.length !== input.activeToolNames.length
    || next.some((toolName, index) => toolName !== input.activeToolNames[index]);

  return { activeToolNames: next, hiddenByPolicy, changed };
}
