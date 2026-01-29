// deno-lint-ignore-file verbatim-module-syntax
import React from "react";
import { Box, Text } from "ink";
import { type RunStatus, StatusIcon } from "./StatusIcon.tsx";
import type { StepRunData } from "../../workflow_run_output.tsx";

/**
 * Formats pending dependencies for display.
 * Truncates with "..." if the combined length exceeds maxLength.
 */
function formatDependencies(deps: string[], maxLength: number = 30): string {
  if (deps.length === 0) return "";

  const prefix = "← ";
  const joined = deps.join(", ");

  if (prefix.length + joined.length <= maxLength) {
    return prefix + joined;
  }

  // Truncate with ellipsis
  let result = "";
  for (let i = 0; i < deps.length; i++) {
    const separator = i === 0 ? "" : ", ";
    const candidate = result + separator + deps[i];
    if (prefix.length + candidate.length + 4 > maxLength) {
      return prefix + result + ", ...";
    }
    result = candidate;
  }
  return prefix + result;
}

interface StepItemProps {
  step: StepRunData;
  isSelected: boolean;
  pendingDeps: string[];
}

function StepItem(
  { step, isSelected, pendingDeps }: StepItemProps,
): React.ReactElement {
  const showDuration = step.status === "succeeded" || step.status === "failed";
  const depsDisplay = formatDependencies(pendingDeps);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={isSelected ? "cyan" : undefined}>
          {isSelected ? "▶ " : "  "}
        </Text>
        <StatusIcon status={step.status as RunStatus} />
        {/* deno-fmt-ignore */}
        <Text> </Text>
        <Text bold={isSelected}>{step.name}</Text>
        {depsDisplay && <Text dimColor>{` ${depsDisplay}`}</Text>}
        {showDuration && step.duration !== undefined && (
          <Text dimColor>{` (${step.duration}ms)`}</Text>
        )}
        {/* deno-fmt-ignore */}
        {step.status === "running" && <Text color="yellow">  running...</Text>}
      </Box>
      {step.error && (
        <Box marginLeft={4}>
          <Text color="red">{step.error}</Text>
        </Box>
      )}
    </Box>
  );
}

interface StepsPanelProps {
  jobName: string;
  steps: StepRunData[];
  isFocused: boolean;
  selectedIndex: number;
  pendingDependencies: Map<string, string[]>;
}

/**
 * Displays the steps for a selected job.
 */
export function StepsPanel(
  { jobName, steps, isFocused, selectedIndex, pendingDependencies }:
    StepsPanelProps,
): React.ReactElement {
  const borderColor = isFocused ? "cyan" : "gray";
  const titleColor = isFocused ? "cyan" : undefined;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={borderColor}
      paddingX={1}
    >
      <Box>
        <Text bold color={titleColor}>Steps ({jobName})</Text>
        <Box flexGrow={1} />
        <Text dimColor>[{selectedIndex + 1}/{steps.length}]</Text>
      </Box>
      {steps.map((step, i) => (
        <StepItem
          key={i}
          step={step}
          isSelected={i === selectedIndex}
          pendingDeps={pendingDependencies.get(step.name) ?? []}
        />
      ))}
      {steps.length === 0 && <Text dimColor>No steps</Text>}
    </Box>
  );
}
