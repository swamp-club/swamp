// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import type { OutputMode } from "./output.tsx";

/**
 * Artifact information for method output.
 */
export interface ArtifactInfo {
  id: string;
  path: string;
  attributes?: Record<string, unknown>;
}

export interface ModelMethodRunData {
  modelId: string;
  modelName: string;
  type: string;
  methodName: string;
  // Artifact outputs (all optional, depends on what the method produces)
  resource?: ArtifactInfo;
  data?: ArtifactInfo;
  file?: ArtifactInfo;
  logs?: ArtifactInfo[];
}

export function renderModelMethodRun(
  data: ModelMethodRunData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderInteractiveModelMethodRun(data);
  }
}

function renderInteractiveModelMethodRun(data: ModelMethodRunData): void {
  const { lastFrame } = render(<ModelMethodRunDisplay {...data} />);
  console.log(lastFrame());
}

interface AttributeItemProps {
  name: string;
  value: unknown;
}

function AttributeItem(props: AttributeItemProps): React.ReactElement {
  const displayValue = typeof props.value === "string"
    ? props.value
    : JSON.stringify(props.value);

  return (
    <Text>
      <Text></Text>
      <Text dimColor>{props.name}:</Text> {displayValue}
    </Text>
  );
}

interface ArtifactSectionProps {
  label: string;
  artifact: ArtifactInfo;
}

function ArtifactSection(props: ArtifactSectionProps): React.ReactElement {
  const attributeEntries = props.artifact.attributes
    ? Object.entries(props.artifact.attributes)
    : [];

  return (
    <Box flexDirection="column">
      <Text>
        <Text></Text>
        {props.label} ID: <Text dimColor>{props.artifact.id}</Text>
      </Text>
      <Text>
        <Text></Text>
        {props.label} Path: <Text dimColor>{props.artifact.path}</Text>
      </Text>
      {attributeEntries.length > 0 && (
        <Box flexDirection="column">
          <Text>{props.label} Attributes:</Text>
          {attributeEntries.map(([name, value]) => (
            <AttributeItem key={name} name={name} value={value} />
          ))}
        </Box>
      )}
    </Box>
  );
}

export function ModelMethodRunDisplay(
  props: ModelMethodRunData,
): React.ReactElement {
  const checkmark = "\u2713";

  return (
    <Box flexDirection="column">
      <Text>
        <Text color="green">{checkmark}</Text> Method '
        <Text bold>{props.methodName}</Text>' executed successfully
      </Text>
      <Text />
      <Text>
        <Text></Text>Model: <Text bold>{props.modelName}</Text> (
        <Text dimColor>{props.type}</Text>)
      </Text>
      {props.resource && (
        <Box flexDirection="column" marginTop={1}>
          <ArtifactSection label="Resource" artifact={props.resource} />
        </Box>
      )}
      {props.data && (
        <Box flexDirection="column" marginTop={1}>
          <ArtifactSection label="Data" artifact={props.data} />
        </Box>
      )}
      {props.file && (
        <Box flexDirection="column" marginTop={1}>
          <ArtifactSection label="File" artifact={props.file} />
        </Box>
      )}
      {props.logs && props.logs.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text>Logs:</Text>
          {props.logs.map((log, index) => (
            <Text key={log.id}>
              <Text></Text>Log {index + 1}: <Text dimColor>{log.path}</Text>
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
