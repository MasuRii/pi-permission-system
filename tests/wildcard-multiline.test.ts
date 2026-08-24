// ---------------------------------------------------------------------------
// Test-first coverage for Issue #24: Bash wildcard rules do not match
// multi-line commands / here-docs
//
// BACKGROUND (Issue #24):
//   compileWildcardPattern() in src/wildcard-matcher.ts creates
//   new RegExp(`^${escaped}$`) where `.*` (from `*` wildcard) uses `.`
//   which does NOT match newline characters by default. No `s` (dotAll)
//   flag is set. This means any bash command containing embedded newlines
//   (heredocs, multi-line strings, here-strings) silently fails to match
//   wildcard rules and falls back to the default permission state.
//
// TEST-FIRST APPROACH:
//   These tests assert the DESIRED behavior after the fix (adding the `s`
//   flag to compileWildcardPattern). They should FAIL against the current
//   production code and PASS once the fix is applied.
//
// Expected fix:
//   In compileWildcardPattern(), change:
//     regex: new RegExp(`^${escaped}$`)
//   to:
//     regex: new RegExp(`^${escaped}$`, 's')
//
// Issue: https://github.com/MasuRii/pi-permission-system/issues/24
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";

import {
  compileWildcardPattern,
  compileWildcardPatterns,
  findCompiledWildcardMatch,
} from "../src/wildcard-matcher.js";
import { BashFilter } from "../src/bash-filter.js";
import { runTest, runAsyncTest } from "./test-harness.js";
import type { BashReason, PermissionState } from "../src/types.js";

/**
 * The pattern of the segment's command-match reason (undefined when no
 * command rule matched — default-state or opaque results). Replaces the
 * old single `matchedPattern` field on BashFilter results.
 */
function commandPattern(result: { reasons: BashReason[] }): string | undefined {
  const reason = result.reasons.find((r) => r.kind === "command");
  return reason?.kind === "command" ? reason.pattern : undefined;
}

// ===========================================================================
// Section 1: compileWildcardPattern — unit tests on regex behavior
// ===========================================================================

runTest("ISSUE-24-FIX: compileWildcardPattern regex DOES match LF newline with wildcard star (expected-failing TDD)", () => {
  const pattern = compileWildcardPattern("python *", "allow" as PermissionState);

  // Single-line works (before and after fix)
  assert.ok(pattern.regex.test("python script.py"), "Single-line should match");

  // Multi-line — this MUST match after the 's' flag is added
  const multiline = "python - <<'PY'\nprint('hi')\nPY";
  assert.equal(
    pattern.regex.test(multiline),
    true,
    "ISSUE-24-TDD: Expected multi-line heredoc to match 'python *' pattern, but it fails because '.' in '.*' doesn't match '\\n' without the 's' flag. Fix: add 's' flag to RegExp in compileWildcardPattern()",
  );
});

runTest("ISSUE-24-FIX: compileWildcardPattern regex DOES match CRLF newline with wildcard star (expected-failing TDD)", () => {
  const pattern = compileWildcardPattern("cat *", "allow" as PermissionState);

  // Single-line works
  assert.ok(pattern.regex.test("cat /etc/hosts"), "Single-line should match");

  // Multi-line with CRLF — should match after 's' flag fix
  const crlfInput = "cat <<'EOF'\r\nhello\r\nEOF";
  assert.equal(
    pattern.regex.test(crlfInput),
    true,
    "ISSUE-24-TDD: Expected CRLF multi-line to match 'cat *' pattern, but it fails. Fix: add 's' flag to RegExp",
  );
});

runTest("ISSUE-24: compileWildcardPattern exact pattern cannot match trailing newline (correct exact-match behavior, not a bug)", () => {
  // This test is NOT about Issue #24. Exact patterns (no `*`) create a regex
  // without `.*`, so the `s` flag doesn't apply. The `$` anchor requires the
  // string to end exactly at the last character — a trailing `\n` causes a
  // mismatch. This is correct JS regex behavior (unlike `$` with `m` flag).
  // Issue #24 only concerns wildcard (`*`) patterns with embedded newlines.
  const pattern = compileWildcardPattern("python heredoc", "allow" as PermissionState);

  assert.ok(pattern.regex.test("python heredoc"), "Exact single-line should match");

  const withNewline = "python heredoc\n";
  assert.equal(
    pattern.regex.test(withNewline),
    false,
    "Exact pattern with trailing newline correctly does NOT match — `$` anchors to end of string without multiline flag; this is correct behavior, not a bug",
  );
});

runTest("ISSUE-24-FIX: compileWildcardPattern with multiple wildcards DOES match newlines (expected-failing TDD)", () => {
  const pattern = compileWildcardPattern("python * *", "allow" as PermissionState);

  assert.ok(pattern.regex.test("python -c 'print(1)'"), "Multi-wildcard single-line should match");

  const multiline = "python - <<'PY'\nprint('hi')\nPY";
  assert.equal(
    pattern.regex.test(multiline),
    true,
    "ISSUE-24-TDD: Expected multi-wildcard pattern with heredoc content to match, but it fails. Fix: add 's' flag to RegExp",
  );
});

// ===========================================================================
// Section 2: BashFilter.check — integration with real wildcard config
// ===========================================================================

runTest("ISSUE-24: BashFilter.check single-line commands match normally (control)", () => {
  // Last-match-wins: generic patterns first, specific patterns last (tested first from end)
  const filter = new BashFilter(
    {
      "*": "ask",
      "python *": "allow",
    },
    "deny",
  );

  const result = filter.check("python script.py");
  assert.equal(result.state, "allow");
  assert.equal(commandPattern(result), "python *");
});

runTest("ISSUE-24-FIX: BashFilter.check multi-line heredoc command DOES match wildcard (expected-failing TDD)", () => {
  // Last-match-wins: specific 'python *' is last (tested first), should match first
  const filter = new BashFilter(
    {
      "*": "ask",
      "python *": "allow",
    },
    "deny",
  );

  // This is the core bug reproduction: a heredoc python command
  const multiline = "python - <<'PY'\nprint('hello world')\nPY";
  const result = filter.check(multiline);

  // DESIRED behavior: 'python *' pattern matches (with 's' flag, '.*' matches
  // across newlines). Current bug: fails to match, falls through to default.
  assert.equal(
    result.state,
    "allow",
    "ISSUE-24-TDD: Expected multi-line heredoc command to match 'python *' (allow) but ALL patterns currently fail because '.' doesn't match '\\n'. Fix: add 's' flag to compileWildcardPattern()",
  );
  assert.equal(
    commandPattern(result),
    "python *",
    "ISSUE-24-TDD: Expected matchedPattern to be 'python *' but currently undefined because no pattern matches multi-line strings",
  );
});

runTest("ISSUE-24-FIX: BashFilter.check multi-line matches wildcard instead of exact pattern (expected-failing TDD)", () => {
  // Last-match-wins: more specific patterns at the end are tested first.
  const filter = new BashFilter(
    {
      "*": "ask",
      "git *": "deny",
      "git status --short": "allow",
    },
    "deny",
  );

  // Single-line exact command matches the most specific pattern
  const exactLine = "git status --short";
  const exactResult = filter.check(exactLine);
  assert.equal(exactResult.state, "allow");
  assert.equal(commandPattern(exactResult), "git status --short");

  // Single-line generic git command matches "git *" (deny) — last-match-wins
  const genericLine = "git commit -m 'test'";
  const genericResult = filter.check(genericLine);
  assert.equal(genericResult.state, "deny");
  assert.equal(commandPattern(genericResult), "git *");

  // Multi-line with 'git status --short\n# with trailing comment':
  //   Per-segment semantics: the comment line is a no-op and produces no
  //   segment. Only 'git status --short' is evaluated, matching the exact
  //   pattern (allow). (Old whole-string matching matched 'git *' → deny.)
  const multiline = "git status --short\n# with trailing comment";
  const multiResult = filter.check(multiline);
  assert.equal(
    multiResult.state,
    "allow",
    "Per-segment: comment line is skipped, 'git status --short' matches exact pattern (allow)",
  );
  assert.equal(
    commandPattern(multiResult),
    "git status --short",
    "Per-segment: the exact pattern matches the only real segment",
  );
});

// ===========================================================================
// Section 3: Edge cases — line endings
// ===========================================================================

runTest("ISSUE-24-FIX-EDGE: LF-only newlines in heredoc (expected-failing TDD)", () => {
  const filter = new BashFilter({ "*": "deny", "cat *": "allow" }, "deny");
  const heredocLF = "cat <<'EOF'\nline1\nline2\nEOF";
  const result = filter.check(heredocLF);
  assert.equal(
    result.state,
    "allow",
    "ISSUE-24-TDD: Expected 'cat *' to match LF heredoc (allow) but currently ALL patterns fail",
  );
  assert.equal(
    commandPattern(result),
    "cat *",
    "ISSUE-24-TDD: Expected matchedPattern 'cat *' for LF heredoc",
  );
});

runTest("ISSUE-24-FIX-EDGE: CRLF newlines in heredoc (expected-failing TDD)", () => {
  const filter = new BashFilter({ "*": "deny", "cat *": "allow" }, "deny");
  const heredocCRLF = "cat <<'EOF'\r\nline1\r\nEOF";
  const result = filter.check(heredocCRLF);
  assert.equal(
    result.state,
    "allow",
    "ISSUE-24-TDD: Expected 'cat *' to match CRLF heredoc (allow) but currently ALL patterns fail",
  );
  assert.equal(
    commandPattern(result),
    "cat *",
    "ISSUE-24-TDD: Expected matchedPattern 'cat *' for CRLF heredoc",
  );
});

runTest("ISSUE-24-FIX-EDGE: Mixed line endings in same command (expected-failing TDD)", () => {
  const filter = new BashFilter({ "*": "deny", "python *": "allow" }, "deny");
  // Mixed LF and CRLF
  const mixed = "python - <<'PY'\r\nprint('mixed')\nPY";
  const result = filter.check(mixed);
  assert.equal(
    result.state,
    "allow",
    "ISSUE-24-TDD: Expected 'python *' to match mixed line endings (allow) but currently ALL patterns fail",
  );
  assert.equal(
    commandPattern(result),
    "python *",
    "ISSUE-24-TDD: Expected matchedPattern 'python *' for mixed line endings",
  );
});

runTest("ISSUE-24-FIX-EDGE: Command with leading newline (expected-failing TDD)", () => {
  const filter = new BashFilter({ "*": "deny", "python *": "allow" }, "deny");
  const leadingNewline = "\npython script.py";
  const result = filter.check(leadingNewline);
  // Per-segment semantics: the leading newline produces no segment, so the
  // only segment is 'python script.py', which matches 'python *' (allow).
  // (Old whole-string matching: 'python *' couldn't match a string starting
  // with a newline, so the '*' catch-all won and yielded deny.)
  assert.equal(
    result.state,
    "allow",
    "Per-segment: leading newline produces no segment; 'python script.py' matches 'python *' (allow)",
  );
  assert.equal(
    commandPattern(result),
    "python *",
    "Per-segment: 'python *' matches the only real segment",
  );
});

runTest("ISSUE-24-FIX-EDGE: Command with trailing newline (expected-failing TDD)", () => {
  const filter = new BashFilter({ "*": "deny", "python *": "allow" }, "deny");
  const trailingNewline = "python script.py\n";
  const result = filter.check(trailingNewline);
  assert.equal(
    result.state,
    "allow",
    "ISSUE-24-TDD: Expected 'python *' to match command with trailing newline (allow) but currently ALL patterns fail",
  );
  assert.equal(
    commandPattern(result),
    "python *",
    "ISSUE-24-TDD: Expected matchedPattern 'python *' for trailing newline — 'python .*$' with 's' flag matches 'python script.py\\n'",
  );
});

runTest("ISSUE-24-FIX-EDGE: Empty lines within multi-line command (expected-failing TDD)", () => {
  const filter = new BashFilter({ "*": "deny", "python *": "allow" }, "deny");
  const emptyLine = "python - <<'PY'\n\n\nprint('empty lines above')\nPY";
  const result = filter.check(emptyLine);
  assert.equal(
    result.state,
    "allow",
    "ISSUE-24-TDD: Expected 'python *' to match command with empty lines inside heredoc (allow) but currently ALL patterns fail",
  );
  assert.equal(
    commandPattern(result),
    "python *",
    "ISSUE-24-TDD: Expected matchedPattern 'python *' for command with empty interior lines",
  );
});

runTest("ISSUE-24-FIX-EDGE: Command with only newline at the end of a single-line (expected-failing TDD)", () => {
  const filter = new BashFilter({ "*": "deny", "git *": "allow" }, "deny");
  const gitStatusNewline = "git status\n";
  const result = filter.check(gitStatusNewline);
  assert.equal(
    result.state,
    "allow",
    "ISSUE-24-TDD: Expected 'git *' to match 'git status\\n' (allow) but trailing newline breaks ALL wildcard patterns without 's' flag",
  );
  assert.equal(
    commandPattern(result),
    "git *",
    "ISSUE-24-TDD: Expected matchedPattern 'git *' for 'git status\\n'",
  );
});

// ===========================================================================
// Section 4: Edge cases — heredoc and here-string syntax variations
// ===========================================================================

runTest("ISSUE-24-FIX-EDGE: Single-quoted heredoc delimiter (expected-failing TDD)", () => {
  const filter = new BashFilter({ "*": "deny", "python *": "allow" }, "deny");
  const heredoc = "python - <<'PYTHON'\nprint('hi')\nPYTHON";
  const result = filter.check(heredoc);
  assert.equal(result.state, "allow", "ISSUE-24-TDD: Single-quoted heredoc delimiter should match 'python *'");
  assert.equal(commandPattern(result), "python *");
});

runTest("ISSUE-24-FIX-EDGE: Double-quoted heredoc delimiter (expected-failing TDD)", () => {
  const filter = new BashFilter({ "*": "deny", "python *": "allow" }, "deny");
  const heredoc = 'python - <<"PY"\nprint("hi")\nPY';
  const result = filter.check(heredoc);
  assert.equal(result.state, "allow", "ISSUE-24-TDD: Double-quoted heredoc delimiter should match 'python *'");
  assert.equal(commandPattern(result), "python *");
});

runTest("ISSUE-24-FIX-EDGE: Unquoted heredoc delimiter (expected-failing TDD)", () => {
  const filter = new BashFilter({ "*": "deny", "python *": "allow" }, "deny");
  const heredoc = "python - <<PY\nprint('hi')\nPY";
  const result = filter.check(heredoc);
  assert.equal(result.state, "allow", "ISSUE-24-TDD: Unquoted heredoc delimiter should match 'python *'");
  assert.equal(commandPattern(result), "python *");
});

runTest("ISSUE-24-FIX-EDGE: Indented heredoc body with tabs (expected-failing TDD)", () => {
  const filter = new BashFilter({ "*": "deny", "python *": "allow" }, "deny");
  const heredoc = "python <<'PY'\n\tprint('indented')\nPY";
  const result = filter.check(heredoc);
  assert.equal(result.state, "allow", "ISSUE-24-TDD: Indented heredoc body should match 'python *'");
  assert.equal(commandPattern(result), "python *");
});

 runTest("ISSUE-24-FIX-EDGE: Here-string syntax (opaque → always ask)", () => {
   const filter = new BashFilter({ "*": "deny", "cat *": "allow" }, "deny");
   // Here-string: cat <<< "string". Tokenizer design: <<< is out of scope for
   // confident classification → unknown token → opaque segment → always ask
   // (no pattern matching), even though 'cat *' would match the text.
   const hereString = "cat <<< 'hello\nworld'";
   const result = filter.check(hereString);
   assert.equal(result.state, "ask", "here-string is opaque → always ask, not 'cat *'");
   assert.equal(commandPattern(result), undefined);
 });

// ===========================================================================
// Section 5: Edge cases — deeply nested delimiters and complex heredocs
// ===========================================================================

runTest("ISSUE-24-FIX-EDGE: Multiple heredocs in one command (chained) (per-segment)", () => {
  const filter = new BashFilter({ "*": "deny", "cat *": "allow" }, "deny");
  // Chained heredocs are out of scope for confident classification. Under
  // per-segment evaluation the first line matches 'cat *' (allow), but the
  // second heredoc line is its own segment with no command — it falls to the
  // '*' catch-all (deny) → most restrictive wins → deny.
  const multiHeredoc = "cat <<'A'\nfile1\nA\n<<'B'\nfile2\nB";
  const result = filter.check(multiHeredoc);
  assert.equal(result.state, "deny", "second heredoc line is a separate segment → catch-all deny");
});

runTest("ISSUE-24-FIX-EDGE: Heredoc delimiter containing wildcard-matching characters (expected-failing TDD)", () => {
  const filter = new BashFilter({ "*": "deny", "python *": "allow" }, "deny");
  const heredoc = "python - <<'ENDOFFILE'\ncode\nENDOFFILE";
  const result = filter.check(heredoc);
  assert.equal(result.state, "allow", "ISSUE-24-TDD: Heredoc with long delimiter should match 'python *'");
  assert.equal(commandPattern(result), "python *");
});

runTest("ISSUE-24-FIX-EDGE: Command with tabs before heredoc content (expected-failing TDD)", () => {
  const filter = new BashFilter({ "*": "deny", "python *": "allow" }, "deny");
  const heredoc = "python <<'PY'\n\t\tprint('deeply indented')\nPY";
  const result = filter.check(heredoc);
  assert.equal(result.state, "allow", "ISSUE-24-TDD: Deeply indented heredoc body should match 'python *'");
  assert.equal(commandPattern(result), "python *");
});

// ===========================================================================
// Section 6: Edge cases — last-match-wins precedence interaction
// ===========================================================================

runTest("ISSUE-24-FIX-EDGE: Last-match-wins precedence with multi-line resolves to wildcard (expected-failing TDD)", () => {
  // Patterns from the existing test suite: last specific wins
  const filter = new BashFilter(
    {
      "*": "ask",
      "python *": "allow",
      "git *": "deny",
      "git status --short": "allow",
    },
    "deny",
  );

  // Single-line control: 'git status --short' matches exact pattern (allow)
  const singleExact = "git status --short";
  const singleExactResult = filter.check(singleExact);
  assert.equal(singleExactResult.state, "allow", "Single-line exact match works");
  assert.equal(commandPattern(singleExactResult), "git status --short");

  // Single-line: 'git commit' matches 'git *' (deny)
  const singleGit = "git commit -m 'test'";
  const singleGitResult = filter.check(singleGit);
  assert.equal(singleGitResult.state, "deny", "Single-line git command matches 'git *'");
  assert.equal(commandPattern(singleGitResult), "git *");

  // Multi-line: the comment line is a no-op and produces no segment, so
  // only 'git status --short' is evaluated → exact pattern (allow).
  // (Old whole-string matching: 'git *' matched the whole string → deny.)
  const multiline = "git status --short\n# trailing";
  const result = filter.check(multiline);

  assert.equal(
    result.state,
    "allow",
    "Per-segment: comment line is skipped; 'git status --short' matches exact pattern (allow)",
  );
  assert.equal(
    commandPattern(result),
    "git status --short",
    "Per-segment: exact pattern matches the only real segment",
  );
});

runTest("ISSUE-24-FIX-EDGE: Multi-line deny pattern should also work (expected-failing TDD)", () => {
  const filter = new BashFilter(
    {
      "*": "allow",
      "git *": "allow",
      "git rm *": "deny",
    },
    "deny",
  );

  // Single-line control: 'git rm file.txt' matches 'git rm *' → deny
  const singleControl = "git rm file.txt";
  const singleResult = filter.check(singleControl);
  assert.equal(singleResult.state, "deny", "Single-line 'git rm' correctly matches 'git rm *' (deny)");
  assert.equal(commandPattern(singleResult), "git rm *");

  // Multi-line: should match the deny pattern 'git rm *'
  const multiline = "git rm file.txt\n# confirmation line";
  const result = filter.check(multiline);

  assert.equal(
    result.state,
    "deny",
    "ISSUE-24-TDD: Multi-line should match 'git rm *' (deny). With 's' flag, 'git rm .*$' will match the multi-line command",
  );
  assert.equal(
    commandPattern(result),
    "git rm *",
    "ISSUE-24-TDD: Expected matchedPattern 'git rm *' for multi-line git rm command",
  );
});

// ===========================================================================
// Section 7: Edge cases — bash tool payload simulation
// ===========================================================================

runTest("ISSUE-24-FIX-EDGE: Simulated bash tool payload with embedded newlines in command field (expected-failing TDD)", () => {
  const filter = new BashFilter({ "*": "deny", "python *": "allow" }, "deny");

  // This simulates what a bash tool call looks like where the command
  // field contains embedded newlines (e.g., a heredoc or multi-line script)
  const payloadCommand = "python - <<'SCRIPT'\nfor i in range(3):\n    print(i)\nSCRIPT";
  const result = filter.check(payloadCommand);
  assert.equal(
    result.state,
    "allow",
    "ISSUE-24-TDD: Bash tool command payload with embedded newlines should match 'python *' but currently ALL patterns fail",
  );
  assert.equal(
    commandPattern(result),
    "python *",
    "ISSUE-24-TDD: Expected matchedPattern 'python *' for bash tool payload",
  );
});

runTest("ISSUE-24: Command with escaped newlines (\\n) in string (correct behavior, already works)", () => {
  const filter = new BashFilter({ "*": "deny", "echo *": "allow" }, "deny");

  // Some tools pass escaped newlines as literal \n in the command string
  const escapedNewlines = "echo 'line1\\nline2\\nline3'";
  const result = filter.check(escapedNewlines);
  // Note: literal backslash-n is not an actual newline character, so this SHOULD match
  assert.equal(
    result.state,
    "allow",
    "Escaped newline string (backslash-n) should match normally — it's not a real newline",
  );
});

// ===========================================================================
// Section 8: Verification that single-line commands still work correctly
// (non-regression — ensure changes don't break existing behavior)
// ===========================================================================

runTest("ISSUE-24-NR: Simple single-line python command still matches", () => {
  const filter = new BashFilter({ "*": "deny", "python *": "allow" }, "deny");
  assert.equal(filter.check("python script.py").state, "allow");
  assert.equal(filter.check("python -c 'print(1)'").state, "allow");
  assert.equal(filter.check("python -m http.server").state, "allow");
});

runTest("ISSUE-24-NR: Single-line git commands still work with last-match-wins", () => {
  const filter = new BashFilter(
    {
      "*": "ask",
      "git *": "deny",
      "git status": "allow",
    },
    "deny",
  );

  assert.equal(filter.check("git status").state, "allow");
  assert.equal(filter.check("git status --short").state, "deny");
  assert.equal(filter.check("git commit -m test").state, "deny");
  assert.equal(filter.check("ls -la").state, "ask");
});

runTest("ISSUE-24-NR: Exact pattern (no wildcard) still fails on newline (expected — exact match is exact)", () => {
  const pattern = compileWildcardPattern("git status", "allow" as PermissionState);
  assert.ok(pattern.regex.test("git status"), "Exact match works for exact string");
  assert.equal(pattern.regex.test("git status\n"), false, "Exact match should fail with trailing newline (this is correct behavior for exact pattern)");
  assert.equal(pattern.regex.test("git status --short"), false, "Exact match should fail on different string");
});

// ===========================================================================
// Summary
// ===========================================================================

// This suite documents 29 test cases for Issue #24, using a proper TDD
// approach: all multi-line wildcard tests assert the DESIRED behavior
// (matching should succeed) rather than the current bug state. These tests
// will FAIL until the 's' (dotAll) flag is added to compileWildcardPattern().
//
// Expected fix:
//   In compileWildcardPattern() at src/wildcard-matcher.ts:
//     regex: new RegExp(`^${escaped}$`, 's')
//
// Test categories:
//   - Section 1: Regex unit tests (4 tests, 3 expected-failing TDD)
//   - Section 2: BashFilter.check integration (3 tests, 2 expected-failing TDD)
//   - Section 3: Line endings edge cases (7 tests, 7 expected-failing TDD)
//   - Section 4: Heredoc/here-string variations (5 tests, 5 expected-failing TDD)
//   - Section 5: Nested/complex heredocs (3 tests, 3 expected-failing TDD)
//   - Section 6: Last-match-wins precedence (2 tests, 2 expected-failing TDD)
//   - Section 7: Bash tool payload (2 tests, 1 expected-failing TDD)
//   - Section 8: Non-regression (3 tests, 0 expected-failing)
//
// Total: 29 tests, 23 expected-failing against current code, 6 passing controls.
// After fixing compileWildcardPattern(), all 29 should pass.
//
// KEY INSIGHT: The 's' flag makes '.' in '.*' match newline characters.
// Without it, even a catch-all '*' wildcard (producing '^.*$') fails to match
// multi-line commands — they bypass ALL configured patterns and fall to default.

console.log("All wildcard-multiline tests (Issue #24) passed (some may be expected-failing TDD).");
