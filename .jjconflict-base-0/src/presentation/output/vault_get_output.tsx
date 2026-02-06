// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, render, Text } from "ink";
import type { OutputMode } from "./output.tsx";

/**
 * Data structure for the vault get output.
 */
export interface VaultGetData {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  createdAt: string;
  storagePath: string;
}

/**
 * Renders the vault get output in either interactive or JSON mode.
 */
export function renderVaultGet(data: VaultGetData, mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderInteractiveVaultGet(data);
  }
}

function renderInteractiveVaultGet(data: VaultGetData): void {
  const instance = render(<VaultGetDisplay data={data} />);
  instance.unmount();
}

interface VaultGetDisplayProps {
  data: VaultGetData;
}

/**
 * Formats a JSON object as a string with indentation.
 */
function formatJson(obj: object): string {
  return JSON.stringify(obj, null, 2);
}

/**
 * Component to display a section with a header.
 */
function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="cyan" bold>
        ## {title}
      </Text>
      <Box marginTop={1} marginLeft={2} flexDirection="column">
        {children}
      </Box>
    </Box>
  );
}

/**
 * Component to display a key-value pair.
 */
function KeyValue({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.ReactElement {
  return (
    <Text>
      <Text color="cyan">{`${label}: `}</Text>
      <Text>{value}</Text>
    </Text>
  );
}

/**
 * Interactive display component for vault get.
 */
export function VaultGetDisplay(
  props: VaultGetDisplayProps,
): React.ReactElement {
  const { data } = props;
  const hasConfig = Object.keys(data.config).length > 0;

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Text color="green" bold>
        # {data.name}
      </Text>

      {/* Basic Info */}
      <Section title="Vault Info">
        <KeyValue label="ID" value={data.id} />
        <KeyValue label="Type" value={data.type} />
        <KeyValue label="Created At" value={data.createdAt} />
        <KeyValue label="Storage" value={data.storagePath} />
      </Section>

      {/* Configuration */}
      <Section title="Configuration">
        {hasConfig
          ? <Text dimColor>{formatJson(data.config)}</Text>
          : <Text dimColor>(no configuration)</Text>}
      </Section>

      {/* Usage hint */}
      <Box marginTop={1}>
        <Text dimColor>
          Use in expressions: {"${{ vault.get(" + data.name + ", <key>) }}"}
        </Text>
      </Box>
    </Box>
  );
}
