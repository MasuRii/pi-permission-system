import type { BashPermissions, PermissionState } from "./types.js";
import {
  compileWildcardPatterns,
  findCompiledWildcardMatch,
  type CompiledWildcardPattern,
} from "./wildcard-matcher.js";

type CompiledPattern = CompiledWildcardPattern<PermissionState>;

type BashPermissionSource = BashPermissions | readonly CompiledPattern[];

function isCompiledPatternList(value: BashPermissionSource): value is readonly CompiledPattern[] {
  return Array.isArray(value);
}

export interface BashPermissionCheck {
  state: PermissionState;
  matchedPattern?: string;
  command: string;
}

const SHELL_CONTROL_OPERATORS = /\s*(?:&&|\|\||;|\|&?)\s*/;

export function splitShellCommand(command: string): string[] {
  return command
    .split(SHELL_CONTROL_OPERATORS)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const STATE_RANK: Record<PermissionState, number> = { deny: 2, ask: 1, allow: 0 };

export class BashFilter {
  private readonly compiledPatterns: CompiledPattern[];

  constructor(
    permissions: BashPermissionSource,
    private readonly defaultState: PermissionState,
  ) {
    this.compiledPatterns = isCompiledPatternList(permissions)
      ? [...permissions]
      : compileWildcardPatterns(permissions);
  }

  check(command: string): BashPermissionCheck {
    const segments = splitShellCommand(command);
    if (segments.length === 0) {
      return { state: this.defaultState, command };
    }

    let mostRestrictiveState: PermissionState | null = null;
    let mostRestrictivePattern: string | undefined;

    for (const segment of segments) {
      const match = findCompiledWildcardMatch(this.compiledPatterns, segment);
      const segmentState = match?.state ?? this.defaultState;

      if (mostRestrictiveState === null || STATE_RANK[segmentState] > STATE_RANK[mostRestrictiveState]) {
        mostRestrictiveState = segmentState;
        mostRestrictivePattern = match?.matchedPattern;
        if (mostRestrictiveState === "deny") break;
      }
    }

    return {
      state: mostRestrictiveState ?? this.defaultState,
      matchedPattern: mostRestrictivePattern,
      command,
    };
  }
}
