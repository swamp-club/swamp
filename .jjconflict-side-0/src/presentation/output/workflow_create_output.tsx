// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import type { OutputMode } from "./output.tsx";

export interface WorkflowCreateData {
  id: string;
  name: string;
  path: string;
}

export function renderWorkflowCreate(
  data: WorkflowCreateData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderInteractiveWorkflowCreate(data);
  }
}

function renderInteractiveWorkflowCreate(data: WorkflowCreateData): void {
  const { lastFrame } = render(<WorkflowCreateDisplay {...data} />);
  console.log(lastFrame());
}

interface WorkflowCreateDisplayProps {
  id: string;
  name: string;
  path: string;
}

export function WorkflowCreateDisplay(
  props: WorkflowCreateDisplayProps,
): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color="green">Created workflow:</Text>
      <Box marginLeft={2} flexDirection="column">
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
