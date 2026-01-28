// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, render, Text } from "ink";
import type { OutputMode } from "./output.tsx";

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
 */
export function renderError(error: unknown, mode: OutputMode): void {
  const err = error instanceof Error ? error : new Error(String(error));
  const stackLines = extractStackLines(err.stack);

  if (mode === "json") {
    const data: ErrorData = {
      error: err.message,
    };
    if (stackLines) {
      data.stack = stackLines;
    }
    console.error(JSON.stringify(data, null, 2));
  } else {
    renderInteractiveError(err.message, stackLines);
  }
}

function renderInteractiveError(message: string, stack?: string): void {
  const { unmount } = render(<ErrorDisplay message={message} stack={stack} />);
  unmount();
}

interface ErrorDisplayProps {
  message: string;
  stack?: string;
}

export function ErrorDisplay(props: ErrorDisplayProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color="red">Error: {props.message}</Text>
      {props.stack && (
        <Box marginTop={1}>
          <Text dimColor>{props.stack}</Text>
        </Box>
      )}
    </Box>
  );
}
