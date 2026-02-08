// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, render, Text } from "ink";
import type { OutputMode } from "./output.tsx";

/**
 * Data structure for the vault list-keys output.
 */
export interface VaultListKeysData {
  vaultName: string;
  vaultType: string;
  secretKeys: string[];
  count: number;
}

/**
 * Renders the vault list-keys output in either interactive or JSON mode.
 */
export function renderVaultListKeys(
  data: VaultListKeysData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderInteractiveVaultListKeys(data);
  }
}

function renderInteractiveVaultListKeys(data: VaultListKeysData): void {
  const instance = render(<VaultListKeysDisplay data={data} />);
  instance.unmount();
}

interface VaultListKeysDisplayProps {
  data: VaultListKeysData;
}

/**
 * Interactive display component for vault list-keys.
 */
export function VaultListKeysDisplay(
  props: VaultListKeysDisplayProps,
): React.ReactElement {
  const { data } = props;

  return (
    <Box flexDirection="column">
      <Text color="green" bold>
        Secret keys in vault '{data.vaultName}'
      </Text>
      <Box marginTop={1} marginLeft={2} flexDirection="column">
        <Text>
          <Text color="cyan">{`Type: `}</Text>
          <Text>{data.vaultType}</Text>
        </Text>
        <Text>
          <Text color="cyan">{`Count: `}</Text>
          <Text>{data.count}</Text>
        </Text>
      </Box>
      {data.secretKeys.length > 0
        ? (
          <Box marginTop={1} flexDirection="column">
            <Text color="cyan" bold>
              Keys:
            </Text>
            <Box marginLeft={2} flexDirection="column">
              {data.secretKeys.map((key) => <Text key={key}>- {key}</Text>)}
            </Box>
          </Box>
        )
        : (
          <Box marginTop={1}>
            <Text dimColor>(no secret keys stored)</Text>
          </Box>
        )}
    </Box>
  );
}
