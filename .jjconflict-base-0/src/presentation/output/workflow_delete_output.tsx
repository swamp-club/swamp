// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import type { OutputMode } from "./output.tsx";

/**
 * Data structure for the workflow delete output.
 */
export interface WorkflowDeleteData {
  id: string;
  name: string;
  workflowPath: string;
  runsDeleted: number;
}

/**
 * JSON output structure for workflow delete.
 */
export interface WorkflowDeleteJsonOutput {
  deleted: {
    id: string;
    name: string;
    workflowPath: string;
  };
  runsDeleted: number;
}

/**
 * Renders the workflow delete output in either interactive or JSON mode.
 */
export function renderWorkflowDelete(
  data: WorkflowDeleteData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    const output: WorkflowDeleteJsonOutput = {
      deleted: {
        id: data.id,
        name: data.name,
        workflowPath: data.workflowPath,
      },
      runsDeleted: data.runsDeleted,
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    renderInteractiveWorkflowDelete(data);
  }
}

function renderInteractiveWorkflowDelete(data: WorkflowDeleteData): void {
  const { lastFrame } = render(<WorkflowDeleteDisplay {...data} />);
  console.log(lastFrame());
}

interface WorkflowDeleteDisplayProps {
  id: string;
  name: string;
  workflowPath: string;
  runsDeleted: number;
}

/**
 * Interactive display component for workflow delete.
 */
export function WorkflowDeleteDisplay(
  props: WorkflowDeleteDisplayProps,
): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color="green">Deleted workflow:</Text>
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
          <Text dimColor>{props.workflowPath}</Text>
        </Text>
        {props.runsDeleted > 0 && (
          <Text>
            <Text color="cyan">Runs deleted:</Text>
            <Text>{props.runsDeleted}</Text>
          </Text>
        )}
      </Box>
    </Box>
  );
}

/**
 * Renders a cancellation message.
 */
export function renderWorkflowDeleteCancelled(mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify({ cancelled: true }, null, 2));
  } else {
    const { lastFrame } = render(
      <Text color="yellow">Deletion cancelled.</Text>,
    );
    console.log(lastFrame());
  }
}
