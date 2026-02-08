// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import type { OutputMode } from "./output.tsx";

/**
 * Data structure for the model delete output.
 */
export interface ModelDeleteData {
  id: string;
  name: string;
  type: string;
  inputPath: string;
  resourcePath?: string;
  resourceDeleted: boolean;
  outputsDeleted: number;
  evaluatedInputDeleted: boolean;
  dataDeleted: boolean;
}

/**
 * JSON output structure for model delete.
 */
export interface ModelDeleteJsonOutput {
  deleted: {
    id: string;
    name: string;
    type: string;
    inputPath: string;
    resourcePath?: string;
  };
  resourceDeleted: boolean;
  outputsDeleted: number;
  evaluatedInputDeleted: boolean;
  dataDeleted: boolean;
}

/**
 * Renders the model delete output in either interactive or JSON mode.
 */
export function renderModelDelete(
  data: ModelDeleteData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    const output: ModelDeleteJsonOutput = {
      deleted: {
        id: data.id,
        name: data.name,
        type: data.type,
        inputPath: data.inputPath,
      },
      resourceDeleted: data.resourceDeleted,
      outputsDeleted: data.outputsDeleted,
      evaluatedInputDeleted: data.evaluatedInputDeleted,
      dataDeleted: data.dataDeleted,
    };
    if (data.resourcePath) {
      output.deleted.resourcePath = data.resourcePath;
    }
    console.log(JSON.stringify(output, null, 2));
  } else {
    renderInteractiveModelDelete(data);
  }
}

function renderInteractiveModelDelete(data: ModelDeleteData): void {
  const { lastFrame } = render(<ModelDeleteDisplay {...data} />);
  console.log(lastFrame());
}

interface ModelDeleteDisplayProps {
  id: string;
  name: string;
  type: string;
  inputPath: string;
  resourcePath?: string;
  resourceDeleted: boolean;
  outputsDeleted: number;
  evaluatedInputDeleted: boolean;
  dataDeleted: boolean;
}

/**
 * Interactive display component for model delete.
 */
export function ModelDeleteDisplay(
  props: ModelDeleteDisplayProps,
): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color="green">Deleted model:</Text>
      <Box marginLeft={2} flexDirection="column">
        <Text>
          <Text color="cyan">Type:</Text>
          <Text>{props.type}</Text>
        </Text>
        <Text>
          <Text color="cyan">Name:</Text>
          <Text>{props.name}</Text>
        </Text>
        <Text>
          <Text color="cyan">ID:</Text>
          <Text dimColor>{props.id}</Text>
        </Text>
        <Text>
          <Text color="cyan">Path:</Text>
          <Text dimColor>{props.inputPath}</Text>
        </Text>
        {props.resourceDeleted && props.resourcePath && (
          <Text>
            <Text color="cyan">Resource deleted:</Text>
            <Text dimColor>{props.resourcePath}</Text>
          </Text>
        )}
        {props.outputsDeleted > 0 && (
          <Text>
            <Text color="cyan">Outputs deleted:</Text>
            <Text>{props.outputsDeleted}</Text>
          </Text>
        )}
        {props.evaluatedInputDeleted && (
          <Text>
            <Text color="cyan">Evaluated input deleted:</Text>
            <Text>yes</Text>
          </Text>
        )}
        {props.dataDeleted && (
          <Text>
            <Text color="cyan">Data artifact deleted:</Text>
            <Text>yes</Text>
          </Text>
        )}
      </Box>
    </Box>
  );
}

/**
 * Renders a cancellation message.
 */
export function renderModelDeleteCancelled(mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify({ cancelled: true }, null, 2));
  } else {
    const { lastFrame } = render(
      <Text color="yellow">Deletion cancelled.</Text>,
    );
    console.log(lastFrame());
  }
}
