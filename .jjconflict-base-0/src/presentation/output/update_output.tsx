// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import type { OutputMode } from "./output.tsx";
import type { UpdateResult } from "../../domain/update/update_service.ts";

/**
 * Renders the update result in the appropriate output mode.
 */
export function renderUpdateResult(
  result: UpdateResult,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const { lastFrame } = render(<UpdateDisplay result={result} />);
    console.log(lastFrame());
  }
}

export interface UpdateDisplayProps {
  result: UpdateResult;
}

export function UpdateDisplay(
  { result }: UpdateDisplayProps,
): React.ReactElement {
  return (
    <Box flexDirection="column">
      <StatusMessage result={result} />
      {result.warning && (
        <Box marginTop={1}>
          <Text color="yellow">{result.warning}</Text>
        </Box>
      )}
    </Box>
  );
}

function StatusMessage(
  { result }: { result: UpdateResult },
): React.ReactElement {
  switch (result.status) {
    case "up_to_date":
      return (
        <Text color="green">
          swamp is up to date ({result.currentVersion})
        </Text>
      );
    case "update_available":
      return (
        <Box flexDirection="column">
          <Text color="yellow">
            Update available: {result.currentVersion} → {result.latestVersion}
          </Text>
          <Text>
            Run `swamp update` to install
          </Text>
        </Box>
      );
    case "updated":
      return (
        <Box flexDirection="column">
          <Text bold color="green">
            swamp updated successfully!
          </Text>
          <Text>
            {result.previousVersion} → {result.newVersion}
          </Text>
        </Box>
      );
  }
}
