import { type ParseError as JsoncParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser";

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function formatJsoncParseSummary(input: string, errors: readonly JsoncParseError[]): string {
  const firstError = errors[0];
  if (!firstError) {
    return "unknown parse error";
  }

  const beforeOffset = input.slice(0, firstError.offset).split("\n");
  const line = beforeOffset.length;
  const column = (beforeOffset.at(-1)?.length ?? 0) + 1;
  const summary = `${printParseErrorCode(firstError.error)} at line ${line}, column ${column}`;
  const additionalErrorCount = errors.length - 1;

  if (additionalErrorCount <= 0) {
    return summary;
  }

  return `${summary}; ${additionalErrorCount} more parse error${additionalErrorCount === 1 ? "" : "s"}`;
}

export function parseJsoncConfig(input: string, filePath: string, subject = "config"): unknown {
  const errors: JsoncParseError[] = [];
  const parsed = parseJsonc(input, errors, { allowTrailingComma: true });

  if (errors.length > 0) {
    throw new Error(`Failed to parse ${subject} at '${filePath}' (${formatJsoncParseSummary(input, errors)})`);
  }

  return parsed as unknown;
}

export function formatJsoncConfigLoadWarning(
  filePath: string,
  error: unknown,
  subject = "config",
  fallbackMessage?: string,
): string | null {
  if (isNodeErrorWithCode(error, "ENOENT")) {
    return null;
  }

  const baseMessage = error instanceof Error
    ? error.message
    : `Failed to load ${subject} at '${filePath}': ${String(error)}`;

  return fallbackMessage ? `${baseMessage}; ${fallbackMessage}.` : baseMessage;
}
