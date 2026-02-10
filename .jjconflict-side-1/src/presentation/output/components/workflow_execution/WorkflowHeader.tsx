// deno-lint-ignore-file verbatim-module-syntax
import React from "react";
import { Box, Text } from "ink";

interface WorkflowHeaderProps {
  workflowName: string;
  runId: string | null;
  status: "pending" | "running" | "succeeded" | "failed";
}

const statusColors: Record<string, string> = {
  pending: "gray",
  running: "yellow",
  succeeded: "green",
  failed: "red",
};

/**
 * Displays the workflow header with name, run ID, and status.
 */
export function WorkflowHeader(
  { workflowName, runId, status }: WorkflowHeaderProps,
): React.ReactElement {
  const statusColor = statusColors[status] ?? "white";

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* deno-fmt-ignore */}
      <Box>
        <Text bold>Workflow: </Text>
        <Text>{workflowName}</Text>
      </Box>
      {runId && (
        // deno-fmt-ignore
        <Box>
          <Text bold>Run ID: </Text>
          <Text dimColor>{runId}</Text>
        </Box>
      )}
      {/* deno-fmt-ignore */}
      <Box>
        <Text bold>Status: </Text>
        <Text color={statusColor} bold>
          {status.toUpperCase()}
        </Text>
      </Box>
    </Box>
  );
}
