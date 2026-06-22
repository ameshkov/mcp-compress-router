import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';

/**
 * Parses JSON or JSONC (comments + trailing commas) text.
 *
 * The parser is fault-tolerant: trailing commas, extra whitespace, and
 * other minor issues produce warnings but still yield a result. Only
 * unrecoverable syntax errors throw.
 *
 * @param text - The text to parse.
 * @param context - Human-readable description of where the text comes
 *   from (e.g. a file path), used in error messages.
 * @returns The parsed value.
 * @throws Error when the text contains unrecoverable syntax errors.
 */
export function parseJsonc(text: string, context: string): unknown {
  const errors: ParseError[] = [];
  const result = parse(text, errors);

  // parse() uses error recovery — only the first error that prevents
  // any valid result makes result undefined.
  if (result === undefined && errors.length > 0) {
    throw new Error(`Failed to parse ${context}: ${printParseErrorCode(errors[0].error)}`);
  }
  return result;
}
