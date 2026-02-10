// deno-lint-ignore-file verbatim-module-syntax
import React from "react";
import { Box, Text } from "ink";
import { type RunStatus, StatusIcon } from "./StatusIcon.tsx";
import type { JobRunData } from "../../workflow_run_output.ts";
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

interface JobItemProps {
  job: JobRunData;
  isSelected: boolean;
  pendingDeps: PendingDep[];
  hasLogs?: boolean;
}

function JobItem(
  { job, isSelected, pendingDeps, hasLogs }: JobItemProps,
): React.ReactElement {
  const depsDisplay = formatDependencies(pendingDeps);

  return (
    <Box>
      <Text color={isSelected ? "cyan" : undefined}>
        {isSelected ? "▶ " : "  "}
      </Text>
      <StatusIcon status={job.status as RunStatus} />
      {/* deno-fmt-ignore */}
      <Text> </Text>
      <Text bold={isSelected}>{job.name}</Text>
      {hasLogs && <Text color="blue">📋</Text>}
      {depsDisplay && <Text dimColor>{` ${depsDisplay}`}</Text>}
      <Text dimColor>
        {job.status === "running"
          ? "  running"
          : job.status === "succeeded" || job.status === "failed"
          ? job.duration !== undefined
            ? ` (${formatDuration(job.duration)})`
            : ""
          : job.status === "pending"
          ? " pending"
          : job.status === "skipped"
          ? " skipped"
          : ""}
      </Text>
    </Box>
  );
}

interface JobsPanelProps {
  jobs: JobRunData[];
  selectedIndex: number;
  isFocused: boolean;
  pendingDependencies: Map<string, PendingDep[]>;
  logAvailability?: Map<string, boolean>;
  availableHeight?: number;
}

/**
 * Displays the list of jobs with selection indicator.
 */
export function JobsPanel(
  {
    jobs,
    selectedIndex,
    isFocused,
    pendingDependencies,
    logAvailability,
    availableHeight,
  }: JobsPanelProps,
): React.ReactElement {
  const borderColor = isFocused ? "cyan" : "gray";
  const titleColor = isFocused ? "cyan" : undefined;

  // Reserve 3 lines for border (2) and header (1)
  const contentHeight = availableHeight !== undefined
    ? Math.max(1, availableHeight - 3)
    : jobs.length;

  const { start, end } = calculateScrollWindow(
    jobs.length,
    selectedIndex,
    contentHeight,
  );

  const visibleJobs = jobs.slice(start, end);

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
        <Text bold color={titleColor}>Jobs</Text>
        <Box flexGrow={1} />
        <Text dimColor>[{selectedIndex + 1}/{jobs.length}]</Text>
      </Box>
      {visibleJobs.map((job, i) => (
        <JobItem
          key={start + i}
          job={job}
          isSelected={start + i === selectedIndex}
          pendingDeps={pendingDependencies.get(job.name) ?? []}
          hasLogs={logAvailability?.get(job.name) ?? false}
        />
      ))}
      {jobs.length === 0 && <Text dimColor>No jobs</Text>}
    </Box>
  );
}
