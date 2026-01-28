// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, render, Text } from "ink";
import type { OutputMode } from "./output.tsx";

export interface ValidationItemData {
  name: string;
  passed: boolean;
  error?: string;
}

export interface ModelValidateData {
  modelId: string;
  modelName: string;
  type: string;
  validations: ValidationItemData[];
  passed: boolean;
}

export interface ModelValidateAllData {
  models: ModelValidateData[];
  totalPassed: number;
  totalFailed: number;
  passed: boolean;
}

export function renderModelValidate(
  data: ModelValidateData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderInteractiveModelValidate(data);
  }
}

function renderInteractiveModelValidate(data: ModelValidateData): void {
  const { unmount } = render(<ModelValidateDisplay {...data} />);
  unmount();
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

interface ModelValidateDisplayProps {
  modelId: string;
  modelName: string;
  type: string;
  validations: ValidationItemData[];
  passed: boolean;
}

export function ModelValidateDisplay(
  props: ModelValidateDisplayProps,
): React.ReactElement {
  const passedCount = props.validations.filter((v) => v.passed).length;
  const totalCount = props.validations.length;

  return (
    <Box flexDirection="column">
      <Text>
        Validating model: <Text bold>{props.modelName}</Text> (
        <Text dimColor>{props.type}</Text>)
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

export function renderModelValidateAll(
  models: ModelValidateData[],
  mode: OutputMode,
): void {
  const totalPassed = models.filter((m) => m.passed).length;
  const totalFailed = models.length - totalPassed;
  const passed = totalFailed === 0;

  const data: ModelValidateAllData = {
    models,
    totalPassed,
    totalFailed,
    passed,
  };

  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderInteractiveModelValidateAll(data);
  }
}

function renderInteractiveModelValidateAll(data: ModelValidateAllData): void {
  const { unmount } = render(<ModelValidateAllDisplay {...data} />);
  unmount();
}

interface ModelSummaryDisplayProps {
  modelName: string;
  type: string;
  validations: ValidationItemData[];
  passed: boolean;
}

function ModelSummaryDisplay(
  props: ModelSummaryDisplayProps,
): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>{props.modelName}</Text> (<Text dimColor>{props.type}</Text>)
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

interface ModelValidateAllDisplayProps {
  models: ModelValidateData[];
  totalPassed: number;
  totalFailed: number;
  passed: boolean;
}

export function ModelValidateAllDisplay(
  props: ModelValidateAllDisplayProps,
): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text>Validating all models...</Text>
      <Text />
      {props.models.map((model, i) => (
        <Box key={i} flexDirection="column" marginBottom={1}>
          <ModelSummaryDisplay
            modelName={model.modelName}
            type={model.type}
            validations={model.validations}
            passed={model.passed}
          />
        </Box>
      ))}
      <Text>
        Summary: {props.totalPassed}/{props.models.length} models passed
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
