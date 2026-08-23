// Golden tests for the bash lexer (Phase 1 of the tokenizer plan).
// Run with: bun ./tests/bash-lexer.test.ts
import assert from "node:assert/strict";
import { runTest } from "./test-harness.js";
import {
  hasUnknown,
  lexBash,
  normalizeCommand,
  segmentBash,
  type BashKeyword,
  type BashSegment,
  type BashToken,
  type WordPart,
} from "../src/bash-lexer.js";

// ---- Expected-token builders (offsets are relative to the input string) ----

const W = (
  value: string,
  start: number,
  end: number,
  parts?: WordPart[],
): BashToken => ({
  type: "word",
  value,
  parts: parts ?? [{ text: value, quote: null }],
  start,
  end,
});

const O = (
  value: "&&" | "||" | "|&" | "|" | ";" | "&" | "\n",
  start: number,
  end: number,
): BashToken => ({ type: "operator", value, start, end });

const R = (
  op: ">" | ">>" | "&>" | "<>" | "<",
  fd: number | null,
  target: string,
  isFdDup: boolean,
  start: number,
  end: number,
): BashToken => ({ type: "redirect", op, fd, target, isFdDup, start, end });

const H = (
  delimiter: string,
  body: string,
  dash: boolean,
  start: number,
  end: number,
): BashToken => ({ type: "heredoc", delimiter, body, dash, start, end });

const C = (text: string, start: number, end: number): BashToken => ({
  type: "comment",
  text,
  start,
  end,
});

const U = (text: string, start: number, end: number): BashToken => ({
  type: "unknown",
  text,
  start,
  end,
});

function expectTokens(name: string, input: string, expected: BashToken[]): void {
  runTest(name, () => {
    const actual = lexBash(input);
    assert.deepStrictEqual(actual, expected, `input: ${JSON.stringify(input)}`);
  });
}

// ===========================================================================
// normalizeCommand
// ===========================================================================

runTest("normalize: CRLF → LF", () => {
  assert.equal(normalizeCommand("a\r\nb"), "a\nb");
});

runTest("normalize: lone CR → LF", () => {
  assert.equal(normalizeCommand("a\rb"), "a\nb");
});

runTest("normalize: LF unchanged", () => {
  assert.equal(normalizeCommand("a\nb"), "a\nb");
});

// ===========================================================================
// Simple words and operators
// ===========================================================================

expectTokens("words: simple two-word command", "git status", [
  W("git", 0, 3),
  W("status", 4, 10),
]);

expectTokens("ops: && splits two commands", "cd dir && bun test", [
  W("cd", 0, 2),
  W("dir", 3, 6),
  O("&&", 7, 9),
  W("bun", 10, 13),
  W("test", 14, 18),
]);

expectTokens("ops: | pipe", "ls | grep foo", [
  W("ls", 0, 2),
  O("|", 3, 4),
  W("grep", 5, 9),
  W("foo", 10, 13),
]);

expectTokens("ops: ; semicolon", "cmd1; cmd2", [
  W("cmd1", 0, 4),
  O(";", 4, 5),
  W("cmd2", 6, 10),
]);

expectTokens("ops: newline", "cmd1\n cmd2", [
  W("cmd1", 0, 4),
  O("\n", 4, 5),
  W("cmd2", 6, 10),
]);

expectTokens("ops: & backgrounding", "cmd & bg", [
  W("cmd", 0, 3),
  O("&", 4, 5),
  W("bg", 6, 8),
]);

expectTokens("ops: || and |&", "a || b |& c", [
  W("a", 0, 1),
  O("||", 2, 4),
  W("b", 5, 6),
  O("|&", 7, 9),
  W("c", 10, 11),
]);

// ===========================================================================
// Quotes and escapes
// ===========================================================================

expectTokens("quotes: single-quoted word with operators inside", "echo 'a && b'", [
  W("echo", 0, 4),
  W("a && b", 5, 13, [{ text: "a && b", quote: "single" }]),
]);

expectTokens("quotes: double-quoted word with pipe inside", 'echo "a | b"', [
  W("echo", 0, 4),
  W("a | b", 5, 12, [{ text: "a | b", quote: "double" }]),
]);

expectTokens("quotes: mixed quoted and unquoted parts", "echo a'b'c", [
  W("echo", 0, 4),
  W("abc", 5, 10, [
    { text: "a", quote: null },
    { text: "b", quote: "single" },
    { text: "c", quote: null },
  ]),
]);

expectTokens("escapes: backslash-escaped operators are word content", "echo foo\\&\\& bar", [
  W("echo", 0, 4),
  W("foo&&", 5, 12, [{ text: "foo&&", quote: null }]),
  W("bar", 13, 16),
]);

expectTokens("unbalanced: single quote → unknown to end of input", "echo unbalanced'quote", [
  W("echo", 0, 4),
  U("unbalanced'quote", 5, 21),
]);

expectTokens("unbalanced: double quote → unknown to end of input", 'echo "unclosed', [
  W("echo", 0, 4),
  U('"unclosed', 5, 14),
]);

// ===========================================================================
// Comments
// ===========================================================================

expectTokens("comments: whole-line comment", "# comment", [
  C("# comment", 0, 9),
]);

expectTokens("comments: trailing comment", "cmd # trailing", [
  W("cmd", 0, 3),
  C("# trailing", 4, 14),
]);

expectTokens("comments: # mid-word is literal content", "echo foo#bar", [
  W("echo", 0, 4),
  W("foo#bar", 5, 12),
]);

expectTokens("comments: # after space starts a comment", "echo a # note", [
  W("echo", 0, 4),
  W("a", 5, 6),
  C("# note", 7, 13),
]);

// ===========================================================================
// Redirects
// ===========================================================================

expectTokens("redirect: stdout to file", "cmd > /dev/null", [
  W("cmd", 0, 3),
  R(">", null, "/dev/null", false, 4, 15),
]);

expectTokens("redirect: append", "cmd >> file", [
  W("cmd", 0, 3),
  R(">>", null, "file", false, 4, 11),
]);

expectTokens("redirect: stderr with fd prefix", "cmd 2> /tmp/err.log", [
  W("cmd", 0, 3),
  R(">", 2, "/tmp/err.log", false, 4, 19),
]);

expectTokens("redirect: fd 10 dup", "10>&2", [
  R(">", 10, "2", true, 0, 5),
]);

expectTokens("redirect: 2>&1 fd dup", "cmd 2>&1", [
  W("cmd", 0, 3),
  R(">", 2, "1", true, 4, 8),
]);

expectTokens("redirect: bare >&1 is a no-op dup", "cmd >&1", [
  W("cmd", 0, 3),
  R(">", null, "1", true, 4, 7),
]);

expectTokens("redirect: >&name (non-digit) is a file, not a dup", "cmd >&err", [
  W("cmd", 0, 3),
  R(">", null, "err", false, 4, 9),
]);

expectTokens("redirect: &> both streams to file", "cmd &> file", [
  W("cmd", 0, 3),
  R("&>", null, "file", false, 4, 11),
]);

expectTokens("redirect: &> after a word", "echo a &> file", [
  W("echo", 0, 4),
  W("a", 5, 6),
  R("&>", null, "file", false, 7, 14),
]);

expectTokens("redirect: input redirect", "cmd < file", [
  W("cmd", 0, 3),
  R("<", null, "file", false, 4, 10),
]);

expectTokens("redirect: <> read-write", "cmd <> file", [
  W("cmd", 0, 3),
  R("<>", null, "file", false, 4, 11),
]);

expectTokens("redirect: digit argument is NOT an fd (space before >)", "cmd 2 >file", [
  W("cmd", 0, 3),
  W("2", 4, 5),
  R(">", null, "file", false, 6, 11),
]);

expectTokens("redirect: mixed safe redirects (user's key case)", "cmd 2>&1 > /dev/null", [
  W("cmd", 0, 3),
  R(">", 2, "1", true, 4, 8),
  R(">", null, "/dev/null", false, 9, 20),
]);

expectTokens("redirect: quoted target", 'cmd > "out file"', [
  W("cmd", 0, 3),
  R(">", null, "out file", false, 4, 16),
]);

// ===========================================================================
// Heredocs
// ===========================================================================

expectTokens("heredoc: single-quoted delimiter, LF", "cat <<'EOF'\nhello\nEOF", [
  W("cat", 0, 3),
  H("EOF", "hello", false, 4, 11),
  O("\n", 11, 12),
]);

expectTokens("heredoc: unquoted delimiter, trailing newline", "cat <<EOF\nhello\nEOF\n", [
  W("cat", 0, 3),
  H("EOF", "hello", false, 4, 9),
  O("\n", 9, 10),
  O("\n", 19, 20),
]);

expectTokens("heredoc: command continues after the heredoc start", "cat <<'EOF' && echo done\nbody\nEOF", [
  W("cat", 0, 3),
  H("EOF", "body", false, 4, 11),
  O("&&", 12, 14),
  W("echo", 15, 19),
  W("done", 20, 24),
  O("\n", 24, 25),
]);

expectTokens("heredoc: empty body", "cat <<EOF\nEOF", [
  W("cat", 0, 3),
  H("EOF", "", false, 4, 9),
  O("\n", 9, 10),
]);

expectTokens("heredoc: <<- allows leading tabs on the delimiter line", "cat <<-\tEOF\n\thello\n\tEOF", [
  W("cat", 0, 3),
  H("EOF", "\thello", true, 4, 11),
  O("\n", 11, 12),
]);

expectTokens("heredoc: CRLF line endings", "cat <<'EOF'\r\nhello\r\nEOF", [
  W("cat", 0, 3),
  H("EOF", "hello", false, 4, 11),
  O("\n", 11, 12),
]);

expectTokens("heredoc: multiple heredocs on one line → unknown", "cmd <<A <<B\nx\nA\ny\nB", [
  W("cmd", 0, 3),
  U("<<A <<B\nx\nA\ny\nB", 4, 19),
]);

expectTokens("heredoc: unterminated body → unknown", "cat <<EOF\nhello", [
  W("cat", 0, 3),
  U("<<EOF\nhello", 4, 15),
]);

expectTokens("heredoc: here-string <<< is unknown, not a heredoc", 'grep x <<< "y"', [
  W("grep", 0, 4),
  W("x", 5, 6),
  U('<<< "y"', 7, 14),
]);

// ===========================================================================
// Subshells, grouping, backticks → unknown (opaque)
// ===========================================================================

expectTokens("subshell: $(...) produces unknown tokens", "echo $(weird)", [
  W("echo", 0, 4),
  W("$", 5, 6),
  U("(", 6, 7),
  W("weird", 7, 12),
  U(")", 12, 13),
]);

expectTokens("subshell: process substitution <(...) is opaque", "diff <(a) <(b)", [
  W("diff", 0, 4),
  R("<", null, "", false, 5, 6),
  U("(", 6, 7),
  W("a", 7, 8),
  U(")", 8, 9),
  R("<", null, "", false, 10, 11),
  U("(", 11, 12),
  W("b", 12, 13),
  U(")", 13, 14),
]);

expectTokens("backtick: substitution is unknown", "echo `ls`", [
  W("echo", 0, 4),
  U("`", 5, 6),
  W("ls", 6, 8),
  U("`", 8, 9),
]);
expectTokens("grouping: braces are unknown", "{ a; b; }", [
  U("{", 0, 1),
  W("a", 2, 3),
  O(";", 3, 4),
  W("b", 5, 6),
  O(";", 6, 7),
  U("}", 8, 9),
]);

// ===========================================================================
// hasUnknown
// ===========================================================================

runTest("hasUnknown: false for plain commands", () => {
  assert.equal(hasUnknown(lexBash("git status")), false);
});

runTest("hasUnknown: true for subshell commands", () => {
  assert.equal(hasUnknown(lexBash("echo $(weird)")), true);
});

runTest("hasUnknown: true for multiple heredocs", () => {
  assert.equal(hasUnknown(lexBash("cmd <<A <<B\nx\nA\ny\nB")), true);
});

// ===========================================================================
// Edge cases
// ===========================================================================

expectTokens("edge: empty input → no tokens", "", []);

expectTokens("edge: whitespace only → no tokens", "   \t  ", []);

expectTokens("edge: CRLF normalizes before lexing", "git status\r\n", [
  W("git", 0, 3),
  W("status", 4, 10),
  O("\n", 10, 11),
]);

expectTokens("edge: the user's originally-failing command", "cd pi-permission-system && bun tests/foo.test.ts 2>&1", [
  W("cd", 0, 2),
  W("pi-permission-system", 3, 23),
  O("&&", 24, 26),
  W("bun", 27, 30),
  W("tests/foo.test.ts", 31, 48),
  R(">", 2, "1", true, 49, 53),
]);

// ===========================================================================
// segmentBash
// ===========================================================================

function expectSegments(name: string, input: string, expected: BashSegment[]): void {
  runTest(name, () => {
    const actual = segmentBash(input);
    assert.deepStrictEqual(actual, expected, `input: ${JSON.stringify(input)}`);
  });
}

expectSegments("segment: single command is one segment", "git status", [
  { text: "git status", words: ["git", "status"], redirects: [], opaque: false },
]);

expectSegments("segment: && produces two segments", "cd dir && bun test", [
  { text: "cd dir", words: ["cd", "dir"], redirects: [], opaque: false },
  { text: "bun test", words: ["bun", "test"], redirects: [], opaque: false },
]);

expectSegments("segment: pipe separates pipeline elements", "cat file | grep foo | sort", [
  { text: "cat file", words: ["cat", "file"], redirects: [], opaque: false },
  { text: "grep foo", words: ["grep", "foo"], redirects: [], opaque: false },
  { text: "sort", words: ["sort"], redirects: [], opaque: false },
]);

expectSegments("segment: newline separates segments", "git status\nls -la", [
  { text: "git status", words: ["git", "status"], redirects: [], opaque: false },
  { text: "ls -la", words: ["ls", "-la"], redirects: [], opaque: false },
]);

expectSegments("segment: comment-only line produces no segment", "git status\n# just a comment", [
  { text: "git status", words: ["git", "status"], redirects: [], opaque: false },
]);

expectSegments("segment: trailing comment does not affect the segment", "git status # note", [
  { text: "git status", words: ["git", "status"], redirects: [], opaque: false },
]);

expectSegments("segment: redirects are attached to their segment", "cmd > /tmp/out.txt 2>&1", [
  {
    text: "cmd > /tmp/out.txt 2>&1",
    words: ["cmd"],
    redirects: [
      { op: ">", fd: null, target: "/tmp/out.txt", isFdDup: false },
      { op: ">", fd: 2, target: "1", isFdDup: true },
    ],
    opaque: false,
  },
]);

expectSegments("segment: heredoc body is not a segment", "cat <<'EOF' && echo done\nbody\nEOF", [
  { text: "cat <<'EOF'", words: ["cat"], redirects: [], opaque: false },
  { text: "echo done", words: ["echo", "done"], redirects: [], opaque: false },
]);

expectSegments("segment: unterminated heredoc consumes the rest (bash behavior)", "cat <<'EOF'\nhello\nEOF && echo done", [
  { text: "cat <<'EOF'\nhello\nEOF && echo done", words: ["cat"], redirects: [], opaque: true },
]);

expectSegments("segment: subshell makes the segment opaque", "echo $(cat file > /tmp/out)", [
  { text: "echo $(cat file > /tmp/out)", words: ["echo", "$", "cat", "file"], redirects: [{ op: ">", fd: null, target: "/tmp/out", isFdDup: false }], opaque: true },
]);

expectSegments("segment: multiple heredocs make the segment opaque", "cmd <<A <<B\nx\nA\ny\nB", [
  { text: "cmd <<A <<B\nx\nA\ny\nB", words: ["cmd"], redirects: [], opaque: true },
]);

expectSegments("segment: unbalanced quote makes the segment opaque", "echo unbalanced'quote", [
  { text: "echo unbalanced'quote", words: ["echo"], redirects: [], opaque: true },
]);

expectSegments("segment: empty input → no segments", "", []);

expectSegments("segment: whitespace only → no segments", "   ", []);

expectSegments("segment: the user's originally-failing command", "cd pi-permission-system && bun tests/foo.test.ts 2>&1", [
  { text: "cd pi-permission-system", words: ["cd", "pi-permission-system"], redirects: [], opaque: false },
  { text: "bun tests/foo.test.ts 2>&1", words: ["bun", "tests/foo.test.ts"], redirects: [{ op: ">", fd: 2, target: "1", isFdDup: true }], opaque: false },
]);

// ===========================================================================
// Control-flow keywords (Phase 6)
// ===========================================================================

const K = (value: BashKeyword, start: number, end: number): BashToken => ({
  type: "keyword",
  value,
  start,
  end,
});

expectTokens("kw: if/then/fi are keywords in command position", "if true; then echo hi; fi", [
  K("if", 0, 2),
  W("true", 3, 7),
  O(";", 7, 8),
  K("then", 9, 13),
  W("echo", 14, 18),
  W("hi", 19, 21),
  O(";", 21, 22),
  K("fi", 23, 25),
]);

expectTokens("kw: reserved word as argument stays a word", "echo if", [
  W("echo", 0, 4),
  W("if", 5, 7),
]);

expectTokens("kw: reserved words as arguments stay words", "echo then fi done do", [
  W("echo", 0, 4),
  W("then", 5, 9),
  W("fi", 10, 12),
  W("done", 13, 17),
  W("do", 18, 20),
]);

expectTokens("kw: grep if file.txt — argument position", "grep if file.txt", [
  W("grep", 0, 4),
  W("if", 5, 7),
  W("file.txt", 8, 16),
]);

expectTokens("kw: for header — variable is a word, in/do/done are keywords", "for x in a b; do echo $x; done", [
  K("for", 0, 3),
  W("x", 4, 5),
  K("in", 6, 8),
  W("a", 9, 10),
  W("b", 11, 12),
  O(";", 12, 13),
  K("do", 14, 16),
  W("echo", 17, 21),
  W("$x", 22, 24),
  O(";", 24, 25),
  K("done", 26, 30),
]);

expectTokens("kw: reserved words in the for list stay words", "for x in if then fi; do echo hi; done", [
  K("for", 0, 3),
  W("x", 4, 5),
  K("in", 6, 8),
  W("if", 9, 11),
  W("then", 12, 16),
  W("fi", 17, 19),
  O(";", 19, 20),
  K("do", 21, 23),
  W("echo", 24, 28),
  W("hi", 29, 31),
  O(";", 31, 32),
  K("done", 33, 37),
]);

expectTokens("kw: for without in (defaults to $@)", "for x; do echo $x; done", [
  K("for", 0, 3),
  W("x", 4, 5),
  O(";", 5, 6),
  K("do", 7, 9),
  W("echo", 10, 14),
  W("$x", 15, 17),
  O(";", 17, 18),
  K("done", 19, 23),
]);

expectTokens("kw: while loop", "while pgrep x; do kill x; done", [
  K("while", 0, 5),
  W("pgrep", 6, 11),
  W("x", 12, 13),
  O(";", 13, 14),
  K("do", 15, 17),
  W("kill", 18, 22),
  W("x", 23, 24),
  O(";", 24, 25),
  K("done", 26, 30),
]);

expectTokens("kw: until loop", "until false; do sleep 1; done", [
  K("until", 0, 5),
  W("false", 6, 11),
  O(";", 11, 12),
  K("do", 13, 15),
  W("sleep", 16, 21),
  W("1", 22, 23),
  O(";", 23, 24),
  K("done", 25, 29),
]);

expectTokens("kw: quoted keyword stays a word", '"if" true; then echo hi; fi', [
  W("if", 0, 4, [{ text: "if", quote: "double" }]),
  W("true", 5, 9),
  O(";", 9, 10),
  K("then", 11, 15),
  W("echo", 16, 20),
  W("hi", 21, 23),
  O(";", 23, 24),
  K("fi", 25, 27),
]);

expectTokens("kw: word after fi is not in command position", "if a; then b; fi extra", [
  K("if", 0, 2),
  W("a", 3, 4),
  O(";", 4, 5),
  K("then", 6, 10),
  W("b", 11, 12),
  O(";", 12, 13),
  K("fi", 14, 16),
  W("extra", 17, 22),
]);

// ---- Phase 6 segmentation ----

expectSegments("cf: if/then/fi — condition and branch are segments", "if true; then echo hi; fi", [
  { text: "true", words: ["true"], redirects: [], opaque: false },
  { text: "echo hi", words: ["echo", "hi"], redirects: [], opaque: false },
]);

expectSegments("cf: if/then/else/fi — all branches are segments", "if a; then b; else c; fi", [
  { text: "a", words: ["a"], redirects: [], opaque: false },
  { text: "b", words: ["b"], redirects: [], opaque: false },
  { text: "c", words: ["c"], redirects: [], opaque: false },
]);

expectSegments("cf: elif chain — every condition and branch is a segment", "if a; then b; elif c; then d; else e; fi", [
  { text: "a", words: ["a"], redirects: [], opaque: false },
  { text: "b", words: ["b"], redirects: [], opaque: false },
  { text: "c", words: ["c"], redirects: [], opaque: false },
  { text: "d", words: ["d"], redirects: [], opaque: false },
  { text: "e", words: ["e"], redirects: [], opaque: false },
]);

expectSegments("cf: && inside a condition splits it into segments", "if [ -f x ] && [ -r x ]; then rm x; fi", [
  { text: "[ -f x ]", words: ["[", "-f", "x", "]"], redirects: [], opaque: false },
  { text: "[ -r x ]", words: ["[", "-r", "x", "]"], redirects: [], opaque: false },
  { text: "rm x", words: ["rm", "x"], redirects: [], opaque: false },
]);

expectSegments("cf: while — condition and body are segments", "while pgrep x; do kill x; done", [
  { text: "pgrep x", words: ["pgrep", "x"], redirects: [], opaque: false },
  { text: "kill x", words: ["kill", "x"], redirects: [], opaque: false },
]);

expectSegments("cf: until — condition and body are segments", "until false; do sleep 1; done", [
  { text: "false", words: ["false"], redirects: [], opaque: false },
  { text: "sleep 1", words: ["sleep", "1"], redirects: [], opaque: false },
]);

expectSegments("cf: for — only the body is a segment (list is data)", "for f in a b c; do rm $f; done", [
  { text: "rm $f", words: ["rm", "$f"], redirects: [], opaque: false },
]);

expectSegments("cf: for without in — body only", "for f; do echo $f; done", [
  { text: "echo $f", words: ["echo", "$f"], redirects: [], opaque: false },
]);

expectSegments("cf: nested if + for", "if a; then for x in b; do c; done; fi", [
  { text: "a", words: ["a"], redirects: [], opaque: false },
  { text: "c", words: ["c"], redirects: [], opaque: false },
]);

expectSegments("cf: newline-separated structure", "if true\nthen\necho hi\nfi", [
  { text: "true", words: ["true"], redirects: [], opaque: false },
  { text: "echo hi", words: ["echo", "hi"], redirects: [], opaque: false },
]);

expectSegments("cf: comment inside a branch is skipped", "if true; then # why\necho hi; fi", [
  { text: "true", words: ["true"], redirects: [], opaque: false },
  { text: "echo hi", words: ["echo", "hi"], redirects: [], opaque: false },
]);

expectSegments("cf: trailing comment in a branch does not affect the text", "if true; then echo hi # bye\nfi", [
  { text: "true", words: ["true"], redirects: [], opaque: false },
  { text: "echo hi", words: ["echo", "hi"], redirects: [], opaque: false },
]);

expectSegments("cf: redirect attaches to the branch command", "if true; then echo hi > out.txt; fi", [
  { text: "true", words: ["true"], redirects: [], opaque: false },
  {
    text: "echo hi > out.txt",
    words: ["echo", "hi"],
    redirects: [{ op: ">", fd: null, target: "out.txt", isFdDup: false }],
    opaque: false,
  },
]);

expectSegments("cf: heredoc inside a branch", "if true; then cat <<'EOF'\nbody\nEOF\nfi", [
  { text: "true", words: ["true"], redirects: [], opaque: false },
  { text: "cat <<'EOF'", words: ["cat"], redirects: [], opaque: false },
]);

expectSegments("cf: per-segment opacity is preserved inside structures", "if true; then $(rm x); fi", [
  { text: "true", words: ["true"], redirects: [], opaque: false },
  { text: "$(rm x)", words: ["$", "rm", "x"], redirects: [], opaque: true },
]);

expectSegments("cf: lenient — trailing words after fi are extracted", "if a; then b; fi extra", [
  { text: "a", words: ["a"], redirects: [], opaque: false },
  { text: "b", words: ["b"], redirects: [], opaque: false },
  { text: "extra", words: ["extra"], redirects: [], opaque: false },
]);

expectSegments("cf: lenient — empty condition still extracts the branch", "if then a; fi", [
  { text: "a", words: ["a"], redirects: [], opaque: false },
]);

expectSegments("cf: lenient — newline before do is accepted", "for x in a b\ndo echo hi; done", [
  { text: "echo hi", words: ["echo", "hi"], redirects: [], opaque: false },
]);

// ---- Phase 6 structural failures → whole command opaque (always ask) ----

expectSegments("cf: missing fi → whole command opaque", "if a; then b", [
  { text: "if a; then b", words: ["a", "b"], redirects: [], opaque: true },
]);

expectSegments("cf: missing done (while) → whole command opaque", "while a; do b", [
  { text: "while a; do b", words: ["a", "b"], redirects: [], opaque: true },
]);

expectSegments("cf: missing done (for) → whole command opaque", "for x in l; do b", [
  { text: "for x in l; do b", words: ["x", "l", "b"], redirects: [], opaque: true },
]);

expectSegments("cf: missing fi with else → whole command opaque", "if a; then b; else c", [
  { text: "if a; then b; else c", words: ["a", "b", "c"], redirects: [], opaque: true },
]);

expectSegments("cf: stray then at input start → whole command opaque", "then echo hi", [
  { text: "then echo hi", words: ["echo", "hi"], redirects: [], opaque: true },
]);

expectSegments("cf: bare done → whole command opaque", "done", [
  { text: "done", words: [], redirects: [], opaque: true },
]);

expectSegments("cf: bare fi → whole command opaque", "fi", [
  { text: "fi", words: [], redirects: [], opaque: true },
]);

expectSegments("cf: for without a variable → whole command opaque", "for in a; do x; done", [
  { text: "for in a; do x; done", words: ["in", "a", "x"], redirects: [], opaque: true },
]);

expectSegments("cf: $(...) in the for list → whole command opaque (list is expanded by bash)", "for x in $(ls) a; do echo hi; done", [
  { text: "for x in $(ls) a; do echo hi; done", words: ["x", "$", "ls", "a", "echo", "hi"], redirects: [], opaque: true },
]);

expectSegments("cf: for arithmetic form ((...)) → whole command opaque", "for ((i=0; i<10; i++)); do echo hi; done", [
  { text: "for ((i=0; i<10; i++)); do echo hi; done", words: ["i=0", "i", "i++", "echo", "hi"], redirects: [{ op: "<", fd: null, target: "10", isFdDup: false }], opaque: true },
]);

expectSegments("cf: brace expansion in the for list → whole command opaque", "for x in {1..10}; do echo hi; done", [
  { text: "for x in {1..10}; do echo hi; done", words: ["x", "1..10", "echo", "hi"], redirects: [], opaque: true },
]);

expectSegments("cf: case/esac stays opaque (v1 does not parse case)", "case $x in foo) echo hi;; esac", [
  { text: "case $x in foo) echo hi", words: ["case", "$x", "in", "foo", "echo", "hi"], redirects: [], opaque: true },
  { text: "esac", words: ["esac"], redirects: [], opaque: false },
]);

{
  // 20 nested if/then structures exceed the depth cap (16) → opaque.
  const open = Array.from({ length: 20 }, (_, i) => `if a${i}; then`).join(" ");
  const close = Array.from({ length: 20 }, () => "fi;").join(" ");
  const input = `${open} echo hi; ${close}`;
  expectSegments("cf: nesting beyond the depth cap → whole command opaque", input, [
    {
      text: input,
      words: [...Array.from({ length: 20 }, (_, i) => `a${i}`), "echo", "hi"],
      redirects: [],
      opaque: true,
    },
  ]);
}

console.log("Bash lexer golden test suite complete.");
