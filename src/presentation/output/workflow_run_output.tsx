// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import type { OutputMode } from "./output.tsx";

/**
 * Artifact data included when --verbose is set.
 */
export interface StepArtifactsData {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  dataAttributes?: Record<string, unknown>;
}

export interface StepRunData {
  name: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  error?: string;
  duration?: number;
  /** Dependencies inferred from ${{ }} expressions */
  implicitDependencies?: string[];
  /** Output ID if this step produced an output (for model methods) */
  outputId?: string;
  /** Step artifacts included when --verbose is set */
  artifacts?: StepArtifactsData;
}

export interface JobRunData {
  name: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  steps: StepRunData[];
  duration?: number;
}

export interface WorkflowRunData {
  id: string;
  workflowId: string;
  workflowName: string;
  status: "pending" | "running" | "succeeded" | "failed";
  jobs: JobRunData[];
  duration?: number;
  path?: string;
}

export function renderWorkflowRun(
  data: WorkflowRunData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderInteractiveWorkflowRun(data);
  }
}

function renderInteractiveWorkflowRun(data: WorkflowRunData): void {
  const { lastFrame } = render(<WorkflowRunDisplay data={data} />);
  console.log(lastFrame());
}

interface WorkflowRunDisplayProps {
  data: WorkflowRunData;
}

function StatusIcon({ status }: { status: string }): React.ReactElement {
  const icons: Record<string, { icon: string; color: string }> = {
    pending: { icon: "○", color: "gray" },
    running: { icon: "◐", color: "yellow" },
    succeeded: { icon: "✓", color: "green" },
    failed: { icon: "✗", color: "red" },
    skipped: { icon: "⊘", color: "gray" },
  };

  const { icon, color } = icons[status] ?? { icon: "?", color: "white" };

  return <Text color={color}>{icon}</Text>;
}

function StepDisplay({ step }: { step: StepRunData }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text>
        <Text></Text>
        <StatusIcon status={step.status} />
        <Text>{step.name}</Text>
        {step.duration !== undefined && (
          <Text dimColor>({step.duration}ms)</Text>
        )}
      </Text>
      {step.error && (
        <Text color="red">
          <Text>→</Text>
          {step.error}
        </Text>
      )}
    </Box>
  );
}

function JobDisplay({ job }: { job: JobRunData }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text>
        <Text></Text>
        <StatusIcon status={job.status} />
        <Text bold>{job.name}</Text>
        {job.duration !== undefined && <Text dimColor>({job.duration}ms)</Text>}
      </Text>
      {job.steps.map((step, i) => <StepDisplay key={i} step={step} />)}
    </Box>
  );
}

export function WorkflowRunDisplay(
  props: WorkflowRunDisplayProps,
): React.ReactElement {
  const { data } = props;

  const statusColors: Record<string, string> = {
    pending: "gray",
    running: "yellow",
    succeeded: "green",
    failed: "red",
  };

  const statusColor = statusColors[data.status] ?? "white";

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box>
        <Text bold>Workflow:</Text>
        <Text>{data.workflowName}</Text>
      </Box>

      {/* Run Info */}
      <Box marginTop={1}>
        <Text dimColor>Run ID: {data.id}</Text>
      </Box>

      {/* Jobs */}
      <Box marginTop={1} flexDirection="column">
        <Text bold>Jobs:</Text>
        {data.jobs.map((job, i) => <JobDisplay key={i} job={job} />)}
      </Box>

      {/* Result */}
      <Box marginTop={1}>
        <Text bold>Result:</Text>
        <Text color={statusColor} bold>
          {data.status.toUpperCase()}
        </Text>
        {data.duration !== undefined && (
          <Text dimColor>({data.duration}ms)</Text>
        )}
      </Box>

      {/* Path */}
      {data.path && (
        <Box marginTop={1}>
          <Text dimColor>Saved to: {data.path}</Text>
        </Box>
      )}
    </Box>
  );
}
