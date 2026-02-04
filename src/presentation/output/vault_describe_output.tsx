// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, render, Text } from "ink";
import type { OutputMode } from "./output.tsx";
import type { VaultConfig } from "../../domain/vaults/vault_config.ts";

/**
 * Renders vault description in either interactive or JSON mode.
 */
export function renderVaultDescribe(
  config: VaultConfig,
  mode: OutputMode,
): void {
  if (mode === "json") {
    renderJsonVaultDescribe(config);
  } else {
    renderInteractiveVaultDescribe(config);
  }
}

/**
 * Renders vault description as JSON.
 */
function renderJsonVaultDescribe(config: VaultConfig): void {
  console.log(JSON.stringify(config.toData(), null, 2));
}

/**
 * Renders an interactive vault description.
 */
function renderInteractiveVaultDescribe(config: VaultConfig): void {
  const { waitUntilExit } = render(<VaultDescribeUI config={config} />);
  waitUntilExit();
}

interface VaultDescribeUIProps {
  config: VaultConfig;
}

/**
 * Interactive vault description component.
 */
function VaultDescribeUI(props: VaultDescribeUIProps): React.ReactElement {
  const { config } = props;

  // Format config entries for display (masking sensitive values)
  const configEntries = Object.entries(config.config).map(([key, value]) => {
    const displayValue = typeof value === "string"
      ? value
      : JSON.stringify(value);
    return { key, value: displayValue };
  });

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text color="cyan" bold>
          Vault: {config.name}
        </Text>
      </Box>

      {/* Basic info */}
      <Box>
        <Text bold>ID:</Text>
        <Text dimColor>{config.id}</Text>
      </Box>

      <Box>
        <Text bold>Type:</Text>
        <Text>{config.type}</Text>
      </Box>

      <Box>
        <Text bold>Created:</Text>
        <Text dimColor>{config.createdAt.toISOString()}</Text>
      </Box>

      {/* Storage path */}
      <Box marginTop={1}>
        <Text bold>Storage:</Text>
        <Text dimColor>.swamp/vault/{config.type}/{config.id}.yaml</Text>
      </Box>

      {/* Configuration */}
      {configEntries.length > 0 && (
        <>
          <Box marginTop={1}>
            <Text bold>Configuration:</Text>
          </Box>
          <Box marginLeft={2} flexDirection="column">
            {configEntries.map((entry) => (
              <Box key={entry.key}>
                <Text color="gray">{entry.key}:</Text>
                <Text>{entry.value}</Text>
              </Box>
            ))}
          </Box>
        </>
      )}

      {/* Usage hint */}
      <Box marginTop={1}>
        <Text dimColor>
          Use in expressions: {"${{ vault.get(" + config.name + ", <key>) }}"}
        </Text>
      </Box>
    </Box>
  );
}
