// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import type { OutputMode } from "./output.tsx";

export interface ValidationItemData {
  name: string;
  passed: boolean;
  error?: string;
}

export interface WorkflowValidateData {
  workflowId: string;
  workflowName: string;
  validations: ValidationItemData[];
  passed: boolean;
}

export interface WorkflowValidateAllData {
  workflows: WorkflowValidateData[];
  totalPassed: number;
  totalFailed: number;
  passed: boolean;
}

export function renderWorkflowValidate(
  data: WorkflowValidateData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderInteractiveWorkflowValidate(data);
  }
}

function renderInteractiveWorkflowValidate(data: WorkflowValidateData): void {
  const { lastFrame } = render(<WorkflowValidateDisplay {...data} />);
  console.log(lastFrame());
}

interface ValidationItemDisplayProps {
  name: string;
  passed: boolean;
  error?: string;
}

function ValidationItemDisplay(
  props: ValidationItemDisplayProps,
): React.ReactElement {
  const checkmark = "\u2713";
  const cross = "\u2717";
  const arrow = "\u2192";
  const icon = props.passed
    ? <Text color="green">{checkmark}</Text>
    : <Text color="red">{cross}</Text>;

  return (
    <Box flexDirection="column">
      <Text>
        <Text></Text>
        {icon}
        <Text>{props.name}</Text>
      </Text>
      {props.error && (
        <Text>
          <Text></Text>
          <Text color="red">{arrow} {props.error}</Text>
        </Text>
      )}
    </Box>
  );
}

interface WorkflowValidateDisplayProps {
  workflowId: string;
  workflowName: string;
  validations: ValidationItemData[];
  passed: boolean;
}

export function WorkflowValidateDisplay(
  props: WorkflowValidateDisplayProps,
): React.ReactElement {
  const passedCount = props.validations.filter((v) => v.passed).length;
  const totalCount = props.validations.length;

  return (
    <Box flexDirection="column">
      <Text>
        Validating workflow: <Text bold>{props.workflowName}</Text>
      </Text>
      <Text />
      {props.validations.map((v, i) => (
        <ValidationItemDisplay
          key={i}
          {...v}
        />
      ))}
      <Text />
      <Text>
        Summary: {passedCount}/{totalCount} validations passed
      </Text>
      <Text>
        Result: {props.passed
          ? (
            <Text color="green" bold>
              PASSED
            </Text>
          )
          : (
            <Text color="red" bold>
              FAILED
            </Text>
          )}
      </Text>
    </Box>
  );
}

export function renderWorkflowValidateAll(
  workflows: WorkflowValidateData[],
  mode: OutputMode,
): void {
  const totalPassed = workflows.filter((w) => w.passed).length;
  const totalFailed = workflows.length - totalPassed;
  const passed = totalFailed === 0;

  const data: WorkflowValidateAllData = {
    workflows,
    totalPassed,
    totalFailed,
    passed,
  };

  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderInteractiveWorkflowValidateAll(data);
  }
}

function renderInteractiveWorkflowValidateAll(
  data: WorkflowValidateAllData,
): void {
  const { lastFrame } = render(<WorkflowValidateAllDisplay {...data} />);
  console.log(lastFrame());
}

interface WorkflowSummaryDisplayProps {
  workflowName: string;
  validations: ValidationItemData[];
  passed: boolean;
}

function WorkflowSummaryDisplay(
  props: WorkflowSummaryDisplayProps,
): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>{props.workflowName}</Text>
      </Text>
      {props.validations.map((v, i) => (
        <ValidationItemDisplay
          key={i}
          {...v}
        />
      ))}
      <Text>
        Result: {props.passed
          ? (
            <Text color="green" bold>
              PASSED
            </Text>
          )
          : (
            <Text color="red" bold>
              FAILED
            </Text>
          )}
      </Text>
    </Box>
  );
}

interface WorkflowValidateAllDisplayProps {
  workflows: WorkflowValidateData[];
  totalPassed: number;
  totalFailed: number;
  passed: boolean;
}

export function WorkflowValidateAllDisplay(
  props: WorkflowValidateAllDisplayProps,
): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text>Validating all workflows...</Text>
      <Text />
      {props.workflows.map((workflow, i) => (
        <Box key={i} flexDirection="column" marginBottom={1}>
          <WorkflowSummaryDisplay
            workflowName={workflow.workflowName}
            validations={workflow.validations}
            passed={workflow.passed}
          />
        </Box>
      ))}
      <Text>
        Summary: {props.totalPassed}/{props.workflows.length} workflows passed
      </Text>
      <Text>
        Overall: {props.passed
          ? (
            <Text color="green" bold>
              PASSED
            </Text>
          )
          : (
            <Text color="red" bold>
              FAILED
            </Text>
          )}
      </Text>
    </Box>
  );
}
