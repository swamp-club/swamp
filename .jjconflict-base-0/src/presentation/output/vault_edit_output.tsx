// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import type { OutputMode } from "./output.tsx";

/**
 * Data structure for vault edit output.
 */
export interface VaultEditData {
  path: string;
  editor: string;
  status: "opened";
  name: string;
  type: string;
}

/**
 * Renders vault edit output in either interactive or JSON mode.
 */
export function renderVaultEdit(data: VaultEditData, mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderInteractiveVaultEdit(data);
  }
}

function renderInteractiveVaultEdit(data: VaultEditData): void {
  const { lastFrame } = render(<VaultEditDisplay {...data} />);
  console.log(lastFrame());
}

interface VaultEditDisplayProps {
  path: string;
  editor: string;
  name: string;
  type: string;
}

/**
 * Interactive display component for vault edit output.
 */
export function VaultEditDisplay(
  props: VaultEditDisplayProps,
): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color="green">Opening vault configuration in {props.editor}:</Text>
      <Box marginLeft={2} flexDirection="column">
        <Text>
          <Text color="cyan">Name:</Text>
          <Text>{props.name}</Text>
        </Text>
        <Text>
          <Text color="cyan">Type:</Text>
          <Text>{props.type}</Text>
        </Text>
        <Text>
          <Text color="cyan">Path:</Text>
          <Text dimColor>{props.path}</Text>
        </Text>
      </Box>
    </Box>
  );
}
