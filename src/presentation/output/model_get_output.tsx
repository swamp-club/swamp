// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, render, Text } from "ink";
import type { OutputMode } from "./output.tsx";

/**
 * Data structure for resource information.
 */
export interface ResourceData {
  id: string;
  createdAt: string;
  attributes: Record<string, unknown>;
}

/**
 * Data structure for the model get output.
 */
export interface ModelGetData {
  id: string;
  name: string;
  type: string;
  version: number;
  tags: Record<string, string>;
  attributes: Record<string, unknown>;
  resource?: ResourceData;
}

/**
 * Renders the model get output in either interactive or JSON mode.
 */
export function renderModelGet(data: ModelGetData, mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderInteractiveModelGet(data);
  }
}

function renderInteractiveModelGet(data: ModelGetData): void {
  const instance = render(<ModelGetDisplay data={data} />);
  instance.unmount();
}

interface ModelGetDisplayProps {
  data: ModelGetData;
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
 * Interactive display component for model get.
 */
export function ModelGetDisplay(
  props: ModelGetDisplayProps,
): React.ReactElement {
  const { data } = props;
  const hasTags = Object.keys(data.tags).length > 0;
  const hasAttributes = Object.keys(data.attributes).length > 0;

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Text color="green" bold>
        # {data.name}
      </Text>

      {/* Basic Info */}
      <Section title="Model Info">
        <KeyValue label="ID" value={data.id} />
        <KeyValue label="Type" value={data.type} />
        <KeyValue label="Version" value={String(data.version)} />
      </Section>

      {/* Tags */}
      {hasTags && (
        <Section title="Tags">
          {Object.entries(data.tags).map(([key, value]) => (
            <KeyValue key={key} label={key} value={value} />
          ))}
        </Section>
      )}

      {/* Input Attributes */}
      <Section title="Input Attributes">
        {hasAttributes
          ? <Text dimColor>{formatJson(data.attributes)}</Text>
          : <Text dimColor>(none)</Text>}
      </Section>

      {/* Resource */}
      {data.resource
        ? (
          <Section title="Resource">
            <KeyValue label="ID" value={data.resource.id} />
            <KeyValue label="Created At" value={data.resource.createdAt} />
            <Box marginTop={1} flexDirection="column">
              <Text color="cyan">Attributes:</Text>
              <Text dimColor>{formatJson(data.resource.attributes)}</Text>
            </Box>
          </Section>
        )
        : (
          <Section title="Resource">
            <Text dimColor>(no resource created yet)</Text>
          </Section>
        )}
    </Box>
  );
}
