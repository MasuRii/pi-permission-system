import { homedir } from "node:os";
import { join, normalize } from "node:path";

import type { BashPermissions, BashReason, PermissionState } from "./types.js";
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
  /**
   * One reason per segment whose state equals the final (most restrictive)
   * state, in segment order. The reason for a segment is every factor that
   * shares the segment's final state: its command-pattern match (when it set
   * the state), each output-redirect match that set the state, or "default"
   * when no rule matched at a deciding level. Opaque segments contribute an
   * "opaque" reason (they always resolve to "ask").
   */
  reasons: BashReason[];
  /** Total number of segments (used to decide "segment N" prompt prefixes). */
  segmentCount: number;
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
    return { state: defaultState, reasons: [], segmentCount: 0, hasOpaqueSegments: false };
  }

  interface RedirectOutcome {
    target: string;
    pattern: string;
    state: PermissionState;
  }

  interface SegmentOutcome {
    state: PermissionState;
    opaque: boolean;
    commandMatch: { pattern: string; state: PermissionState } | null;
    redirectMatches: RedirectOutcome[];
  }

  const outcomes: SegmentOutcome[] = segments.map((segment) => {
    if (segment.opaque) {
      // Opaque segments ALWAYS resolve to "ask" — never the default state.
      // With an allow default, inheriting it would let unparseable commands
      // slip through the user's deny/ask rules.
      return { state: "ask" as PermissionState, opaque: true, commandMatch: null, redirectMatches: [] };
    }

    const commandMatch = matchCommand(segment.text);
    let state = commandMatch?.state ?? defaultState;

    const redirectMatches: RedirectOutcome[] = [];
    if (matchRedirectTarget) {
      for (const redirect of segment.redirects) {
        // Only output redirects are evaluated: fd-dup (2>&1) is safe by
        // construction, and input redirection (<) never writes files.
        if (redirect.isFdDup || redirect.op === "<") continue;
        const target = normalizeRedirectTarget(redirect.target);
        const redirectMatch = matchRedirectTarget(target);
        const redirectState = redirectMatch?.state ?? defaultState;
        redirectMatches.push({
          target,
          pattern: redirectMatch?.matchedPattern ?? "",
          state: redirectState,
        });
        if (PERMISSION_ORDER[redirectState] > PERMISSION_ORDER[state]) {
          state = redirectState;
        }
      }
    }

    return {
      state,
      opaque: false,
      commandMatch: commandMatch
        ? { pattern: commandMatch.matchedPattern ?? "", state: commandMatch.state }
        : null,
      redirectMatches,
    };
  });

  const state = combinePermissions(outcomes.map((o) => o.state));
  const hasOpaqueSegments = outcomes.some((o) => o.opaque);

  // Emit one reason per deciding segment (segment state === final state).
  // Within a deciding segment, every factor that shares the segment's final
  // state is reported: the command match (when it set the state), each
  // redirect match that set the state, or "default" when nothing matched at
  // a deciding level.
  const reasons: BashReason[] = [];
  outcomes.forEach((outcome, index) => {
    if (outcome.state !== state) return;
    const segmentIndex = index + 1;
    if (outcome.opaque) {
      reasons.push({ kind: "opaque", segmentIndex });
      return;
    }
    let emitted = false;
    if (outcome.commandMatch && outcome.commandMatch.state === outcome.state) {
      reasons.push({ kind: "command", segmentIndex, pattern: outcome.commandMatch.pattern });
      emitted = true;
    }
    for (const redirect of outcome.redirectMatches) {
      if (redirect.state === outcome.state) {
        reasons.push({ kind: "redirect", segmentIndex, target: redirect.target, pattern: redirect.pattern });
        emitted = true;
      }
    }
    if (!emitted) {
      reasons.push({ kind: "default", segmentIndex });
    }
  });

  return { state, reasons, segmentCount: segments.length, hasOpaqueSegments };
}

export interface BashPermissionCheck {
  state: PermissionState;
  command: string;
  reasons: BashReason[];
  segmentCount: number;
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
    return { state: evaluation.state, command, reasons: evaluation.reasons, segmentCount: evaluation.segmentCount, hasOpaqueSegments: evaluation.hasOpaqueSegments };
  }
}
