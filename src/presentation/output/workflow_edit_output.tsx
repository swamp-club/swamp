// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import type { OutputMode } from "./output.tsx";

/**
 * Data structure for workflow edit output.
 */
export interface WorkflowEditData {
  path: string;
  editor?: string;
  status: "opened" | "updated";
  name: string;
  id: string;
}

/**
 * Renders workflow edit output in either interactive or JSON mode.
 */
export function renderWorkflowEdit(
  data: WorkflowEditData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderInteractiveWorkflowEdit(data);
  }
}

function renderInteractiveWorkflowEdit(data: WorkflowEditData): void {
  const { lastFrame } = render(<WorkflowEditDisplay {...data} />);
  console.log(lastFrame());
}

interface WorkflowEditDisplayProps {
  path: string;
  editor?: string;
  status: "opened" | "updated";
  name: string;
  id: string;
}

/**
 * Interactive display component for workflow edit output.
 */
export function WorkflowEditDisplay(
  props: WorkflowEditDisplayProps,
): React.ReactElement {
  const header = props.status === "updated"
    ? "Updated workflow from stdin:"
    : `Opening workflow in ${props.editor}:`;

  return (
    <Box flexDirection="column">
      <Text color="green">{header}</Text>
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
