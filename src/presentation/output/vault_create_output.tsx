// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import type { OutputMode } from "./output.tsx";

/**
 * Data for vault create output.
 */
export interface VaultCreateData {
  id: string;
  name: string;
  type: string;
  typeName: string;
  config: Record<string, unknown>;
}

/**
 * Renders vault create output in either interactive or JSON mode.
 */
export function renderVaultCreate(
  data: VaultCreateData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderInteractiveVaultCreate(data);
  }
}

function renderInteractiveVaultCreate(data: VaultCreateData): void {
  const { lastFrame } = render(<VaultCreateDisplay {...data} />);
  console.log(lastFrame());
}

interface VaultCreateDisplayProps {
  id: string;
  name: string;
  type: string;
  typeName: string;
  config: Record<string, unknown>;
}

/**
 * Interactive display component for vault create.
 */
export function VaultCreateDisplay(
  props: VaultCreateDisplayProps,
): React.ReactElement {
  const configEntries = Object.entries(props.config);

  return (
    <Box flexDirection="column">
      <Text color="green">Created vault configuration:</Text>
      <Box marginLeft={2} flexDirection="column">
        <Box>
          <Text color="cyan">Name:</Text>
          <Text>{props.name}</Text>
        </Box>
        <Box>
          <Text color="cyan">ID:</Text>
          <Text dimColor>{props.id}</Text>
        </Box>
        <Box>
          <Text color="cyan">Type:</Text>
          <Text>{props.type}</Text>
          <Text dimColor>({props.typeName})</Text>
        </Box>
        {configEntries.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="cyan">Config:</Text>
            {configEntries.map(([key, value]) => (
              <Box key={key} marginLeft={2}>
                <Text dimColor>{key}:</Text>
                <Text>{String(value)}</Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          Edit .swamp/vault/{props.type}/{props.id}.yaml to customize the vault
          configuration.
        </Text>
      </Box>
    </Box>
  );
}
