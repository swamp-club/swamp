import type { OutputMode } from "./output.ts";
import { UserError } from "../../domain/errors.ts";

export interface ErrorData {
  error: string;
  stack?: string;
}

/**
 * Extracts just the stack trace lines from an error stack.
 * Removes the error message line and any source code snippets.
 */
function extractStackLines(stack: string | undefined): string | undefined {
  if (!stack) return undefined;

  const lines = stack.split("\n");
  // Find lines that start with "at " (stack frames)
  const stackLines = lines.filter((line) => line.trim().startsWith("at "));
  return stackLines.length > 0 ? stackLines.join("\n") : undefined;
}

/**
 * Renders an error to the console based on output mode.
 * UserError instances do not show stack traces as they are expected user-facing errors.
 */
export function renderError(error: unknown, mode: OutputMode): void {
  const err = error instanceof Error ? error : new Error(String(error));
  const isUserError = err instanceof UserError;
  const stackLines = isUserError ? undefined : extractStackLines(err.stack);

  if (mode === "json") {
    const data: ErrorData = {
      error: err.message,
    };
    if (stackLines) {
      data.stack = stackLines;
    }
    console.error(JSON.stringify(data, null, 2));
  } else {
    console.error(`Error: ${err.message}`);
    if (stackLines) {
      console.error(stackLines);
    }
  }
}
