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

import { bold, cyan, dim, green, yellow } from "@std/fmt/colors";
import { escapeControlCharacters } from "../../domain/control_characters.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type {
  ScheduleListEntry,
  WorkflowScheduleListData,
  WorkflowSchedulePauseData,
  WorkflowScheduleResumeData,
} from "../../libswamp/workflows/schedule.ts";
import type { OutputMode } from "../output/output.ts";

/** Text from another host or the store, printed without driving the terminal. */
function safe(value: string): string {
  return escapeControlCharacters(value);
}

export function renderWorkflowSchedulePause(
  mode: OutputMode,
  data: WorkflowSchedulePauseData,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  const lines = [
    `${bold(cyan("Paused schedule:"))} ${bold(safe(data.workflowName))} ${
      dim(`(${safe(data.schedule)})`)
    }`,
  ];
  if (data.reason !== undefined) {
    lines.push(`  ${cyan("Reason:")} ${safe(data.reason)}`);
  }
  lines.push(`  ${cyan("Paused by:")} ${safe(data.pausedBy)}`);
  lines.push(
    `  ${cyan("Until:")} ${
      data.until === undefined ? dim("resumed") : safe(data.until)
    }`,
  );
  if (data.replaced) {
    lines.push(dim("  Replaced the pause already in force."));
  }
  lines.push(
    dim(
      "  Scheduled fires are skipped; manual and webhook runs still run.",
    ),
  );
  writeOutput(lines.join("\n"));
}

export function renderWorkflowScheduleResume(
  mode: OutputMode,
  data: WorkflowScheduleResumeData,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  writeOutput(
    data.wasPaused
      ? `${bold(cyan("Resumed schedule:"))} ${bold(safe(data.workflowName))}`
      : `${bold(cyan("Not paused:"))} ${bold(safe(data.workflowName))} ${
        dim("(nothing to resume)")
      }`,
  );
}

export function renderWorkflowScheduleList(
  mode: OutputMode,
  data: WorkflowScheduleListData,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (data.schedules.length === 0) {
    writeOutput(dim("No scheduled workflows."));
    return;
  }
  const lines: string[] = [];
  for (const entry of data.schedules) {
    if (lines.length > 0) lines.push("");
    for (const line of scheduleLines(entry)) lines.push(line);
  }
  writeOutput(lines.join("\n"));
}

function scheduleLines(entry: ScheduleListEntry): string[] {
  const state = entry.orphaned
    ? yellow("paused (orphaned)")
    : entry.paused
    ? yellow("paused")
    : green("active");
  const lines = [
    `${bold(safe(entry.workflowName))} ${dim("-")} ${state}`,
  ];
  if (entry.schedule !== null) {
    lines.push(
      `  ${cyan("Cron:")} ${safe(entry.schedule)}${
        entry.source === "override" ? ` ${dim("(serve.yaml override)")}` : ""
      }`,
    );
  }
  if (entry.paused) {
    if (entry.reason !== undefined) {
      lines.push(`  ${cyan("Reason:")} ${safe(entry.reason)}`);
    }
    if (entry.pausedBy !== undefined) {
      lines.push(`  ${cyan("Paused by:")} ${safe(entry.pausedBy)}`);
    }
    if (entry.pausedAt !== undefined) {
      lines.push(`  ${cyan("Paused at:")} ${entry.pausedAt}`);
    }
    if (entry.until !== undefined) {
      lines.push(`  ${cyan("Until:")} ${entry.until}`);
    }
  }
  if (entry.orphaned) {
    lines.push(
      dim(
        `  Its workflow is gone or no longer scheduled. Remove it with: swamp workflow schedule resume ${
          safe(entry.workflowId)
        }`,
      ),
    );
  } else if (entry.nextRun !== null) {
    lines.push(
      `  ${cyan("Next fire:")} ${entry.nextRun}${
        entry.paused ? ` ${dim("(skipped while paused)")}` : ""
      }`,
    );
  }
  return lines;
}
