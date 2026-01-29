// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import type { OutputMode } from "./output.tsx";
import { stringify as stringifyYaml } from "@std/yaml";

export interface WorkflowGetData {
  id: string;
  name: string;
  description?: string;
  version: number;
  jobs: {
    name: string;
    description?: string;
    steps: {
      name: string;
      description?: string;
      task: {
        type: string;
        [key: string]: unknown;
      };
    }[];
  }[];
  path: string;
}

export function renderWorkflowGet(
  data: WorkflowGetData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderInteractiveWorkflowGet(data);
  }
}

function renderInteractiveWorkflowGet(data: WorkflowGetData): void {
  const { lastFrame } = render(<WorkflowGetDisplay data={data} />);
  console.log(lastFrame());
}

interface WorkflowGetDisplayProps {
  data: WorkflowGetData;
}

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

function KeyValue({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.ReactElement {
  return (
    <Text>
      <Text color="cyan">{label}:</Text>
      <Text>{value}</Text>
    </Text>
  );
}

export function WorkflowGetDisplay(
  props: WorkflowGetDisplayProps,
): React.ReactElement {
  const { data } = props;

  // Format the workflow as YAML for display
  const workflowYaml = stringifyYaml({
    id: data.id,
    name: data.name,
    description: data.description,
    version: data.version,
    jobs: data.jobs,
  }, { skipInvalid: true });

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Text color="green" bold>
        # {data.name}
      </Text>

      {/* Basic Info */}
      <Section title="Workflow Info">
        <KeyValue label="ID" value={data.id} />
        <KeyValue label="Version" value={String(data.version)} />
        {data.description && (
          <KeyValue label="Description" value={data.description} />
        )}
        <KeyValue label="Jobs" value={String(data.jobs.length)} />
      </Section>

      {/* YAML Content */}
      <Section title="Definition">
        <Text dimColor>{workflowYaml}</Text>
      </Section>

      {/* Path */}
      <Section title="Location">
        <Text dimColor>{data.path}</Text>
      </Section>
    </Box>
  );
}
