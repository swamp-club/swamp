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
import type { InputsSchema } from "../../domain/definitions/definition.ts";
import type { WorkflowRunRepository } from "../../domain/workflows/repositories.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import { quoteShellWord } from "../../domain/shell_word.ts";

/** A wait for a signal held by a step of a suspended run. */
export interface SignalWaitInfo {
  waitId: string;
  workflowId: string;
  workflowName: string;
  runId: string;
  jobName: string;
  stepName: string;
  /** When the step started waiting. */
  waitingSince: string | undefined;
  /** When the wait stops accepting a signal. */
  deadline: string;
  /**
   * True when the deadline has passed. The wait no longer accepts a signal:
   * resuming the run fails its step with `wait_timeout`.
   */
  expired: boolean;
  /** The payload schema captured when the step started waiting. */
  schema: InputsSchema;
  /** The command that moves the wait on: a signal, or a resume once expired. */
  nextCommand: string;
}

/**
 * A step waiting on a wait whose stored record cannot be read. It has no id
 * to signal and no deadline: resuming the run fails the step with
 * `wait_unreadable`.
 */
export interface UnreadableWaitInfo {
  workflowId: string;
  workflowName: string;
  runId: string;
  jobName: string;
  stepName: string;
  /** The resume that fails the step, so the run can move on. */
  nextCommand: string;
}

export interface WorkflowWaitsData {
  waits: SignalWaitInfo[];
  unreadableWaits: UnreadableWaitInfo[];
}

export type WorkflowWaitsEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: WorkflowWaitsData }
  | { kind: "error"; error: SwampError };

export interface WorkflowWaitsDeps {
  runRepo: Pick<WorkflowRunRepository, "findGlobalByStatus">;
  /** The time deadlines are compared against. Defaults to the current time. */
  now?: () => Date;
}

export function createWorkflowWaitsDeps(
  runRepo: Pick<WorkflowRunRepository, "findGlobalByStatus">,
): WorkflowWaitsDeps {
  return { runRepo };
}

/**
 * Lists the waits for a signal held by suspended runs, oldest deadline
 * first. A wait past its deadline is listed too, flagged `expired`, so the
 * run that needs a resume can be found.
 */
export async function* workflowWaits(
  _ctx: LibSwampContext,
  deps: WorkflowWaitsDeps,
): AsyncIterable<WorkflowWaitsEvent> {
  yield* withGeneratorSpan(
    "swamp.workflow.waits",
    {},
    (async function* () {
      yield { kind: "resolving" };

      const now = deps.now?.() ?? new Date();
      const waits: SignalWaitInfo[] = [];
      const unreadableWaits: UnreadableWaitInfo[] = [];
      for (
        const { run } of await deps.runRepo.findGlobalByStatus("suspended")
      ) {
        if (run.status !== "suspended") continue;
        for (const ref of run.findSignalWaits()) {
          const resumeCommand = `swamp workflow resume ${
            quoteShellWord(run.workflowName)
          } --run ${run.id}`;
          // A wait that cannot be read has no id to signal.
          if (!ref.wait) {
            unreadableWaits.push({
              workflowId: run.workflowId,
              workflowName: run.workflowName,
              runId: run.id,
              jobName: ref.jobName,
              stepName: ref.stepName,
              nextCommand: resumeCommand,
            });
            continue;
          }
          const expired = ref.wait.isExpired(now);
          const step = run.getJob(ref.jobName)?.getStep(ref.stepName);
          waits.push({
            waitId: ref.wait.id,
            workflowId: run.workflowId,
            workflowName: run.workflowName,
            runId: run.id,
            jobName: ref.jobName,
            stepName: ref.stepName,
            waitingSince: step?.startedAt?.toISOString(),
            deadline: ref.wait.deadline.toISOString(),
            expired,
            schema: structuredClone(ref.wait.schema),
            nextCommand: expired
              ? resumeCommand
              : `swamp workflow signal ${ref.wait.id} --payload '<json>'`,
          });
        }
      }
      waits.sort((a, b) => a.deadline.localeCompare(b.deadline));

      yield { kind: "completed", data: { waits, unreadableWaits } };
    })(),
  );
}
