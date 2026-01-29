// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import type { OutputMode } from "./output.tsx";

/**
 * Data structure for the workflow schema output.
 */
export interface WorkflowSchemaData {
  workflow: object;
  job: object;
  jobDependency: object;
  step: object;
  stepDependency: object;
  stepTask: object;
  triggerCondition: object;
}

/**
 * Renders the workflow schema in either interactive or JSON mode.
 */
export function renderWorkflowSchema(
  data: WorkflowSchemaData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderInteractiveWorkflowSchema(data);
  }
}

function renderInteractiveWorkflowSchema(data: WorkflowSchemaData): void {
  const { lastFrame } = render(<WorkflowSchemaDisplay data={data} />);
  console.log(lastFrame());
}

interface WorkflowSchemaDisplayProps {
  data: WorkflowSchemaData;
}

/**
 * Formats a JSON schema object as a string with indentation.
 */
function formatSchema(schema: object): string {
  return JSON.stringify(schema, null, 2);
}

/**
 * Component to display a schema section with a header.
 */
function SchemaSection({
  title,
  description,
  schema,
}: {
  title: string;
  description: string;
  schema: object;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="cyan" bold>
        ## {title}
      </Text>
      <Box marginLeft={2}>
        <Text dimColor>{description}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{formatSchema(schema)}</Text>
      </Box>
    </Box>
  );
}

/**
 * Interactive display component for workflow schema.
 */
export function WorkflowSchemaDisplay(
  props: WorkflowSchemaDisplayProps,
): React.ReactElement {
  const { data } = props;

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Text color="green" bold>
        # Workflow Schema
      </Text>

      {/* Description */}
      <Box marginTop={1}>
        <Text>
          These schemas define the structure of workflow files. Use them to
          understand valid workflow definitions.
        </Text>
      </Box>

      {/* Workflow Schema */}
      <SchemaSection
        title="Workflow"
        description="Top-level workflow structure with id, name, description, jobs, and version."
        schema={data.workflow}
      />

      {/* Job Schema */}
      <SchemaSection
        title="Job"
        description="Job definition with name, description, steps, dependsOn, and weight."
        schema={data.job}
      />

      {/* Job Dependency Schema */}
      <SchemaSection
        title="Job Dependency"
        description="Job dependency specifying target job and trigger condition."
        schema={data.jobDependency}
      />

      {/* Step Schema */}
      <SchemaSection
        title="Step"
        description="Step definition with name, description, task, dependsOn, and weight."
        schema={data.step}
      />

      {/* Step Dependency Schema */}
      <SchemaSection
        title="Step Dependency"
        description="Step dependency specifying target step and trigger condition."
        schema={data.stepDependency}
      />

      {/* Step Task Schema */}
      <SchemaSection
        title="Step Task"
        description="Discriminated union: type 'shell' for shell commands or type 'model_method' for model invocations."
        schema={data.stepTask}
      />

      {/* Trigger Condition Schema */}
      <SchemaSection
        title="Trigger Condition"
        description="Conditions: always, succeeded(ref), failed(ref), completed(ref), skipped(ref), and/or/not combinators."
        schema={data.triggerCondition}
      />
    </Box>
  );
}
