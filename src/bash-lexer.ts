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
 * See bash-permission-tokenizer-plan.md for the full design.
 */

export type WordPart = {
  text: string;
  quote: "single" | "double" | null;
};

export type BashToken =
  | { type: "word"; value: string; parts: WordPart[]; start: number; end: number }
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

export function lexBash(command: string): BashToken[] {
  const s = normalizeCommand(command);
  const n = s.length;
  const tokens: BashToken[] = [];
  let i = 0;
  // After a heredoc's command line ends at skip.atNewline, the body region
  // (up to skip.to) is data, not commands — resume lexing past it.
  let heredocSkip: { atNewline: number; to: number } | null = null;

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
        i += 2;
        continue;
      }
      if (s[i + 1] === ">") {
        const [redir, next] = readRedirect(i, null);
        tokens.push(redir);
        i = next;
        continue;
      }
      tokens.push({ type: "operator", value: "&", start: i, end: i + 1 });
      i++;
      continue;
    }

    if (ch === "|") {
      if (s[i + 1] === "|") {
        tokens.push({ type: "operator", value: "||", start: i, end: i + 2 });
        i += 2;
        continue;
      }
      if (s[i + 1] === "&") {
        tokens.push({ type: "operator", value: "|&", start: i, end: i + 2 });
        i += 2;
        continue;
      }
      tokens.push({ type: "operator", value: "|", start: i, end: i + 1 });
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
        if (skip) heredocSkip = skip;
        i = next;
        continue;
      }
      const [redir, next] = readRedirect(i, null);
      tokens.push(redir);
      i = next;
      continue;
    }

    if (ch === ">") {
      const [redir, next] = readRedirect(i, null);
      tokens.push(redir);
      i = next;
      continue;
    }

    const [word, next] = readWord(i);
    tokens.push(word);
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
 * Returns [] for empty/whitespace-only input; callers resolve that to the
 * default state.
 */
export function segmentBash(command: string): BashSegment[] {
  const s = normalizeCommand(command);
  const tokens = lexBash(command);
  const segments: BashSegment[] = [];
  let current: BashToken[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    const segmentTokens = current;
    current = [];
    // Comment-only segment: no executable content, no decision impact.
    if (!segmentTokens.some((t) => t.type !== "comment")) return;

    const start = segmentTokens[0].start;
    // Segment text ends at the last non-comment token: a trailing comment
    // is not an argument (`git status # note` runs `git status`), so exact
    // patterns must still match.
    let end = 0;
    for (let k = segmentTokens.length - 1; k >= 0; k--) {
      if (segmentTokens[k].type !== "comment") {
        end = segmentTokens[k].end;
        break;
      }
    }
    const words: string[] = [];
    const redirects: BashRedirect[] = [];
    let opaque = false;
    for (const t of segmentTokens) {
      if (t.type === "word") words.push(t.value);
      else if (t.type === "redirect") {
        redirects.push({ op: t.op, fd: t.fd, target: t.target, isFdDup: t.isFdDup });
      } else if (t.type === "unknown") {
        opaque = true;
      }
    }
    segments.push({ text: s.slice(start, end), words, redirects, opaque });
  };

  for (const t of tokens) {
    if (t.type === "operator") {
      flush();
      continue;
    }
    current.push(t);
  }
  flush();

  return segments;
}
