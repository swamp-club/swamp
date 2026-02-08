// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, render, Text } from "ink";
import type { OutputMode } from "./output.tsx";

/**
 * Data structure for the data get output.
 */
export interface DataGetData {
  id: string;
  name: string;
  modelId: string;
  modelName: string;
  modelType: string;
  version: number;
  contentType: string;
  lifetime: string;
  garbageCollection: string | number;
  streaming: boolean;
  tags: Record<string, string>;
  ownerDefinition: {
    definitionHash: string;
    ownerType: string;
    ownerRef: string;
    workflowId?: string;
    workflowRunId?: string;
  };
  createdAt: string;
  size?: number;
  checksum?: string;
  contentPath: string;
}

/**
 * Renders the data get output in either interactive or JSON mode.
 */
export function renderDataGet(data: DataGetData, mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderInteractiveDataGet(data);
  }
}

function renderInteractiveDataGet(data: DataGetData): void {
  const instance = render(<DataGetDisplay data={data} />);
  instance.unmount();
}

interface DataGetDisplayProps {
  data: DataGetData;
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
 * Formats bytes into human-readable size.
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

/**
 * Interactive display component for data get.
 */
export function DataGetDisplay(props: DataGetDisplayProps): React.ReactElement {
  const { data } = props;
  const hasTags = Object.keys(data.tags).length > 0;

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Text color="green" bold>
        # {data.name} (v{data.version})
      </Text>

      {/* Basic Info */}
      <Section title="Data Info">
        <KeyValue label="ID" value={data.id} />
        <KeyValue label="Version" value={String(data.version)} />
        <KeyValue label="Content Type" value={data.contentType} />
        <KeyValue label="Streaming" value={data.streaming ? "yes" : "no"} />
        {data.size !== undefined && (
          <KeyValue label="Size" value={formatBytes(data.size)} />
        )}
        {data.checksum && <KeyValue label="Checksum" value={data.checksum} />}
        <KeyValue label="Created At" value={data.createdAt} />
      </Section>

      {/* Model Info */}
      <Section title="Model">
        <KeyValue label="Model Name" value={data.modelName} />
        <KeyValue label="Model ID" value={data.modelId} />
        <KeyValue label="Model Type" value={data.modelType} />
      </Section>

      {/* Lifecycle */}
      <Section title="Lifecycle">
        <KeyValue label="Lifetime" value={data.lifetime} />
        <KeyValue
          label="Garbage Collection"
          value={String(data.garbageCollection)}
        />
      </Section>

      {/* Tags */}
      {hasTags && (
        <Section title="Tags">
          {Object.entries(data.tags).map(([key, value]) => (
            <KeyValue key={key} label={key} value={value} />
          ))}
        </Section>
      )}

      {/* Owner */}
      <Section title="Owner">
        <KeyValue label="Type" value={data.ownerDefinition.ownerType} />
        <KeyValue label="Reference" value={data.ownerDefinition.ownerRef} />
        <KeyValue label="Hash" value={data.ownerDefinition.definitionHash} />
        {data.ownerDefinition.workflowId && (
          <KeyValue
            label="Workflow ID"
            value={data.ownerDefinition.workflowId}
          />
        )}
        {data.ownerDefinition.workflowRunId && (
          <KeyValue
            label="Workflow Run ID"
            value={data.ownerDefinition.workflowRunId}
          />
        )}
      </Section>

      {/* Path */}
      <Section title="Content">
        <KeyValue label="Path" value={data.contentPath} />
      </Section>
    </Box>
  );
}
