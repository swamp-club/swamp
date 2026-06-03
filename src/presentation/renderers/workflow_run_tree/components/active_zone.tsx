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
import type { TreeState } from "../state.ts";
import type { BudgetResult } from "../budget.ts";
import { CompressedJobLine, JobLine } from "./job_line.tsx";
import { StatusIcon } from "./status_icon.tsx";
import { useSpinner } from "../hooks.ts";

interface ActiveZoneProps {
  state: TreeState;
  budget: BudgetResult;
}

export function ActiveZone({ state, budget }: ActiveZoneProps) {
  const spinnerFrame = useSpinner();

  // Partition jobs by status
  const runningJobs: Array<{ id: string; index: number }> = [];
  const waitingJobs: Array<{ id: string; status: "waiting" | "blocked" }> = [];

  const visibleJobIds = state.jobOrder.filter((id) => {
    const job = state.jobs.get(id);
    return job &&
      (job.status === "running" || job.status === "waiting" ||
        job.status === "blocked");
  });

  for (const id of visibleJobIds) {
    const job = state.jobs.get(id)!;
    if (job.status === "running") {
      runningJobs.push({ id, index: visibleJobIds.indexOf(id) });
    } else {
      waitingJobs.push({
        id,
        status: job.status as "waiting" | "blocked",
      });
    }
  }

  const totalVisible = visibleJobIds.length;

  if (budget.tier === "one_line") {
    return (
      <Box>
        <Text>
          <StatusIcon status="running" spinnerFrame={spinnerFrame} />
          {state.workflowName}: {runningJobs.length} running
          {waitingJobs.length > 0 ? `, ${waitingJobs.length} waiting` : ""}
        </Text>
      </Box>
    );
  }

  // Cap visible running jobs to budget
  const visibleRunning = runningJobs.slice(0, budget.maxVisibleRunning);
  const hiddenRunningCount = runningJobs.length - visibleRunning.length;

  return (
    <Box flexDirection="column">
      {visibleRunning.map(({ id, index }) => {
        const job = state.jobs.get(id)!;
        if (budget.tier === "compressed_steps") {
          return (
            <CompressedJobLine
              key={id}
              job={job}
              index={index}
              totalJobs={totalVisible}
            />
          );
        }
        return (
          <JobLine
            key={id}
            job={job}
            index={index}
            totalJobs={totalVisible}
            expandSteps={budget.expandSteps}
            peekLines={budget.peekLines}
          />
        );
      })}
      {hiddenRunningCount > 0 && (
        <Text dimColor>
          {"  \u2026 "}
          {hiddenRunningCount} more running
        </Text>
      )}
      {budget.showWaitingList &&
        waitingJobs.map(({ id, status }) => {
          const index = visibleJobIds.indexOf(id);
          const isLast = index === totalVisible - 1;
          const connector = isLast ? "  \u2514\u2500 " : "  \u251C\u2500 ";
          return (
            <Box key={id}>
              <Text>{connector}{id}</Text>
              <Box flexGrow={1} />
              <Text dimColor>
                <StatusIcon status={status} />
                {status}
              </Text>
            </Box>
          );
        })}
      {!budget.showWaitingList && waitingJobs.length > 0 && (
        <Text dimColor>
          {"  \u2026 "}
          {waitingJobs.length} jobs waiting
        </Text>
      )}
    </Box>
  );
}

interface ReportProgressProps {
  reportName: string | null;
}

export function ReportProgress({ reportName }: ReportProgressProps) {
  const spinnerFrame = useSpinner();

  return (
    <Box>
      <Text>
        <StatusIcon status="running" spinnerFrame={spinnerFrame} />
        Running reports
        {reportName ? ` (${reportName})` : ""}...
      </Text>
    </Box>
  );
}
