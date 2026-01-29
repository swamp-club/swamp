// deno-lint-ignore-file verbatim-module-syntax
import React from "react";
import { Box, Text } from "ink";
import { type RunStatus, StatusIcon } from "./StatusIcon.tsx";
import type { JobRunData } from "../../workflow_run_output.tsx";

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

interface JobItemProps {
  job: JobRunData;
  isSelected: boolean;
  allDeps: string[];
}

function JobItem(
  { job, isSelected, allDeps }: JobItemProps,
): React.ReactElement {
  const depsDisplay = formatDependencies(allDeps);

  return (
    <Box>
      <Text color={isSelected ? "cyan" : undefined}>
        {isSelected ? "▶ " : "  "}
      </Text>
      <StatusIcon status={job.status as RunStatus} />
      {/* deno-fmt-ignore */}
      <Text> </Text>
      <Text bold={isSelected}>{job.name}</Text>
      {depsDisplay && <Text dimColor>{` ${depsDisplay}`}</Text>}
      <Text dimColor>
        {job.status === "running"
          ? "  running"
          : job.status === "succeeded" || job.status === "failed"
          ? job.duration !== undefined ? ` (${job.duration}ms)` : ""
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
  allDependencies: Map<string, string[]>;
}

/**
 * Displays the list of jobs with selection indicator.
 */
export function JobsPanel(
  { jobs, selectedIndex, isFocused, allDependencies }: JobsPanelProps,
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
        <Text bold color={titleColor}>Jobs</Text>
        <Box flexGrow={1} />
        <Text dimColor>[{selectedIndex + 1}/{jobs.length}]</Text>
      </Box>
      {jobs.map((job, i) => (
        <JobItem
          key={i}
          job={job}
          isSelected={i === selectedIndex}
          allDeps={allDependencies.get(job.name) ?? []}
        />
      ))}
      {jobs.length === 0 && <Text dimColor>No jobs</Text>}
    </Box>
  );
}
