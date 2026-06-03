// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, Text } from "ink";
import type { JobState, StepState } from "../state.ts";
import { StatusIcon } from "./status_icon.tsx";
import { StepLine } from "./step_line.tsx";
import { PeekLines } from "./peek_lines.tsx";
import { useSpinner } from "../hooks.ts";
import { useElapsed } from "../hooks.ts";
import { formatDuration } from "../../../output/utils/duration_formatter.ts";

/**
 * Compute tree connector prefix.
 */
export function treePrefix(
  index: number,
  total: number,
): { connector: string; continuation: string } {
  const isLast = index === total - 1;
  return {
    connector: isLast ? "  \u2514\u2500 " : "  \u251C\u2500 ",
    continuation: isLast ? "     " : "  \u2502  ",
  };
}

interface JobLineProps {
  job: JobState;
  index: number;
  totalJobs: number;
  expandSteps: boolean;
  peekLines: number;
}

export function JobLine(
  { job, index, totalJobs, expandSteps, peekLines }: JobLineProps,
) {
  const spinnerFrame = useSpinner();
  const elapsed = useElapsed(job.startedAt);
  const { connector, continuation } = treePrefix(index, totalJobs);

  // Collect running steps
  const runningSteps: StepState[] = [];
  for (const stepId of job.stepOrder) {
    const step = job.steps.get(stepId);
    if (step && step.status === "running") {
      runningSteps.push(step);
    }
  }

  // Build right-side info based on status
  let statusInfo: React.ReactNode;
  switch (job.status) {
    case "running": {
      if (runningSteps.length === 1) {
        const step = runningSteps[0];
        const modelMethod = step.modelName && step.methodName
          ? `${step.modelName} \u2192 ${step.methodName}`
          : null;
        const stepPrefix = modelMethod && step.id !== step.modelName
          ? `${step.id}: `
          : "";
        const label = modelMethod ? `${stepPrefix}${modelMethod}` : step.id;
        const dur = elapsed > 0 ? ` (${formatDuration(elapsed)})` : "";
        statusInfo = (
          <Text dimColor>
            <StatusIcon status="running" spinnerFrame={spinnerFrame} />
            {label}
            {dur}
          </Text>
        );
      } else if (runningSteps.length > 1) {
        statusInfo = (
          <Text dimColor>
            <StatusIcon status="running" spinnerFrame={spinnerFrame} />
            {runningSteps.length} running
          </Text>
        );
      } else {
        // Job started but no steps yet
        const dur = elapsed > 0 ? ` (${formatDuration(elapsed)})` : "";
        statusInfo = (
          <Text dimColor>
            <StatusIcon status="running" spinnerFrame={spinnerFrame} />
            starting{dur}
          </Text>
        );
      }
      break;
    }
    case "waiting":
      statusInfo = (
        <Text dimColor>
          <StatusIcon status="waiting" />waiting
        </Text>
      );
      break;
    case "blocked":
      statusInfo = (
        <Text dimColor>
          <StatusIcon status="blocked" />blocked
        </Text>
      );
      break;
    default:
      statusInfo = (
        <Text dimColor>
          <StatusIcon status={job.status} />
          {job.status}
        </Text>
      );
  }

  // Should we expand sub-lines?
  const showExpanded = expandSteps && runningSteps.length > 1;
  // Show peek for the single running step
  const showPeek = peekLines > 0 && runningSteps.length === 1;

  return (
    <Box flexDirection="column">
      <Box>
        <Text>{connector}{job.id}</Text>
        <Box flexGrow={1} />
        {statusInfo}
      </Box>
      {showExpanded &&
        runningSteps.map((step, si) => {
          const stepConnector = si === runningSteps.length - 1
            ? `${continuation}\u2514\u2500 `
            : `${continuation}\u251C\u2500 `;
          return <StepLine key={step.id} step={step} prefix={stepConnector} />;
        })}
      {showPeek && runningSteps[0].outputBuffer.length > 0 && (
        <PeekLines
          lines={runningSteps[0].outputBuffer}
          maxLines={peekLines}
          prefix={continuation}
        />
      )}
    </Box>
  );
}

interface CompressedJobLineProps {
  job: JobState;
  index: number;
  totalJobs: number;
}

export function CompressedJobLine(
  { job, index, totalJobs }: CompressedJobLineProps,
) {
  const spinnerFrame = useSpinner();
  const elapsed = useElapsed(job.startedAt);
  const { connector } = treePrefix(index, totalJobs);

  const dur = elapsed > 0 ? ` (${formatDuration(elapsed)})` : "";

  return (
    <Box>
      <Text>{connector}{job.id}</Text>
      <Box flexGrow={1} />
      <Text dimColor>
        <StatusIcon status="running" spinnerFrame={spinnerFrame} />
        {job.completedStepCount}/{job.stepOrder.length} steps{dur}
      </Text>
    </Box>
  );
}
