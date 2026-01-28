// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, render, Text } from "ink";
import type { OutputMode } from "./output.tsx";

export interface ModelCreateData {
  id: string;
  type: string;
  name: string;
  path: string;
}

export function renderModelCreate(
  data: ModelCreateData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderInteractiveModelCreate(data);
  }
}

function renderInteractiveModelCreate(data: ModelCreateData): void {
  const { unmount } = render(<ModelCreateDisplay {...data} />);
  unmount();
}

interface ModelCreateDisplayProps {
  id: string;
  type: string;
  name: string;
  path: string;
}

export function ModelCreateDisplay(
  props: ModelCreateDisplayProps,
): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color="green">Created model input:</Text>
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
          <Text dimColor>{props.path}</Text>
        </Text>
      </Box>
    </Box>
  );
}
