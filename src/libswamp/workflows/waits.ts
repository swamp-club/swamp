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
import type { SignalReceipt } from "../../domain/workflows/signal_wait.ts";
import type { WorkflowRunRepository } from "../../domain/workflows/repositories.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
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
  ensureRegistered,
  isAwaitingResume,
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

/**
 * A wait a signal has settled whose run is still suspended: the step shows
 * as waiting until a resume applies the signal.
 */
export interface SignalledWaitInfo {
  waitId: string;
  workflowId: string;
  workflowName: string;
  runId: string;
  jobName: string;
  stepName: string;
  /** When the step started waiting. */
  waitingSince: string | undefined;
  deadline: string;
  /** The receipt of the signal that settled the wait. */
  signal: SignalReceipt;
  /**
   * True when nothing else holds the run back, so a resume moves it on.
   * False when this host has no copy of the run.
   */
  awaitingResume: boolean;
  /** The resume that applies the signal. */
  nextCommand: string;
}

export interface WorkflowWaitsData {
  waits: SignalWaitInfo[];
  unreadableWaits: UnreadableWaitInfo[];
  /** Listed only when asked for with `includeSignalled`. */
  signalled?: SignalledWaitInfo[];
}

/** Options for {@link workflowWaits}. */
export interface WorkflowWaitsOptions {
  /**
   * Also list the waits a signal has settled whose run has not been resumed
   * yet, under `signalled`.
   */
  includeSignalled?: boolean;
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
      // Also replaces a stored registration that cannot be read, which is
      // why it was not listed: the run record still holds the whole wait.
      registrations.set(
        registration.waitId,
        store ? await ensureRegistered(store, registration) : registration,
      );
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
  ctx: LibSwampContext,
  deps: WorkflowWaitsDeps,
  options: WorkflowWaitsOptions = {},
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
        // Housekeeping: a failure here must not hide the waits.
        try {
          await sweepWaitRecords(
            store,
            (workflowId, runId) =>
              deps.runRepo.findById(
                createWorkflowId(workflowId),
                createWorkflowRunId(runId),
              ),
            now,
            {
              localRunAbsenceIsAuthoritative: deps.signalWaits.supported &&
                deps.signalWaits.localRunAbsenceIsAuthoritative,
            },
          );
        } catch (error) {
          ctx.logger.warn`Could not sweep signal wait records: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }

      const waits: SignalWaitInfo[] = [];
      const signalled: SignalledWaitInfo[] = [];
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
          if (
            store && options.includeSignalled &&
            outcome.record.kind === "accepted"
          ) {
            // A run record or a sibling wait that cannot be read must not
            // hide the other waits: the wait is listed as signalled, and
            // not as ready to resume.
            let run: WorkflowRun | null = null;
            let awaitingResume = false;
            try {
              run = await deps.runRepo.findById(
                createWorkflowId(registration.workflowId),
                createWorkflowRunId(registration.runId),
              );
              awaitingResume = await isAwaitingResume(store, run);
            } catch (error) {
              ctx.logger
                .warn`Could not tell whether run ${registration.runId} can resume: ${
                error instanceof Error ? error.message : String(error)
              }`;
            }
            // A run that has moved on no longer waits; its records go with
            // the next sweep. Nor does a step a resume already gave the
            // signal to: its registration stays until the run ends, so a
            // run suspended again on a later wait still holds it.
            if (run && run.status !== "suspended") continue;
            if (
              run &&
              !run.findSignalWaits().some((ref) =>
                ref.wait?.id === registration.waitId
              )
            ) continue;
            signalled.push({
              waitId: registration.waitId,
              workflowId: registration.workflowId,
              workflowName: registration.workflowName,
              runId: registration.runId,
              jobName: registration.jobName,
              stepName: registration.stepName,
              waitingSince: registration.registeredAt,
              deadline: registration.deadline,
              signal: { ...outcome.record.receipt },
              awaitingResume,
              nextCommand: resumeCommandFor(
                registration.workflowName,
                registration.runId,
              ),
            });
          }
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

      signalled.sort((a, b) =>
        a.signal.receivedAt.localeCompare(b.signal.receivedAt)
      );

      yield {
        kind: "completed",
        data: {
          waits,
          unreadableWaits,
          ...(options.includeSignalled ? { signalled } : {}),
        },
      };
    })(),
  );
}
