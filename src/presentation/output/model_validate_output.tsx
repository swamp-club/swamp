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
        <Text>  </Text>
        {icon}
        <Text> {props.name}</Text>
      </Text>
      {props.error && (
        <Text>
          <Text>    </Text>
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
