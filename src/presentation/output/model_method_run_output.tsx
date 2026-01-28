// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, render, Text } from "ink";
import type { OutputMode } from "./output.tsx";

export interface ModelMethodRunData {
  modelId: string;
  modelName: string;
  type: string;
  methodName: string;
  resourceId: string;
  resourcePath: string;
  resourceAttributes: Record<string, unknown>;
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
  const { unmount } = render(<ModelMethodRunDisplay {...data} />);
  unmount();
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

export function ModelMethodRunDisplay(
  props: ModelMethodRunData,
): React.ReactElement {
  const checkmark = "\u2713";
  const attributeEntries = Object.entries(props.resourceAttributes);

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
      <Text>
        <Text></Text>Resource ID: <Text dimColor>{props.resourceId}</Text>
      </Text>
      <Text>
        <Text></Text>Resource Path: <Text dimColor>{props.resourcePath}</Text>
      </Text>
      <Text />
      <Text>Resource Attributes:</Text>
      {attributeEntries.map(([name, value]) => (
        <AttributeItem key={name} name={name} value={value} />
      ))}
    </Box>
  );
}
