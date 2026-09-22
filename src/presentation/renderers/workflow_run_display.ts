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

import { green, red, yellow } from "@std/fmt/colors";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type {
  StepSkipReasonView,
  WorkflowRunView,
} from "../../libswamp/mod.ts";

export function renderWorkflowRunDisplay(
  data: WorkflowRunView,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderLogWorkflowRun(data);
  }
}

function formatTimestamp(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function renderLogWorkflowRun(data: WorkflowRunView): void {
  writeOutput(`Workflow: ${data.workflowName} (Run ID: ${data.id})`);
  if (data.startedAt) {
    writeOutput(`Started:  ${formatTimestamp(data.startedAt)}`);
  }
  if (data.completedAt) {
    writeOutput(`Ended:    ${formatTimestamp(data.completedAt)}`);
  }

  for (const job of data.jobs) {
    const durationSuffix = job.duration !== undefined
      ? ` (${job.duration}ms)`
      : "";
    writeOutput(`  ${statusIcon(job.status)} ${job.name}${durationSuffix}`);

    for (const step of job.steps) {
      const stepDuration = step.duration !== undefined
        ? ` (${step.duration}ms)`
        : "";
      const stepIcon = step.status === "failed" && step.allowedFailure
        ? "\u26A0"
        : statusIcon(step.status);
      writeOutput(`    ${stepIcon} ${step.name}${stepDuration}`);

      if (step.error) {
        writeOutput(`      -> ${red(step.error)}`);
      }

      if (step.status === "skipped" && step.skipReason) {
        // Word for word what the verification report says for the same
        // fact, so a reader comparing the two surfaces never has to work out
        // whether they mean the same thing.
        //
        // A switch rather than a chain of ternaries: the chain ended in an
        // else that swallowed anything unrecognised, so a fourth `kind`
        // would have been silently labelled "job was skipped". Here the
        // string return type makes a missing case a compile error.
        const detail = ((r: StepSkipReasonView): string => {
          switch (r.kind) {
            case "guarded":
              return r.expression ? `guard: ${r.expression}` : "guard";
            case "dependency":
              return "dependency condition not met";
            case "job_skipped":
              return "job was skipped";
          }
        })(step.skipReason);
        writeOutput(`      -> skipped (${detail})`);
      }

      if (step.approval) {
        const a = step.approval;
        if (a.status === "approved") {
          writeOutput(
            `      ${green("Approved")} by ${a.approvedBy ?? "unknown"} at ${
              formatTimestamp(a.approvedAt)
            }`,
          );
        } else if (a.status === "rejected") {
          writeOutput(
            `      ${red("Rejected")} by ${a.rejectedBy ?? "unknown"} at ${
              formatTimestamp(a.rejectedAt)
            }`,
          );
          if (a.reason) {
            writeOutput(`      Reason: ${a.reason}`);
          }
        } else if (a.status === "timed_out") {
          const timeoutSuffix = a.timeoutAt
            ? ` at ${formatTimestamp(a.timeoutAt)}`
            : "";
          writeOutput(`      ${yellow("Timed out")}${timeoutSuffix}`);
        }
      }
    }
  }

  const durationSuffix = data.duration !== undefined
    ? ` (${data.duration}ms)`
    : "";
  const resultText = `Result: ${data.status.toUpperCase()}${durationSuffix}`;
  const colorize = data.status === "failed" || data.status === "interrupted"
    ? red
    : data.status === "cancelled"
    ? yellow
    : green;
  writeOutput(colorize(resultText));

  if (data.path) {
    writeOutput(`Saved to: ${data.path}`);
  }
}

function statusIcon(
  status:
    | "pending"
    | "running"
    | "waiting_approval"
    | "succeeded"
    | "failed"
    | "skipped"
    | "cancelled"
    | "unknown"
    | "interrupted",
): string {
  const icons: Record<string, string> = {
    pending: "\u25CB",
    running: "\u25D0",
    waiting_approval: "\u23F8",
    succeeded: "\u2713",
    failed: "\u2717",
    skipped: "\u2298",
    cancelled: "\u2716",
    unknown: "?",
    interrupted: "\u26A0",
  };
  return icons[status] ?? "?";
}
