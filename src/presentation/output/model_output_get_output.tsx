// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, render, Text } from "ink";
import type { OutputMode } from "./output.tsx";

/**
 * Data structure for provenance information.
 */
export interface ProvenanceData {
  inputHash: string;
  modelVersion: number;
  triggeredBy: string;
  workflowId?: string;
  workflowRunId?: string;
  stepName?: string;
}

/**
 * Data structure for artifacts information.
 */
export interface ArtifactsData {
  resourceId?: string;
  dataId?: string;
  fileId?: string;
  logId?: string;
}

/**
 * Data structure for error information.
 */
export interface ErrorData {
  message: string;
  stack?: string;
}

/**
 * Data structure for the model output get output.
 */
export interface ModelOutputGetData {
  id: string;
  modelInputId: string;
  modelName?: string;
  type: string;
  methodName: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  retryCount: number;
  provenance: ProvenanceData;
  artifacts?: ArtifactsData;
  error?: ErrorData;
}

/**
 * Renders the model output get output in either interactive or JSON mode.
 */
export function renderModelOutputGet(
  data: ModelOutputGetData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderInteractiveModelOutputGet(data);
  }
}

function renderInteractiveModelOutputGet(data: ModelOutputGetData): void {
  const instance = render(<ModelOutputGetDisplay data={data} />);
  instance.unmount();
}

interface ModelOutputGetDisplayProps {
  data: ModelOutputGetData;
}

/**
 * Component to display a section with a header.
 */
function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="cyan" bold>
        ## {title}
      </Text>
      <Box marginTop={1} marginLeft={2} flexDirection="column">
        {children}
      </Box>
    </Box>
  );
}

/**
 * Component to display a key-value pair.
 */
function KeyValue({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.ReactElement {
  return (
    <Text>
      <Text color="cyan">{`${label}: `}</Text>
      <Text>{value}</Text>
    </Text>
  );
}

/**
 * Gets the status color based on execution status.
 */
function getStatusColor(
  status: string,
): "green" | "yellow" | "red" | "blue" | undefined {
  switch (status) {
    case "succeeded":
      return "green";
    case "failed":
      return "red";
    case "running":
      return "yellow";
    case "pending":
      return "blue";
    default:
      return undefined;
  }
}

/**
 * Formats duration in a human-readable way.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  } else if (ms < 60000) {
    return `${(ms / 1000).toFixed(2)}s`;
  } else {
    const minutes = Math.floor(ms / 60000);
    const seconds = ((ms % 60000) / 1000).toFixed(0);
    return `${minutes}m ${seconds}s`;
  }
}

/**
 * Interactive display component for model output get.
 */
export function ModelOutputGetDisplay(
  props: ModelOutputGetDisplayProps,
): React.ReactElement {
  const { data } = props;
  const hasArtifacts = data.artifacts &&
    Object.values(data.artifacts).some((v) => v !== undefined);

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Text color="green" bold>
        # Output: {data.methodName} on {data.modelName ?? data.modelInputId}
      </Text>

      {/* Basic Info */}
      <Section title="Output Info">
        <KeyValue label="ID" value={data.id} />
        <KeyValue label="Model Input ID" value={data.modelInputId} />
        {data.modelName && (
          <KeyValue label="Model Name" value={data.modelName} />
        )}
        <KeyValue label="Type" value={data.type} />
        <KeyValue label="Method" value={data.methodName} />
        <Box>
          <Text color="cyan">Status:</Text>
          <Text color={getStatusColor(data.status)} bold>
            {data.status.toUpperCase()}
          </Text>
        </Box>
      </Section>

      {/* Timing */}
      <Section title="Timing">
        <KeyValue label="Started At" value={data.startedAt} />
        {data.completedAt && (
          <KeyValue label="Completed At" value={data.completedAt} />
        )}
        {data.durationMs !== undefined && (
          <KeyValue label="Duration" value={formatDuration(data.durationMs)} />
        )}
        <KeyValue label="Retry Count" value={String(data.retryCount)} />
      </Section>

      {/* Provenance */}
      <Section title="Provenance">
        <KeyValue label="Triggered By" value={data.provenance.triggeredBy} />
        <KeyValue
          label="Model Version"
          value={String(data.provenance.modelVersion)}
        />
        <KeyValue
          label="Input Hash"
          value={data.provenance.inputHash.slice(0, 16) + "..."}
        />
        {data.provenance.workflowId && (
          <KeyValue label="Workflow ID" value={data.provenance.workflowId} />
        )}
        {data.provenance.workflowRunId && (
          <KeyValue
            label="Workflow Run ID"
            value={data.provenance.workflowRunId}
          />
        )}
        {data.provenance.stepName && (
          <KeyValue label="Step Name" value={data.provenance.stepName} />
        )}
      </Section>

      {/* Artifacts */}
      {hasArtifacts && (
        <Section title="Artifacts">
          {data.artifacts?.resourceId && (
            <KeyValue label="Resource ID" value={data.artifacts.resourceId} />
          )}
          {data.artifacts?.dataId && (
            <KeyValue label="Data ID" value={data.artifacts.dataId} />
          )}
          {data.artifacts?.fileId && (
            <KeyValue label="File ID" value={data.artifacts.fileId} />
          )}
          {data.artifacts?.logId && (
            <KeyValue label="Log ID" value={data.artifacts.logId} />
          )}
        </Section>
      )}

      {/* Error */}
      {data.error && (
        <Section title="Error">
          <Text color="red">{data.error.message}</Text>
          {data.error.stack && (
            <Box marginTop={1}>
              <Text dimColor>{data.error.stack}</Text>
            </Box>
          )}
        </Section>
      )}
    </Box>
  );
}
