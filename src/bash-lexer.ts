/**
 * Conservative bash lexer for permission classification.
 *
 * This is a classifier, not a complete shell parser. It tokenizes the common
 * cases commands actually emit, and degrades to `unknown` tokens for anything
 * esoteric (unbalanced quotes, subshells, backticks, multiple heredocs on one
 * line, ...). A segment containing an `unknown` token is "opaque": it skips
 * pattern matching entirely and always resolves to "ask" (never the default
 * state). When in doubt, we ask the user rather than guess.
 *
 * Control-flow keywords (if/elif/then/else/fi, for/in/do/done, while/until)
 * are recognized in command position and walked structurally by
 * `segmentBash`: conditions, branches, and loop bodies become segments. A
 * structure that cannot be walked with confidence makes the whole command
 * one opaque segment.
 *
 * See bash-permission-tokenizer-plan.md for the full design.
 */

export type WordPart = {
  text: string;
  quote: "single" | "double" | null;
};

export type BashKeyword =
  | "if" | "elif" | "then" | "else" | "fi"
  | "for" | "in" | "do" | "done"
  | "while" | "until";

export type BashToken =
  | { type: "word"; value: string; parts: WordPart[]; start: number; end: number }
  | { type: "keyword"; value: BashKeyword; start: number; end: number }
  | {
      type: "operator";
      value: "&&" | "||" | "|&" | "|" | ";" | "&" | "\n";
      start: number;
      end: number;
    }
  | {
      type: "redirect";
      op: ">" | ">>" | "&>" | "<>" | "<";
      fd: number | null;
      target: string;
      isFdDup: boolean;
      start: number;
      end: number;
    }
  | {
      type: "heredoc";
      delimiter: string;
      body: string;
      dash: boolean;
      start: number;
      end: number;
    }
  | { type: "comment"; text: string; start: number; end: number }
  | { type: "unknown"; text: string; start: number; end: number };

const isSpace = (ch: string): boolean => ch === " " || ch === "\t";
const isDigit = (ch: string): boolean => ch >= "0" && ch <= "9";
const isBareDigits = (w: string): boolean => w.length > 0 && [...w].every(isDigit);

/** Normalize CRLF and CR line endings to LF. */
export function normalizeCommand(command: string): string {
  return command.replace(/\r\n?/g, "\n");
}

/** True when the token stream contains any unknown token. */
export function hasUnknown(tokens: readonly BashToken[]): boolean {
  return tokens.some((t) => t.type === "unknown");
}

export interface BashRedirect {
  op: ">" | ">>" | "&>" | "<>" | "<";
  fd: number | null;
  target: string;
  /** True for fd-dup redirects like 2>&1 (safe by construction). */
  isFdDup: boolean;
}

export interface BashSegment {
  /** Normalized source slice for this segment (for pattern matching & prompts). */
  text: string;
  words: string[];
  redirects: BashRedirect[];
  /**
    * True when the segment contains unknown tokens. Opaque segments skip
    * pattern matching entirely and always resolve to "ask" (never the
    * default state).
    */
  opaque: boolean;
}

// Bash reserved words recognized as structural keywords. `case`/`esac` and
// `select` are deliberately NOT included: they stay ordinary words, and their
// constructs degrade to opaque via existing `unknown` tokens (`)` etc.).
const RESERVED_WORDS = new Set<string>([
  "if", "elif", "then", "else", "fi",
  "for", "in", "do", "done",
  "while", "until",
]);

// Keywords after which a command (or condition) follows, so the next word is
// again in command position.
const COMMAND_INTRODUCING = new Set<string>([
  "if", "elif", "then", "else", "do", "while", "until",
]);

export function lexBash(command: string): BashToken[] {
  const s = normalizeCommand(command);
  const n = s.length;
  const tokens: BashToken[] = [];
  let i = 0;
  // After a heredoc's command line ends at skip.atNewline, the body region
  // (up to skip.to) is data, not commands — resume lexing past it.
  let heredocSkip: { atNewline: number; to: number } | null = null;

  // Keyword-recognition state (mirrors bash reserved-word rules): a reserved
  // word is a keyword only in "command position" (where a command name would
  // go), so `echo if` keeps `if` as an argument. Quoted words are never
  // keywords.
  //   cmd      — next word may be a keyword (input start, after any operator,
  //              after a command-introducing keyword)
  //   arg      — inside a simple command (after a word, redirect, or heredoc)
  //   forvar   — right after the `for` keyword: next word is a variable
  //   aftervar — after the for variable: an unquoted `in` is a keyword
  type KwState = "cmd" | "arg" | "forvar" | "aftervar";
  let kwState: KwState = "cmd";

  const markOperator = (): void => {
    kwState = "cmd";
  };
  // A simple command has begun: subsequent words are arguments, not commands.
  const markCommandStarted = (): void => {
    if (kwState === "cmd") kwState = "arg";
  };

  const unknownToken = (start: number, end: number): BashToken => ({
    type: "unknown",
    text: s.slice(start, end),
    start,
    end,
  });

  /**
   * Read a simple word (used for redirect targets): up to whitespace or an
   * operator, honoring quotes. Returns [text, nextIndex, unbalanced].
   */
  const readTargetWord = (from: number): [string, number, boolean] => {
    let j = from;
    let out = "";
    while (j < n) {
      const ch = s[j];
      if (
        isSpace(ch) || ch === "\n" || ch === ";" || ch === "|" || ch === "&" ||
        ch === "<" || ch === ">" || ch === "(" || ch === ")" || ch === "{" || ch === "}"
      ) {
        break;
      }
      if (ch === "\\" && j + 1 < n) {
        out += s[j + 1];
        j += 2;
        continue;
      }
      if (ch === "'" || ch === '"') {
        const q = ch;
        let k = j + 1;
        let closed = false;
        while (k < n) {
          if (q === '"' && s[k] === "\\" && k + 1 < n) {
            k += 2;
            continue;
          }
          if (s[k] === q) {
            closed = true;
            break;
          }
          k++;
        }
        if (!closed) return [out, n, true];
        out += s.slice(j + 1, k);
        j = k + 1;
        continue;
      }
      out += ch;
      j++;
    }
    return [out, j, false];
  };

  /**
   * Read a redirect starting at `from` (points at `<`, `>`, or the `&` of
   * `&>`). `fd` is set when the preceding word was a bare digit prefix
   * (2>, 10>>); `start` is the token's span start (the fd digits when
   * present, otherwise `from`).
   */
  const readRedirect = (
    from: number,
    fd: number | null,
    start: number = from,
  ): [BashToken, number] => {
    let j = from;
    let op: ">" | ">>" | "&>" | "<>" | "<";
    let fdDup = false;

    if (s[j] === "&" && s[j + 1] === ">") {
      // &>file (both streams to file). The fd-prefixed dup form (2>&1)
      // arrives with s[j] === ">", so `&` here always means &>.
      op = "&>";
      j += 2;
    } else if (s[j] === ">") {
      op = s[j + 1] === ">" ? ">>" : ">";
      j += op.length;
      if (s[j] === "&") {
        fdDup = true;
        j++;
      }
    } else {
      // s[j] === "<"
      op = s[j + 1] === ">" ? "<>" : "<";
      j += op.length;
    }

    while (j < n && isSpace(s[j])) j++;

    const [target, next, unbalanced] = readTargetWord(j);
    if (unbalanced) {
      return [unknownToken(start, n), n];
    }
    // >&name where name is not a digit is a file redirect, not a dup.
    if (fdDup && !isBareDigits(target)) {
      fdDup = false;
    }
    return [
      { type: "redirect", op, fd, target, isFdDup: fdDup, start, end: next },
      next,
    ];
  };

  /**
   * Read a heredoc starting at `from` (points at the first `<` of `<<`).
   * The token span covers only the `<<[delim]` construct on the command
   * line; the body is payload data. Returns [token, nextIndex, skip] where
   * nextIndex is right after the delimiter word (the rest of the command
   * line is still lexed normally) and skip marks the body region: after the
   * newline at skip.atNewline is consumed, resume at skip.to (past the body).
   * Degrades to unknown for anything it cannot handle (multiple heredocs on
   * one line, unterminated body, ...).
   */
  const readHeredoc = (
    from: number,
  ): [BashToken, number, { atNewline: number; to: number } | null] => {
    const start = from;
    let j = from + 2; // past <<
    const dash = s[j] === "-";
    if (dash) j++;
    while (j < n && isSpace(s[j])) j++;

    // Read the delimiter (optionally quoted).
    let delimiter = "";
    if (s[j] === "'" || s[j] === '"') {
      const q = s[j];
      let k = j + 1;
      let closed = false;
      while (k < n) {
        if (s[k] === q) {
          closed = true;
          break;
        }
        k++;
      }
      if (!closed) return [unknownToken(start, n), n, null];
      delimiter = s.slice(j + 1, k);
      j = k + 1;
    } else {
      while (
        j < n &&
        !isSpace(s[j]) && s[j] !== "\n" && s[j] !== ";" &&
        s[j] !== "&" && s[j] !== "|"
      ) {
        delimiter += s[j];
        j++;
      }
    }

    if (delimiter.length === 0) {
      return [unknownToken(start, n), n, null];
    }

    const lineEnd = s.indexOf("\n", j);
    if (lineEnd === -1) {
      // No newline after the command line: malformed heredoc.
      return [unknownToken(start, n), n, null];
    }

    // Out of scope: multiple heredocs on one line → unknown for the rest.
    if (s.slice(j, lineEnd).includes("<<")) {
      return [unknownToken(start, n), n, null];
    }

    // Read the body: lines after the command line up to the delimiter line.
    let body = "";
    let lineStart = lineEnd + 1;
    let bodyEnd = -1; // index of the \n after the delimiter line (or n)
    while (lineStart <= n) {
      let le = s.indexOf("\n", lineStart);
      if (le === -1) le = n;
      const line = s.slice(lineStart, le);
      const trimmed = dash ? line.replace(/^\t+/, "") : line;
      if (trimmed === delimiter) {
        bodyEnd = le;
        break;
      }
      body += body === "" ? line : "\n" + line;
      lineStart = le + 1;
    }

    if (bodyEnd === -1) {
      // Unterminated heredoc: unknown for the rest of the input.
      return [unknownToken(start, n), n, null];
    }

    return [
      { type: "heredoc", delimiter, body, dash, start, end: j },
      j,
      { atNewline: lineEnd, to: bodyEnd },
    ];
  };

  /**
   * Read a word starting at `from`. If the word is a bare digit sequence
   * immediately followed by `<` or `>` (but not `<<`), it is an fd prefix
   * (2>, 10>>) and a redirect token is returned instead.
   */
  const readWord = (from: number): [BashToken, number] => {
    const start = from;
    const parts: WordPart[] = [];
    let current = "";
    let j = from;

    while (j < n) {
      const ch = s[j];

      if (
        isSpace(ch) || ch === "\n" || ch === ";" || ch === "|" || ch === "&" ||
        ch === "(" || ch === ")" || ch === "{" || ch === "}" || ch === "`"
      ) {
        break;
      }

      if (ch === "<" || ch === ">") {
        // A redirect starts here. If the word so far is a bare digit
        // sequence, it is the fd (e.g. 2>, 10>>). `<<` is a heredoc, not a
        // redirect — leave it to the main loop.
        if (
          parts.length === 0 && isBareDigits(current) &&
          (ch === ">" || s[j + 1] !== "<")
        ) {
          const [redir, next] = readRedirect(j, parseInt(current, 10), start);
          return [redir, next];
        }
        break;
      }

      if (ch === "\\") {
        if (j + 1 < n) {
          current += s[j + 1];
          j += 2;
          continue;
        }
        // Dangling escape at EOF.
        return [unknownToken(start, n), n];
      }

      if (ch === "'" || ch === '"') {
        const q = ch;
        let k = j + 1;
        let closed = false;
        while (k < n) {
          if (q === '"' && s[k] === "\\" && k + 1 < n) {
            k += 2;
            continue;
          }
          if (s[k] === q) {
            closed = true;
            break;
          }
          k++;
        }
        if (!closed) {
          // Unbalanced quote: the rest of the input is untrustworthy.
          return [unknownToken(start, n), n];
        }
        if (current.length > 0) {
          parts.push({ text: current, quote: null });
          current = "";
        }
        parts.push({ text: s.slice(j + 1, k), quote: q === "'" ? "single" : "double" });
        j = k + 1;
        continue;
      }

      current += ch;
      j++;
    }

    if (parts.length === 0 && current.length === 0) {
      // No content (defensive; the main loop should not call readWord here).
      return [unknownToken(start, start + 1), start + 1];
    }
    if (current.length > 0) {
      parts.push({ text: current, quote: null });
    }
    return [
      {
        type: "word",
        value: parts.map((p) => p.text).join(""),
        parts,
        start,
        end: j,
      },
      j,
    ];
  };

  while (i < n) {
    const ch = s[i];

    if (isSpace(ch)) {
      i++;
      continue;
    }

    if (ch === "\n" || ch === ";") {
      tokens.push({ type: "operator", value: ch, start: i, end: i + 1 });
      markOperator();
      i++;
      if (heredocSkip && ch === "\n" && i === heredocSkip.atNewline + 1) {
        i = heredocSkip.to;
        heredocSkip = null;
      }
      continue;
    }

    if (ch === "#") {
      // Word-start # starts a comment to end of line.
      let j = i;
      while (j < n && s[j] !== "\n") j++;
      tokens.push({ type: "comment", text: s.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }

    if (ch === "&") {
      if (s[i + 1] === "&") {
        tokens.push({ type: "operator", value: "&&", start: i, end: i + 2 });
        markOperator();
        i += 2;
        continue;
      }
      if (s[i + 1] === ">") {
        const [redir, next] = readRedirect(i, null);
        tokens.push(redir);
        markCommandStarted();
        i = next;
        continue;
      }
      tokens.push({ type: "operator", value: "&", start: i, end: i + 1 });
      markOperator();
      i++;
      continue;
    }

    if (ch === "|") {
      if (s[i + 1] === "|") {
        tokens.push({ type: "operator", value: "||", start: i, end: i + 2 });
        markOperator();
        i += 2;
        continue;
      }
      if (s[i + 1] === "&") {
        tokens.push({ type: "operator", value: "|&", start: i, end: i + 2 });
        markOperator();
        i += 2;
        continue;
      }
      tokens.push({ type: "operator", value: "|", start: i, end: i + 1 });
      markOperator();
      i++;
      continue;
    }

    if (ch === "(" || ch === ")" || ch === "{" || ch === "}" || ch === "`") {
      // Subshells, grouping, and backtick substitution are out of scope.
      tokens.push({ type: "unknown", text: ch, start: i, end: i + 1 });
      i++;
      continue;
    }

    if (ch === "<") {
      if (s[i + 1] === "<") {
        if (s[i + 2] === "<") {
          // Here-string <<<: out of scope → unknown (covers <<< + next word).
          let j = i + 3;
          while (j < n && isSpace(s[j])) j++;
          while (
            j < n &&
            !isSpace(s[j]) && s[j] !== "\n" && s[j] !== ";" &&
            s[j] !== "&" && s[j] !== "|" && s[j] !== "<" && s[j] !== ">"
          ) {
            j++;
          }
          tokens.push({ type: "unknown", text: s.slice(i, j), start: i, end: j });
          i = j;
          continue;
        }
        const [heredoc, next, skip] = readHeredoc(i);
        tokens.push(heredoc);
        markCommandStarted();
        if (skip) heredocSkip = skip;
        i = next;
        continue;
      }
      const [redir, next] = readRedirect(i, null);
      tokens.push(redir);
      markCommandStarted();
      i = next;
      continue;
    }

    if (ch === ">") {
      const [redir, next] = readRedirect(i, null);
      tokens.push(redir);
      markCommandStarted();
      i = next;
      continue;
    }

    const [word, next] = readWord(i);
    tokens.push(word);
    if (word.type === "redirect") {
      // fd-prefixed redirect (2>file): the simple command has begun.
      markCommandStarted();
    } else if (word.type === "word") {
      const unquoted = word.parts.length === 1 && word.parts[0].quote === null;
      if (kwState === "cmd" && unquoted && RESERVED_WORDS.has(word.value)) {
        const kw = word.value as BashKeyword;
        tokens[tokens.length - 1] = { type: "keyword", value: kw, start: word.start, end: word.end };
        kwState = kw === "for" ? "forvar" : COMMAND_INTRODUCING.has(kw) ? "cmd" : "arg";
      } else if (kwState === "forvar") {
        kwState = "aftervar"; // the for variable is a plain word
      } else if (kwState === "aftervar" && unquoted && word.value === "in") {
        tokens[tokens.length - 1] = { type: "keyword", value: "in", start: word.start, end: word.end };
        kwState = "arg"; // for-list words are data, not commands
      } else {
        kwState = "arg";
      }
    }
    // unknown (dangling escape): no keyword-state change.
    i = next;
  }

  return tokens;
}

/**
 * Split a command into permission-relevant segments using the lexer.
 *
 * Every operator (&&, ||, |&, ;, |, &, newline) separates segments — each
 * pipeline element is a separate command with its own side effects.
 * Comment-only regions produce no segment. A segment containing unknown
 * tokens is opaque (skip pattern matching → always "ask").
 *
 * Control-flow structures (if/elif/then/else/fi, while/until/do/done,
 * for/in/do/done) are walked structurally: the condition AND every branch /
 * loop body become segments (any of them can execute — over-approximation,
 * the safe direction). The `for` header (variable + word list) is data, not
 * a command. Any structural failure (missing terminator, stray keyword,
 * unknown token where a plain word was expected, nesting beyond the cap)
 * makes the WHOLE command one opaque segment — malformed control flow is a
 * bash syntax error (won't run as-is), and broken commands must not ride
 * catch-all rules.
 *
 * Returns [] for empty/whitespace-only input; callers resolve that to the
 * default state.
 */

/** Internal: a control-flow structure could not be walked with confidence. */
class StructureError extends Error {}

const COMPOUND_STARTERS = new Set(["if", "while", "until", "for"]);
const MAX_STRUCTURE_DEPTH = 16;

export function segmentBash(command: string): BashSegment[] {
  const s = normalizeCommand(command);
  const tokens = lexBash(command);
  if (tokens.length === 0) return [];
  try {
    const [segments] = parseList(tokens, s, 0, new Set<string>(), 0);
    return segments;
  } catch (error) {
    if (!(error instanceof StructureError)) throw error;
    return [opaqueWholeCommand(tokens, s)];
  }
}

function peekKeyword(tokens: readonly BashToken[], pos: number, value: string): boolean {
  const t = tokens[pos];
  return t !== undefined && t.type === "keyword" && t.value === value;
}

function expectKeyword(tokens: readonly BashToken[], pos: number, value: string): number {
  if (!peekKeyword(tokens, pos, value)) throw new StructureError();
  return pos + 1;
}

/**
 * Walk a command list: simple commands and nested compound structures,
 * separated by operators. Stops (without consuming) at a stop keyword so the
 * caller can consume it. Comments are skipped and never form segments.
 */
function parseList(
  tokens: readonly BashToken[],
  s: string,
  pos: number,
  stops: ReadonlySet<string>,
  depth: number,
): [BashSegment[], number] {
  const segments: BashSegment[] = [];
  while (pos < tokens.length) {
    const t = tokens[pos];
    if (t.type === "operator" || t.type === "comment") {
      pos++;
      continue;
    }
    if (t.type === "keyword") {
      if (COMPOUND_STARTERS.has(t.value)) {
        const [subs, next] =
          t.value === "if"
            ? parseIf(tokens, s, pos, depth)
            : t.value === "for"
              ? parseFor(tokens, s, pos, depth)
              : parseLoop(tokens, s, pos, depth);
        segments.push(...subs);
        pos = next;
        continue;
      }
      if (stops.has(t.value)) return [segments, pos];
      throw new StructureError();
    }
    const [seg, next] = parseSimpleCommand(tokens, s, pos);
    if (seg) segments.push(seg);
    pos = next;
  }
  return [segments, pos];
}

/**
 * Consume one simple command (words, redirects, heredocs, comments) up to an
 * operator or keyword. Trailing comments are excluded from the text (a
 * trailing comment is not an argument). Unknown tokens make it opaque.
 */
function parseSimpleCommand(
  tokens: readonly BashToken[],
  s: string,
  pos: number,
): [BashSegment | null, number] {
  let start: number | null = null;
  let end = 0;
  const words: string[] = [];
  const redirects: BashRedirect[] = [];
  let opaque = false;
  while (pos < tokens.length) {
    const t = tokens[pos];
    if (t.type === "operator" || t.type === "keyword") break;
    if (t.type === "comment") {
      pos++;
      continue;
    }
    if (start === null) start = t.start;
    end = t.end;
    if (t.type === "word") words.push(t.value);
    else if (t.type === "redirect") {
      redirects.push({ op: t.op, fd: t.fd, target: t.target, isFdDup: t.isFdDup });
    } else if (t.type === "unknown") {
      opaque = true;
    }
    pos++;
  }
  if (start === null) return [null, pos];
  return [{ text: s.slice(start, end), words, redirects, opaque }, pos];
}

/** if COND; then BODY; (elif COND; then BODY;)* (else BODY;)? fi */
function parseIf(
  tokens: readonly BashToken[],
  s: string,
  pos: number,
  depth: number,
): [BashSegment[], number] {
  if (depth >= MAX_STRUCTURE_DEPTH) throw new StructureError();
  const d = depth + 1;
  pos++; // consume `if`
  let [segments, p] = parseList(tokens, s, pos, new Set(["then"]), d);
  p = expectKeyword(tokens, p, "then");
  let [branch, q] = parseList(tokens, s, p, new Set(["elif", "else", "fi"]), d);
  segments.push(...branch);
  p = q;
  for (;;) {
    if (peekKeyword(tokens, p, "elif")) {
      p++;
      let [cond2, r] = parseList(tokens, s, p, new Set(["then"]), d);
      segments.push(...cond2);
      r = expectKeyword(tokens, r, "then");
      let [branch2, r2] = parseList(tokens, s, r, new Set(["elif", "else", "fi"]), d);
      segments.push(...branch2);
      p = r2;
    } else if (peekKeyword(tokens, p, "else")) {
      p++;
      let [branch3, r3] = parseList(tokens, s, p, new Set(["fi"]), d);
      segments.push(...branch3);
      p = r3;
    } else {
      break;
    }
  }
  p = expectKeyword(tokens, p, "fi");
  return [segments, p];
}

/** while COND; do BODY; done / until COND; do BODY; done */
function parseLoop(
  tokens: readonly BashToken[],
  s: string,
  pos: number,
  depth: number,
): [BashSegment[], number] {
  if (depth >= MAX_STRUCTURE_DEPTH) throw new StructureError();
  const d = depth + 1;
  pos++; // consume while/until
  let [segments, p] = parseList(tokens, s, pos, new Set(["do"]), d);
  p = expectKeyword(tokens, p, "do");
  let [body, q] = parseList(tokens, s, p, new Set(["done"]), d);
  segments.push(...body);
  q = expectKeyword(tokens, q, "done");
  return [segments, q];
}

/** for VAR [in WORDS]; do BODY; done — the header words are data, not commands. */
function parseFor(
  tokens: readonly BashToken[],
  s: string,
  pos: number,
  depth: number,
): [BashSegment[], number] {
  if (depth >= MAX_STRUCTURE_DEPTH) throw new StructureError();
  const d = depth + 1;
  pos++; // consume `for`
  const varTok = tokens[pos];
  if (!varTok || varTok.type !== "word") throw new StructureError();
  pos++; // variable name: data
  if (peekKeyword(tokens, pos, "in")) {
    pos++; // consume `in`
    // The word list is data, not commands. Bash DOES expand it, so only plain
    // words (and comments) may appear: a $(...)/backtick there is an unknown
    // token that breaks the `do` expectation below → whole command opaque.
    while (pos < tokens.length && (tokens[pos].type === "word" || tokens[pos].type === "comment")) {
      pos++;
    }
  }
  while (pos < tokens.length && tokens[pos].type === "operator") pos++;
  if (!peekKeyword(tokens, pos, "do")) throw new StructureError();
  pos++; // consume `do`
  const [segments, p] = parseList(tokens, s, pos, new Set(["done"]), d);
  const q = expectKeyword(tokens, p, "done");
  return [segments, q];
}

/** One opaque segment covering the whole command (structural failure). */
function opaqueWholeCommand(tokens: readonly BashToken[], s: string): BashSegment {
  const start = tokens[0].start;
  let end = 0;
  for (let k = tokens.length - 1; k >= 0; k--) {
    if (tokens[k].type !== "comment") {
      end = tokens[k].end;
      break;
    }
  }
  const words: string[] = [];
  const redirects: BashRedirect[] = [];
  for (const t of tokens) {
    if (t.type === "word") words.push(t.value);
    else if (t.type === "redirect") {
      redirects.push({ op: t.op, fd: t.fd, target: t.target, isFdDup: t.isFdDup });
    }
  }
  return { text: s.slice(start, end), words, redirects, opaque: true };
}
