// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, render, Text } from "ink";
import type { OutputMode } from "./output.tsx";

/**
 * Data structure for the vault put output.
 */
export interface VaultPutData {
  vaultName: string;
  secretKey: string;
  vaultType: string;
  overwritten: boolean;
  timestamp: string;
}

/**
 * Renders the vault put output in either interactive or JSON mode.
 */
export function renderVaultPut(data: VaultPutData, mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderInteractiveVaultPut(data);
  }
}

/**
 * Renders a cancellation message when user declines to overwrite.
 */
export function renderVaultPutCancelled(mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify({ cancelled: true }, null, 2));
  } else {
    const instance = render(<VaultPutCancelledDisplay />);
    instance.unmount();
  }
}

function renderInteractiveVaultPut(data: VaultPutData): void {
  const instance = render(<VaultPutDisplay data={data} />);
  instance.unmount();
}

interface VaultPutDisplayProps {
  data: VaultPutData;
}

/**
 * Interactive display component for vault put success.
 */
export function VaultPutDisplay(
  props: VaultPutDisplayProps,
): React.ReactElement {
  const { data } = props;
  const action = data.overwritten ? "Updated" : "Stored";

  return (
    <Box flexDirection="column">
      <Text color="green">
        {action} secret '{data.secretKey}' in vault '{data.vaultName}'
      </Text>
      <Box marginTop={1} marginLeft={2} flexDirection="column">
        <Text>
          <Text color="cyan">{`Vault: `}</Text>
          <Text>{data.vaultName}</Text>
        </Text>
        <Text>
          <Text color="cyan">{`Type: `}</Text>
          <Text>{data.vaultType}</Text>
        </Text>
        <Text>
          <Text color="cyan">{`Key: `}</Text>
          <Text>{data.secretKey}</Text>
        </Text>
      </Box>
    </Box>
  );
}

/**
 * Interactive display component for cancelled vault put.
 */
export function VaultPutCancelledDisplay(): React.ReactElement {
  return (
    <Box>
      <Text color="yellow">Operation cancelled.</Text>
    </Box>
  );
}
