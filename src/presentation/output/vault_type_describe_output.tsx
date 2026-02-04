// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, render, Text } from "ink";
import type { OutputMode } from "./output.tsx";
import type { VaultTypeSearchItem } from "./vault_type_search_output.tsx";

/**
 * Configuration example for each vault type.
 * Shows the YAML structure stored in .swamp/vault/{type}/{id}.yaml
 */
const CONFIG_EXAMPLES: Record<string, string> = {
  aws: `# .swamp/vault/aws/{id}.yaml
id: "uuid-here"
name: "my-aws-vault"
type: "aws"
config:
  region: "us-east-1"      # Required: AWS region
  # profile: "production"  # Optional: AWS profile name
createdAt: "2024-01-01T00:00:00.000Z"`,
  local_encryption: `# .swamp/vault/local_encryption/{id}.yaml
id: "uuid-here"
name: "my-local-vault"
type: "local_encryption"
config:
  # ssh_key_path: "~/.ssh/id_rsa"  # Use SSH key for encryption
  auto_generate: true              # Or auto-generate encryption key
createdAt: "2024-01-01T00:00:00.000Z"`,
};

/**
 * Renders vault type description in either interactive or JSON mode.
 */
export function renderVaultTypeDescribe(
  data: VaultTypeSearchItem,
  mode: OutputMode,
): void {
  if (mode === "json") {
    renderJsonVaultTypeDescribe(data);
  } else {
    renderInteractiveVaultTypeDescribe(data);
  }
}

/**
 * Renders vault type description as JSON.
 */
function renderJsonVaultTypeDescribe(data: VaultTypeSearchItem): void {
  const output = {
    ...data,
    configExample: CONFIG_EXAMPLES[data.type] ?? "",
    storagePath: `.swamp/vault/${data.type}/{id}.yaml`,
  };
  console.log(JSON.stringify(output, null, 2));
}

/**
 * Renders an interactive vault type description.
 */
function renderInteractiveVaultTypeDescribe(data: VaultTypeSearchItem): void {
  const { waitUntilExit } = render(<VaultTypeDescribeUI data={data} />);
  waitUntilExit();
}

interface VaultTypeDescribeUIProps {
  data: VaultTypeSearchItem;
}

/**
 * Interactive vault type description component.
 */
function VaultTypeDescribeUI(
  props: VaultTypeDescribeUIProps,
): React.ReactElement {
  const { data } = props;
  const configExample = CONFIG_EXAMPLES[data.type] ?? "";

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text color="cyan" bold>
          Vault Type: {data.type}
        </Text>
      </Box>

      {/* Name */}
      <Box>
        <Text bold>Name:</Text>
        <Text>{data.name}</Text>
      </Box>

      {/* Storage path */}
      <Box>
        <Text bold>Storage:</Text>
        <Text dimColor>.swamp/vault/{data.type}/</Text>
        <Text dimColor>{"<id>"}.yaml</Text>
      </Box>

      {/* Description */}
      <Box marginTop={1}>
        <Text bold>Description:</Text>
      </Box>
      <Box marginLeft={2}>
        <Text>{data.description}</Text>
      </Box>

      {/* Configuration Example */}
      {configExample && (
        <>
          <Box marginTop={1}>
            <Text bold>Configuration Example:</Text>
          </Box>
          <Box marginLeft={2} marginTop={1} flexDirection="column">
            {configExample.split("\n").map((line, i) => (
              <Text key={i} color="gray">
                {line}
              </Text>
            ))}
          </Box>
        </>
      )}

      {/* Usage hint */}
      <Box marginTop={1}>
        <Text dimColor>
          Create with: swamp vault create {data.type} {"<name>"}
        </Text>
      </Box>
    </Box>
  );
}
