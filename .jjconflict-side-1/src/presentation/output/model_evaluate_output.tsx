// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import type { OutputMode } from "./output.tsx";

export interface ModelEvaluateItemData {
  id: string;
  name: string;
  type: string;
  hadExpressions: boolean;
  outputPath?: string;
}

export interface ModelEvaluateData {
  items: ModelEvaluateItemData[];
  total: number;
  evaluated: number;
}

export function renderModelEvaluate(
  data: ModelEvaluateData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderInteractiveModelEvaluate(data);
  }
}

function renderInteractiveModelEvaluate(data: ModelEvaluateData): void {
  const { lastFrame } = render(<ModelEvaluateDisplay {...data} />);
  console.log(lastFrame());
}

interface ModelEvaluateDisplayProps {
  items: ModelEvaluateItemData[];
  total: number;
  evaluated: number;
}

export function ModelEvaluateDisplay(
  props: ModelEvaluateDisplayProps,
): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color="green">
        Evaluated {props.evaluated} of {props.total} model inputs:
      </Text>
      <Box marginLeft={2} flexDirection="column" marginTop={1}>
        {props.items.map((item) => (
          <Box key={item.id} flexDirection="column" marginBottom={1}>
            <Text>
              <Text color="cyan">{item.name}</Text>
              <Text dimColor>({item.type})</Text>
              {item.hadExpressions
                ? <Text color="green">[evaluated]</Text>
                : <Text dimColor>[no expressions]</Text>}
            </Text>
            {item.outputPath && (
              <Box marginLeft={2}>
                <Text dimColor>Output: {item.outputPath}</Text>
              </Box>
            )}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

export function renderModelEvaluateSingle(
  item: ModelEvaluateItemData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(item, null, 2));
  } else {
    const { lastFrame } = render(<ModelEvaluateSingleDisplay {...item} />);
    console.log(lastFrame());
  }
}

export function ModelEvaluateSingleDisplay(
  props: ModelEvaluateItemData,
): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color="green">Evaluated model input:</Text>
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
          <Text color="cyan">ID:</Text>
          <Text dimColor>{props.id}</Text>
        </Text>
        {props.hadExpressions
          ? <Text color="green">Expressions evaluated</Text>
          : <Text dimColor>No expressions to evaluate</Text>}
        {props.outputPath && (
          <Text>
            <Text color="cyan">Output:</Text>
            <Text dimColor>{props.outputPath}</Text>
          </Text>
        )}
      </Box>
    </Box>
  );
}
