import { homedir } from "node:os";
import { join, normalize } from "node:path";

import type { BashPermissions, PermissionState } from "./types.js";
import { segmentBash } from "./bash-lexer.js";
import {
  compileWildcardPatterns,
  findCompiledWildcardMatch,
  type CompiledWildcardPattern,
} from "./wildcard-matcher.js";

type CompiledPattern = CompiledWildcardPattern<PermissionState>;

type BashPermissionSource = BashPermissions | readonly CompiledPattern[];

/** Permission states ordered by restrictiveness (higher = more restrictive). */
const PERMISSION_ORDER: Record<PermissionState, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

/**
 * Pick the most restrictive permission state among candidates.
 * deny > ask > allow.
 */
export function combinePermissions(
  states: PermissionState[],
): PermissionState {
  if (states.length === 0) return "ask";
  let result: PermissionState = "allow";
  for (const state of states) {
    if (PERMISSION_ORDER[state] > PERMISSION_ORDER[result]) {
      result = state;
    }
  }
  return result;
}

function isCompiledPatternList(value: BashPermissionSource): value is readonly CompiledPattern[] {
  return Array.isArray(value);
}

function isAbsoluteRedirectPath(value: string): boolean {
  if (value.startsWith("/")) return true;
  if (process.platform === "win32") {
    return value.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(value);
  }
  return false;
}

/**
 * Expand a leading `~` in a redirect-target pattern to the user's home
 * directory, so configs can write `{"~/secrets/*": "deny"}`.
 */
export function expandHomeInPattern(pattern: string): string {
  if (pattern === "~") return homedir();
  if (pattern.startsWith("~/")) return join(homedir(), pattern.slice(2));
  return pattern;
}

/**
 * Normalize a redirect target before pattern matching.
 *
 * `~` and `~/...` expand to the user's home directory (well-defined, independent
 * of cwd). Absolute paths are lexically normalized — `.` and `..` segments
 * resolved, duplicate slashes collapsed — so a target like `/tmp/../etc/foo`
 * cannot evade a rule written for `/etc/*`, and an allow rule for `/tmp/*`
 * cannot leak through it to `/etc/foo`.
 *
 * Relative paths are left as-is: in a compound command the cwd at redirect
 * time may differ from the cwd at evaluation time (`cd x && cmd > out.txt`),
 * so resolving against the current cwd would be wrong. Relative targets simply
 * don't match absolute-path rules and fall through to the default state
 * (literal relative-target rules still work).
 */
export function normalizeRedirectTarget(target: string): string {
  const value = expandHomeInPattern(target);
  if (!isAbsoluteRedirectPath(value)) return value;
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.replaceAll("\\", "/") : normalized;
}

export interface BashSegmentMatch {
  state: PermissionState;
  matchedPattern?: string;
}

export interface BashCommandEvaluation {
  state: PermissionState;
  matchedPattern?: string;
  /** Redirect target that forced the final (most restrictive) state, if any. */
  redirectTarget?: string;
  /** True when the command contains at least one opaque (unparseable) segment. */
  hasOpaqueSegments: boolean;
}

/**
 * Evaluate a bash command against per-segment command patterns and, optionally,
 * output-redirect-target patterns.
 *
 * Compound commands are split into segments; each segment is evaluated
 * independently and the final decision is the most restrictive segment result
 * (deny > ask > allow). Opaque segments (unparseable constructs like $(...) or
 * backticks) skip pattern matching and ALWAYS resolve to "ask" — never the
 * default state. Inheriting the default would break the security model when
 * the default is allow: allow-rules for parseable commands must not extend to
 * commands we cannot parse.
 *
 * Redirect policy (only when `matchRedirectTarget` is provided): each OUTPUT
 * redirect in a segment (`>`, `>>`, `&>`, `<>`) is matched against redirect
 * patterns; if a redirect target resolves to a state more restrictive than the
 * segment's command state, the segment takes the redirect state. fd-dup
 * redirects (`2>&1`) are safe by construction and input redirection (`<`) never
 * writes files, so both are exempt. Unmatched redirect targets resolve to
 * `defaultState`.
 */
export function evaluateBashCommand(
  command: string,
  defaultState: PermissionState,
  matchCommand: (text: string) => BashSegmentMatch | null,
  matchRedirectTarget: ((target: string) => BashSegmentMatch | null) | null,
): BashCommandEvaluation {
  const segments = segmentBash(command);
  if (segments.length === 0) {
    return { state: defaultState, hasOpaqueSegments: false };
  }

  const segmentResults: Array<{
    state: PermissionState;
    matchedPattern?: string;
    redirectTarget?: string;
  }> = [];
  let hasOpaqueSegments = false;

  for (const segment of segments) {
    if (segment.opaque) {
      // Opaque segments ALWAYS resolve to "ask" — never the default state.
      // With an allow default, inheriting it would let unparseable commands
      // slip through the user's deny/ask rules.
      hasOpaqueSegments = true;
      segmentResults.push({ state: "ask" });
      continue;
    }

    const commandMatch = matchCommand(segment.text);
    let state = commandMatch?.state ?? defaultState;
    let matchedPattern = commandMatch?.matchedPattern;
    let redirectTarget: string | undefined;

    if (matchRedirectTarget) {
      for (const redirect of segment.redirects) {
        // Only output redirects are evaluated: fd-dup (2>&1) is safe by
        // construction, and input redirection (<) never writes files.
        if (redirect.isFdDup || redirect.op === "<") continue;
        const target = normalizeRedirectTarget(redirect.target);
        const redirectMatch = matchRedirectTarget(target);
        const redirectState = redirectMatch?.state ?? defaultState;
        if (PERMISSION_ORDER[redirectState] > PERMISSION_ORDER[state]) {
          state = redirectState;
          matchedPattern = redirectMatch?.matchedPattern;
          redirectTarget = target;
        }
      }
    }

    segmentResults.push({ state, matchedPattern, redirectTarget });
  }

  const state = combinePermissions(segmentResults.map((r) => r.state));
  const matchedPatterns = [
    ...new Set(segmentResults.filter((r) => r.matchedPattern).map((r) => r.matchedPattern!)),
  ];
  const decidingRedirect = segmentResults.find(
    (r) => r.state === state && r.redirectTarget,
  )?.redirectTarget;

  return {
    state,
    matchedPattern: matchedPatterns.length === 1 ? matchedPatterns[0] : undefined,
    redirectTarget: decidingRedirect,
    hasOpaqueSegments,
  };
}

export interface BashPermissionCheck {
  state: PermissionState;
  matchedPattern?: string;
  command: string;
  redirectTarget?: string;
  hasOpaqueSegments: boolean;
}

export class BashFilter {
  private readonly compiledPatterns: CompiledPattern[];
  private readonly compiledRedirectPatterns: CompiledPattern[];

  constructor(
    permissions: BashPermissionSource,
    private readonly defaultState: PermissionState,
    redirectPermissions: BashPermissionSource = {},
  ) {
    this.compiledPatterns = isCompiledPatternList(permissions)
      ? [...permissions]
      : compileWildcardPatterns(permissions);
    this.compiledRedirectPatterns = isCompiledPatternList(redirectPermissions)
      ? [...redirectPermissions]
      : compileWildcardPatterns(
          Object.fromEntries(
            Object.entries(redirectPermissions).map(([pattern, state]) => [
              expandHomeInPattern(pattern),
              state,
            ]),
          ),
        );
  }

  check(command: string): BashPermissionCheck {
    const evaluation = evaluateBashCommand(
      command,
      this.defaultState,
      (text) => findCompiledWildcardMatch(this.compiledPatterns, text),
      this.compiledRedirectPatterns.length > 0
        ? (target) => findCompiledWildcardMatch(this.compiledRedirectPatterns, target)
        : null,
    );
    return { ...evaluation, command };
  }
}
