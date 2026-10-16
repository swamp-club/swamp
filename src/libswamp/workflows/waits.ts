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
import {
  receiptForCaller,
  signalByKeyCommand,
  type SignalReceipt,
} from "../../domain/workflows/signal_wait.ts";
import type {
  WorkflowRepository,
  WorkflowRunRepository,
} from "../../domain/workflows/repositories.ts";
import {
  type HeldPendingSignal,
  listHeldPendingSignals,
} from "../../domain/workflows/early_signal.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { decideContinuation } from "../../domain/workflows/run_continuation.ts";
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
  /** The key the wait holds, when its step declared one. */
  key?: string;
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
  /**
   * The command that signals the wait by its workflow and key, beside
   * {@link nextCommand}, which names it by ID (swamp-club#3214). Only on an
   * open wait whose step declared a key.
   */
  signalByKeyCommand?: string;
}

/**
 * A signal by key held for the next wait of its key, because none was open
 * when it arrived (swamp-club#3214). Named by its receipt; the payload is
 * never listed.
 */
export interface PendingSignalInfo {
  workflowId: string;
  /** The workflow the signal is for, which a reader is authorized against. */
  workflowName: string;
  key: string;
  /** The ID of the receipt the sender was given. */
  receiptId: string;
  receivedAt: string;
  /** When its age limit ends: no wait takes it after that. */
  heldUntil: string;
  submittedBy: string;
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
  /** The key the wait holds, when its step declared one. */
  key?: string;
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
  /**
   * Listed only when asked for with `includePending`, soonest `heldUntil`
   * first; empty when the datastore holds no wait records.
   */
  pending?: PendingSignalInfo[];
}

/** Options for {@link workflowWaits}. */
export interface WorkflowWaitsOptions {
  /**
   * Also list the waits a signal has settled whose run has not been resumed
   * yet, under `signalled`.
   */
  includeSignalled?: boolean;
  /**
   * Also list the signals by key held for the next wait of their key, under
   * `pending` (swamp-club#3214).
   */
  includePending?: boolean;
}

export type WorkflowWaitsEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: WorkflowWaitsData }
  | { kind: "error"; error: SwampError };

export interface WorkflowWaitsDeps {
  runRepo: Pick<WorkflowRunRepository, "findGlobalByStatus" | "findById">;
  /** Where wait records are kept, or why this datastore cannot hold them. */
  signalWaits: SignalWaitSupport;
  /**
   * Names the workflow of a pending signal its sender was not authorized
   * for by name. Without it such a signal is not listed.
   */
  workflowRepo?: Pick<WorkflowRepository, "findAll" | "findAllById">;
  /** The time deadlines are compared against. Defaults to the current time. */
  now?: () => Date;
}

export function createWorkflowWaitsDeps(
  runRepo: WorkflowWaitsDeps["runRepo"],
  signalWaits: SignalWaitSupport,
  workflowRepo?: WorkflowWaitsDeps["workflowRepo"],
): WorkflowWaitsDeps {
  return { runRepo, signalWaits, ...(workflowRepo ? { workflowRepo } : {}) };
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
 * The held pending signals, each under the workflow name it is for. A
 * signal whose sender was authorized for a name is listed under that name.
 * One sent without (through the local CLI) is listed only when exactly one
 * workflow declares its ID: IDs are not unique, and no single name could
 * authorize a reader for it otherwise. One whose name cannot be found is
 * left out.
 */
async function collectPending(
  ctx: LibSwampContext,
  deps: WorkflowWaitsDeps,
  store: SignalWaitStore,
  now: Date,
): Promise<PendingSignalInfo[]> {
  const names = new Map<string, Promise<string | undefined>>();
  const nameOf = (workflowId: string): Promise<string | undefined> => {
    let name = names.get(workflowId);
    if (!name) {
      name = uniqueWorkflowName(ctx, deps, workflowId);
      names.set(workflowId, name);
    }
    return name;
  };
  const pending: PendingSignalInfo[] = [];
  for (const held of await listHeldPendingSignals(store, now)) {
    const workflowName = held.authorizedFor ??
      await nameOf(held.workflowId);
    if (workflowName === undefined) continue;
    pending.push(pendingInfo(held, workflowName));
  }
  return pending;
}

function pendingInfo(
  held: HeldPendingSignal,
  workflowName: string,
): PendingSignalInfo {
  return {
    workflowId: held.workflowId,
    workflowName,
    key: held.key,
    receiptId: held.receiptId,
    receivedAt: held.receivedAt,
    heldUntil: held.heldUntil,
    submittedBy: held.submittedBy,
  };
}

/** The name of the one workflow that declares `workflowId`, if exactly one does. */
async function uniqueWorkflowName(
  ctx: LibSwampContext,
  deps: WorkflowWaitsDeps,
  workflowId: string,
): Promise<string | undefined> {
  const repo = deps.workflowRepo;
  if (!repo) return undefined;
  const sameId = repo.findAllById
    ? await repo.findAllById(createWorkflowId(workflowId))
    : (await repo.findAll()).filter((workflow) => workflow.id === workflowId);
  if (sameId.length > 1) {
    ctx.logger
      .debug`Not listing a pending signal of workflow ID ${workflowId}: ${sameId.length} workflows declare it, so none can be named for it.`;
  }
  return sameId.length === 1 ? sameId[0].name : undefined;
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
              awaitingResume = run !== null &&
                (await decideContinuation(run, store)).kind === "resumable";
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
              ...(registration.key !== undefined
                ? { key: registration.key }
                : {}),
              waitingSince: registration.registeredAt,
              deadline: registration.deadline,
              // The shape every reply to a sender has: only the run view
              // shows how the signal arrived (swamp-club#3214).
              signal: receiptForCaller(outcome.record.receipt),
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
          ...(registration.key !== undefined ? { key: registration.key } : {}),
          waitingSince: registration.registeredAt,
          deadline: registration.deadline,
          expired,
          schema: structuredClone(registration.schema),
          nextCommand: expired
            ? resumeCommandFor(registration.workflowName, registration.runId)
            : `swamp workflow signal ${registration.waitId} --payload '<json>'`,
          ...(!expired && registration.key !== undefined
            ? {
              signalByKeyCommand: signalByKeyCommand(
                registration.workflowName,
                registration.key,
              ),
            }
            : {}),
        });
      }
      waits.sort((a, b) => a.deadline.localeCompare(b.deadline));

      signalled.sort((a, b) =>
        a.signal.receivedAt.localeCompare(b.signal.receivedAt)
      );

      let pending: PendingSignalInfo[] = [];
      if (store && options.includePending) {
        // A failure here must not hide the waits listed above.
        try {
          pending = await collectPending(ctx, deps, store, now);
        } catch (error) {
          ctx.logger.warn`Could not list pending signals: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }

      yield {
        kind: "completed",
        data: {
          waits,
          unreadableWaits,
          ...(options.includeSignalled ? { signalled } : {}),
          ...(options.includePending ? { pending } : {}),
        },
      };
    })(),
  );
}
