export type CompiledWildcardPattern<TState> = {
  pattern: string;
  state: TState;
  regex: RegExp;
  wildcardCount: number;
  literalLength: number;
};

export type WildcardPatternMatch<TState> = {
  state: TState;
  matchedPattern: string;
  matchedName: string;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function compileWildcardPattern<TState>(pattern: string, state: TState): CompiledWildcardPattern<TState> {
  const escaped = pattern
    .split("*")
    .map((part) => escapeRegExp(part))
    .join(".*");

  return {
    pattern,
    state,
    regex: new RegExp(`^${escaped}$`),
    wildcardCount: (pattern.match(/\*/g) || []).length,
    literalLength: pattern.replace(/\*/g, "").length,
  };
}

function compareCompiledPatterns<TState>(
  left: CompiledWildcardPattern<TState>,
  right: CompiledWildcardPattern<TState>,
): number {
  if (left.wildcardCount !== right.wildcardCount) {
    return left.wildcardCount - right.wildcardCount;
  }

  if (left.literalLength !== right.literalLength) {
    return right.literalLength - left.literalLength;
  }

  return right.pattern.length - left.pattern.length;
}

export function compileWildcardPatterns<TState>(
  patterns: Record<string, TState>,
): CompiledWildcardPattern<TState>[] {
  return Object.entries(patterns)
    .map(([pattern, state]) => compileWildcardPattern(pattern, state))
    .sort(compareCompiledPatterns);
}

export function findCompiledWildcardMatch<TState>(
  patterns: readonly CompiledWildcardPattern<TState>[],
  name: string,
): WildcardPatternMatch<TState> | null {
  for (const pattern of patterns) {
    if (pattern.regex.test(name)) {
      return {
        state: pattern.state,
        matchedPattern: pattern.pattern,
        matchedName: name,
      };
    }
  }

  return null;
}

export function findCompiledWildcardMatchForNames<TState>(
  patterns: readonly CompiledWildcardPattern<TState>[],
  names: readonly string[],
): WildcardPatternMatch<TState> | null {
  const normalizedNames = names.map((value) => value.trim()).filter((value) => value.length > 0);
  if (normalizedNames.length === 0) {
    return null;
  }

  for (const name of normalizedNames) {
    const match = findCompiledWildcardMatch(patterns, name);
    if (match) {
      return match;
    }
  }

  return null;
}
