/**
 * Splits a compiler-options string without invoking a shell.
 *
 * Quotes and backslashes only group or escape characters. Shell expansion,
 * command substitution, globbing, variables, and comments are intentionally
 * not implemented.
 */
export function tokenizeCompilerArguments(input: string): string[] {
  const result: string[] = [];
  let argument = "";
  let argumentStarted = false;
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const finishArgument = () => {
    if (!argumentStarted) return;
    result.push(argument);
    argument = "";
    argumentStarted = false;
  };

  for (const character of input) {
    if (escaped) {
      argument += character;
      argumentStarted = true;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      argumentStarted = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else argument += character;
      argumentStarted = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      argumentStarted = true;
      continue;
    }
    if (/\s/u.test(character)) {
      finishArgument();
      continue;
    }
    argument += character;
    argumentStarted = true;
  }

  if (escaped) throw new Error("Compiler arguments end with an escape");
  if (quote) throw new Error("Compiler arguments contain an unterminated quote");
  finishArgument();
  return result;
}

export function normalizeCompilerArguments(
  input: string | readonly string[] | undefined,
): string[] {
  if (input === undefined) return [];
  if (typeof input === "string") return tokenizeCompilerArguments(input);
  if (!input.every((argument) => typeof argument === "string")) {
    throw new TypeError("Compiler arguments must be strings");
  }
  return [...input];
}
