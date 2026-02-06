// deno-lint-ignore-file verbatim-module-syntax
import React from "react";
import { Box, Text } from "ink";
import { type RunStatus, StatusIcon } from "./StatusIcon.tsx";
import type { StepRunData } from "../../workflow_run_output.ts";
import { calculateScrollWindow } from "../../hooks/mod.ts";
import { formatDuration } from "../../utils/duration_formatter.ts";
import type { PendingDep } from "./WorkflowExecutionUI.tsx";

/**
 * Formats pending dependencies for display.
 * Implicit dependencies are prefixed with '*' to distinguish them.
 * Truncates with "..." if the combined length exceeds maxLength.
 */
function formatDependencies(
  deps: PendingDep[],
  maxLength: number = 30,
): string {
  if (deps.length === 0) return "";

  const prefix = "← ";
  const formattedDeps = deps.map((d) => d.isImplicit ? `*${d.name}` : d.name);
  const joined = formattedDeps.join(", ");

  if (prefix.length + joined.length <= maxLength) {
    return prefix + joined;
  }

  // Truncate with ellipsis
  let result = "";
  for (let i = 0; i < formattedDeps.length; i++) {
    const separator = i === 0 ? "" : ", ";
    const candidate = result + separator + formattedDeps[i];
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
  pendingDeps: PendingDep[];
  hasLogs?: boolean;
}

function StepItem(
  { step, isSelected, pendingDeps, hasLogs }: StepItemProps,
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
        {hasLogs && <Text color="blue">📋</Text>}
        {depsDisplay && <Text dimColor>{` ${depsDisplay}`}</Text>}
        {showDuration && step.duration !== undefined && (
          <Text dimColor>{` (${formatDuration(step.duration)})`}</Text>
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
  pendingDependencies: Map<string, PendingDep[]>;
  logAvailability?: Map<string, boolean>;
  availableHeight?: number;
}

/**
 * Displays the steps for a selected job.
 */
export function StepsPanel(
  {
    jobName,
    steps,
    isFocused,
    selectedIndex,
    pendingDependencies,
    logAvailability,
    availableHeight,
  }: StepsPanelProps,
): React.ReactElement {
  const borderColor = isFocused ? "cyan" : "gray";
  const titleColor = isFocused ? "cyan" : undefined;

  // Reserve 3 lines for border (2) and header (1)
  const contentHeight = availableHeight !== undefined
    ? Math.max(1, availableHeight - 3)
    : steps.length;

  const { start, end } = calculateScrollWindow(
    steps.length,
    selectedIndex,
    contentHeight,
  );

  const visibleSteps = steps.slice(start, end);

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={borderColor}
      paddingX={1}
      flexGrow={1}
      overflow="hidden"
    >
      <Box flexShrink={0}>
        <Text bold color={titleColor}>Steps ({jobName})</Text>
        <Box flexGrow={1} />
        <Text dimColor>[{selectedIndex + 1}/{steps.length}]</Text>
      </Box>
      {visibleSteps.map((step, i) => (
        <StepItem
          key={start + i}
          step={step}
          isSelected={start + i === selectedIndex}
          pendingDeps={pendingDependencies.get(step.name) ?? []}
          hasLogs={logAvailability?.get(step.name) ?? false}
        />
      ))}
      {steps.length === 0 && <Text dimColor>No steps</Text>}
    </Box>
  );
}
