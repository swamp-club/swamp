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
import {
  registrationOf,
  type WaitRegistration,
} from "../../domain/workflows/signal_wait_records.ts";
import type {
  SignalWaitStore,
  SignalWaitSupport,
} from "../../domain/workflows/signal_wait_store.ts";
import {
  outcomeAt,
  sweepWaitRecords,
} from "../../domain/workflows/signal_wait_cleanup.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";

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
  runRepo: Pick<WorkflowRunRepository, "findGlobalByStatus" | "findById">;
  /** Where wait records are kept, or why this datastore cannot hold them. */
  signalWaits: SignalWaitSupport;
  /** The time deadlines are compared against. Defaults to the current time. */
  now?: () => Date;
}

export function createWorkflowWaitsDeps(
  runRepo: WorkflowWaitsDeps["runRepo"],
  signalWaits: SignalWaitSupport,
): WorkflowWaitsDeps {
  return { runRepo, signalWaits };
}

function resumeCommandFor(workflowName: string, runId: string): string {
  return `swamp workflow resume ${quoteShellWord(workflowName)} --run ${runId}`;
}

function unreadableAt(
  place: Pick<
    WaitRegistration,
    "workflowId" | "workflowName" | "runId" | "jobName" | "stepName"
  >,
): UnreadableWaitInfo {
  return {
    workflowId: place.workflowId,
    workflowName: place.workflowName,
    runId: place.runId,
    jobName: place.jobName,
    stepName: place.stepName,
    nextCommand: resumeCommandFor(place.workflowName, place.runId),
  };
}

/**
 * The waits to list, by id: every registration, plus one made here for each
 * wait a suspended run holds without one, which is a run suspended before
 * waits were registered (swamp-club#3068). A waiting step whose stored wait
 * cannot be read has no id and goes to `unreadableWaits`.
 */
async function collectRegistrations(
  deps: WorkflowWaitsDeps,
  store: SignalWaitStore | undefined,
  now: Date,
  unreadableWaits: UnreadableWaitInfo[],
): Promise<Map<string, WaitRegistration>> {
  const registrations = new Map<string, WaitRegistration>();
  for (const registration of await store?.listRegistrations() ?? []) {
    registrations.set(registration.waitId, registration);
  }
  for (
    const { run } of await deps.runRepo.findGlobalByStatus("suspended")
  ) {
    if (run.status !== "suspended") continue;
    for (const ref of run.findSignalWaits()) {
      const place = {
        workflowId: run.workflowId,
        workflowName: run.workflowName,
        runId: run.id,
        jobName: ref.jobName,
        stepName: ref.stepName,
      };
      // A wait that cannot be read has no id to signal. A registration
      // made for it before the record was damaged is not listed as open.
      if (!ref.wait) {
        unreadableWaits.push(unreadableAt(place));
        for (const [waitId, registration] of registrations) {
          if (
            registration.runId === place.runId &&
            registration.jobName === place.jobName &&
            registration.stepName === place.stepName
          ) registrations.delete(waitId);
        }
        continue;
      }
      if (registrations.has(ref.wait.id)) continue;
      const step = run.getJob(ref.jobName)?.getStep(ref.stepName);
      const registration = registrationOf(
        place,
        ref.wait,
        step?.startedAt ?? now,
      );
      await store?.register(registration);
      registrations.set(registration.waitId, registration);
    }
  }
  return registrations;
}

/**
 * Lists the waits for a signal that nothing has answered, oldest deadline
 * first. A wait past its deadline is settled as timed out and listed too,
 * flagged `expired`, so the run that needs a resume can be found. A wait a
 * signal settled, or whose run ended, is not listed.
 *
 * Records nothing else removed are swept on the way (see
 * {@link sweepWaitRecords}).
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
      // Without a store only the waits run records hold can be listed, and
      // a deadline is read from the record.
      const store = deps.signalWaits.supported
        ? deps.signalWaits.store
        : undefined;
      if (store) {
        await sweepWaitRecords(
          store,
          (workflowId, runId) =>
            deps.runRepo.findById(
              createWorkflowId(workflowId),
              createWorkflowRunId(runId),
            ),
          now,
        );
      }

      const waits: SignalWaitInfo[] = [];
      const unreadableWaits: UnreadableWaitInfo[] = [];
      const registrations = await collectRegistrations(
        deps,
        store,
        now,
        unreadableWaits,
      );
      for (const registration of registrations.values()) {
        const outcome = store
          ? await outcomeAt(store, registration, now)
          : { kind: "absent" as const };
        // An outcome that cannot be read never settles the step another
        // way: the resume fails it.
        if (outcome.kind === "unreadable") {
          unreadableWaits.push(unreadableAt(registration));
          continue;
        }
        if (outcome.kind === "found" && outcome.record.kind !== "timed_out") {
          continue;
        }
        const expired = outcome.kind === "found" ||
          now.getTime() > new Date(registration.deadline).getTime();
        waits.push({
          waitId: registration.waitId,
          workflowId: registration.workflowId,
          workflowName: registration.workflowName,
          runId: registration.runId,
          jobName: registration.jobName,
          stepName: registration.stepName,
          waitingSince: registration.registeredAt,
          deadline: registration.deadline,
          expired,
          schema: structuredClone(registration.schema),
          nextCommand: expired
            ? resumeCommandFor(registration.workflowName, registration.runId)
            : `swamp workflow signal ${registration.waitId} --payload '<json>'`,
        });
      }
      waits.sort((a, b) => a.deadline.localeCompare(b.deadline));

      yield { kind: "completed", data: { waits, unreadableWaits } };
    })(),
  );
}
