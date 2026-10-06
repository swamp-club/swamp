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
import type {
  StepRun,
  WorkflowRun,
} from "../../domain/workflows/workflow_run.ts";
import type { WorkflowRunRepository } from "../../domain/workflows/repositories.ts";
import type { SignalReceipt } from "../../domain/workflows/signal_wait.ts";
import {
  decideSignal,
  normalizeWaitId,
  registrationOf,
  type StoredWaitRecord,
  type WaitOutcome,
  type WaitRegistration,
} from "../../domain/workflows/signal_wait_records.ts";
import {
  settledBy,
  type SignalWaitStore,
  type SignalWaitSupport,
} from "../../domain/workflows/signal_wait_store.ts";
import {
  ensureRegistered,
  outcomeAt,
} from "../../domain/workflows/signal_wait_cleanup.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";
import { quoteShellWord } from "../../domain/shell_word.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notFound, validationFailed } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

export interface WorkflowSignalData {
  waitId: string;
  workflowId: string;
  workflowName: string;
  runId: string;
  jobName: string;
  stepName: string;
  /** What swamp recorded about the signal. */
  signal: SignalReceipt;
  /**
   * True when this signal settled the run's last wait and no gate or nested
   * run is still waited on, so the run can be resumed. Read from the run
   * record as this host has it, which on a shared datastore may be behind.
   */
  awaitingResume: boolean;
  /** The command that resumes the run. */
  resumeCommand: string;
}

export type WorkflowSignalEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: WorkflowSignalData }
  | { kind: "error"; error: SwampError };

export interface WorkflowSignalInput {
  /** The wait the signal is for. A signal names the wait and nothing else. */
  waitId: string;
  /** The message. Untrusted: it is validated before anything is stored. */
  payload: unknown;
  /** Who sent it. Defaults to the OS user, as a local approval's decider. */
  submittedBy?: string;
}

export interface WorkflowSignalDeps {
  /**
   * Read only. A signal never writes a run record: it is delivered by
   * creating the wait's outcome, and a resume applies it.
   */
  runRepo: Pick<
    WorkflowRunRepository,
    "findById" | "findGlobalByStatus" | "findAllGlobal"
  >;
  /** Where wait records are kept, or why this datastore cannot hold them. */
  signalWaits: SignalWaitSupport;
  /** The time the deadline is compared against. Defaults to the current time. */
  now?: () => Date;
}

export function createWorkflowSignalDeps(
  runRepo: WorkflowSignalDeps["runRepo"],
  signalWaits: SignalWaitSupport,
): WorkflowSignalDeps {
  return { runRepo, signalWaits };
}

/** The step of `run` that holds the wait, in any status. */
function findStepByWaitId(
  run: WorkflowRun,
  waitId: string,
): { jobName: string; step: StepRun } | undefined {
  for (const job of run.jobs) {
    for (const step of job.steps) {
      if (step.signalWait?.id.toLowerCase() === waitId) {
        return { jobName: job.jobName, step };
      }
    }
  }
  return undefined;
}

/**
 * Finds the run whose record holds a wait that has no registration: one
 * suspended before waits were registered (swamp-club#3068), or one whose
 * records were removed when it ended. Suspended runs are searched first, as
 * an open wait lives in one; every run is searched only when none holds it,
 * to tell a wait that settled from an id nothing ever issued.
 */
async function locateInRunRecords(
  deps: WorkflowSignalDeps,
  waitId: string,
): Promise<{ run: WorkflowRun; jobName: string; step: StepRun } | undefined> {
  for (
    const { run } of await deps.runRepo.findGlobalByStatus("suspended")
  ) {
    const found = findStepByWaitId(run, waitId);
    if (found) return { run, ...found };
  }
  for (const { run } of await deps.runRepo.findAllGlobal()) {
    const found = findStepByWaitId(run, waitId);
    if (found) return { run, ...found };
  }
  return undefined;
}

/** The fields of a registration a message or a result names. */
type WaitPlace = Pick<
  WaitRegistration,
  "workflowId" | "workflowName" | "runId" | "jobName" | "stepName"
>;

function resumeCommandFor(place: WaitPlace): string {
  return `swamp workflow resume ${
    quoteShellWord(place.workflowName)
  } --run ${place.runId}`;
}

function whereOf(place: WaitPlace): string {
  return `step "${place.stepName}" of workflow "${place.workflowName}" (run ${place.runId})`;
}

function unknownWait(typedId: string): SwampError {
  return notFound("Signal wait", typedId);
}

// Messages name the id as it was typed, so telemetry, which redacts the
// typed argument, removes it from them.

function alreadySettled(
  typedId: string,
  where: string,
  receipt: SignalReceipt,
): SwampError {
  // Who sent it and when stay in the details: the message reaches
  // telemetry, and a username does not belong there.
  return validationFailed(
    `Wait ${typedId} is already settled: ${where} received signal ${receipt.id}.`,
    { receipt },
  );
}

function unreadableRecord(typedId: string): SwampError {
  return validationFailed(
    `The stored record of wait ${typedId} cannot be read, so no signal can be delivered to it.`,
  );
}

/**
 * The refusal a wait that already has an outcome answers a signal with.
 * `closed` is set for a wait whose registration is gone: its run ended or
 * its step was reset, so no resume of it is left to suggest.
 */
function refusalFor(
  typedId: string,
  place: WaitPlace,
  outcome: WaitOutcome,
  closed = false,
): SwampError {
  const where = whereOf(place);
  switch (outcome.kind) {
    case "accepted":
      return alreadySettled(typedId, where, outcome.receipt);
    case "timed_out":
      return validationFailed(
        `Wait ${typedId} expired at ${outcome.deadline}: ${where} no longer accepts a signal.` +
          (closed
            ? ""
            : ` Resume the run to fail the step with wait_timeout: ${
              resumeCommandFor(place)
            }`),
      );
    case "cancelled":
      return validationFailed(
        `Wait ${typedId} was closed before a signal arrived: the run of ${where} ended, or the step moved on to a new wait. ` +
          `Run "swamp workflow waits" for the waits still open.`,
      );
  }
}

/** The run a wait belongs to, as this host has it. */
async function runOf(
  deps: WorkflowSignalDeps,
  place: WaitPlace,
): Promise<WorkflowRun | null> {
  return await deps.runRepo.findById(
    createWorkflowId(place.workflowId),
    createWorkflowRunId(place.runId),
  );
}

/**
 * True when the run record here shows the wait's step waiting on a wait
 * that cannot be read, as after a hand edit. A resume fails such a step, so
 * a signal for it would be accepted and never applied.
 */
function stepHoldsUnreadableWait(
  run: WorkflowRun | null,
  place: WaitPlace,
): boolean {
  const step = run?.getJob(place.jobName)?.getStep(place.stepName);
  return step !== undefined && step.isSignalWait &&
    step.signalWait === undefined;
}

/**
 * The step of the run record here that held this wait and no longer waits
 * on it, or undefined when the record is not here or the step still waits.
 */
function stepLeftWait(
  run: WorkflowRun | null,
  registration: WaitRegistration,
): StepRun | undefined {
  const step = run?.getJob(registration.jobName)?.getStep(
    registration.stepName,
  );
  if (!step || step.signalWait?.id !== registration.waitId) return undefined;
  return step.isSignalWait ? undefined : step;
}

/**
 * Whether the run can be resumed now that this wait is settled: suspended,
 * with no gate undecided, no nested run waited on, and an outcome for every
 * other wait. Read from the run record as this host has it; false when the
 * record is not here.
 */
async function isAwaitingResume(
  store: SignalWaitStore,
  run: WorkflowRun | null,
): Promise<boolean> {
  if (!run || run.status !== "suspended") return false;
  if (run.findWaitingApprovalStep() || run.findNestedWaits().length > 0) {
    return false;
  }
  for (const ref of run.findSignalWaits()) {
    if (!ref.wait) continue;
    if ((await store.findOutcome(ref.wait.id)).kind === "absent") return false;
  }
  return true;
}

/**
 * The registration of a wait, or the answer for a wait that has none: its
 * stored outcome, what the run record says of it, or that nothing ever
 * issued the id. A wait a run suspended on before waits were registered is
 * registered here from its run record, and then takes a signal like any
 * other.
 */
async function resolveRegistration(
  deps: WorkflowSignalDeps,
  store: SignalWaitStore,
  typedId: string,
  waitId: string,
): Promise<{ registration: WaitRegistration } | { error: SwampError }> {
  const stored = await store.findRegistration(waitId);
  if (stored.kind === "found") return { registration: stored.record };

  // No registration, or one that cannot be read: the run record still
  // holds the whole wait, so it is asked, and the registration rebuilt.
  const held = await locateInRunRecords(deps, waitId);
  const outcome = await store.findOutcome(waitId);
  if (!held) {
    // A settled wait of a run this host does not have: answered from the
    // outcome alone, which names the run but not the step.
    if (outcome.kind === "found" && outcome.record.kind === "accepted") {
      return {
        error: alreadySettled(
          typedId,
          `run ${outcome.record.runId}`,
          outcome.record.receipt,
        ),
      };
    }
    if (outcome.kind === "found" && outcome.record.kind === "timed_out") {
      return {
        error: validationFailed(
          `Wait ${typedId} expired at ${outcome.record.deadline} and no longer accepts a signal.`,
        ),
      };
    }
    return {
      error: stored.kind === "unreadable"
        ? unreadableRecord(typedId)
        : outcome.kind === "absent"
        ? unknownWait(typedId)
        : outcome.kind === "unreadable"
        ? unreadableRecord(typedId)
        : validationFailed(
          `Wait ${typedId} was closed before a signal arrived: its run ended, or its step moved on to a new wait. ` +
            `Run "swamp workflow waits" for the waits still open.`,
        ),
    };
  }

  const { run, jobName, step } = held;
  const place: WaitPlace = {
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    runId: run.id,
    jobName,
    stepName: step.stepName,
  };
  if (outcome.kind === "found") {
    return { error: refusalFor(typedId, place, outcome.record, true) };
  }
  if (outcome.kind === "unreadable") {
    return { error: unreadableRecord(typedId) };
  }
  const receipt = step.signalWait?.receipt;
  if (receipt) {
    return { error: alreadySettled(typedId, whereOf(place), receipt) };
  }
  if (!step.isSignalWait || !step.signalWait) {
    return {
      error: validationFailed(
        `Wait ${typedId} is closed: ${whereOf(place)} is ${step.status}` +
          (step.error ? ` (${step.error})` : "") + ".",
      ),
    };
  }
  return {
    registration: await ensureRegistered(
      store,
      registrationOf(
        place,
        step.signalWait,
        step.startedAt ?? deps.now?.() ?? new Date(),
      ),
    ),
  };
}

async function deliver(
  deps: WorkflowSignalDeps,
  store: SignalWaitStore,
  input: WorkflowSignalInput,
  waitId: string,
): Promise<{ error: SwampError } | { data: WorkflowSignalData }> {
  const typedId = input.waitId;
  const resolved = await resolveRegistration(deps, store, typedId, waitId);
  if ("error" in resolved) return resolved;
  const { registration } = resolved;
  const now = deps.now?.() ?? new Date();
  const run = await runOf(deps, registration);
  // A step never returns to a wait it left. So when the run record here
  // shows the step past this wait, with no outcome stored, something that
  // writes run records directly settled it (a build from before outcome
  // records, which also cancels without closing the wait). The signal is
  // answered from the record instead of being accepted and never applied.
  const left = stepLeftWait(run, registration);
  if (
    left && (await store.findOutcome(registration.waitId)).kind === "absent"
  ) {
    const receipt = left.signalWait?.receipt;
    return {
      error: receipt
        ? alreadySettled(typedId, whereOf(registration), receipt)
        : validationFailed(
          `Wait ${typedId} is closed: ${
            whereOf(registration)
          } is ${left.status}` +
            (left.error ? ` (${left.error})` : "") + ".",
        ),
    };
  }
  if (stepHoldsUnreadableWait(run, registration)) {
    return {
      error: validationFailed(
        `Wait ${typedId} cannot take a signal: the wait stored on ${
          whereOf(registration)
        } cannot be read. Resume the run to fail the step: ${
          resumeCommandFor(registration)
        }`,
      ),
    };
  }

  // Settles the wait as timed out first when its deadline has passed: the
  // create decides between that and a signal arriving at the same moment.
  let stored: StoredWaitRecord<WaitOutcome> = await outcomeAt(
    store,
    registration,
    now,
  );
  let delivered: WaitOutcome | undefined;
  if (stored.kind === "absent") {
    // `||`, not `??`: a receipt needs a sender, and USER can be set but empty.
    const submittedBy = input.submittedBy || Deno.env.get("USER") ||
      Deno.env.get("USERNAME") || "unknown";
    const decision = decideSignal(
      registration,
      input.payload,
      submittedBy,
      now,
    );
    if (!decision.accepted) {
      const refusal = decision.refusal;
      if (refusal.kind === "invalid_payload") {
        return {
          error: validationFailed(
            `Payload refused for wait ${typedId}; the wait stays open:\n` +
              refusal.errors.map((error) => `  - ${error}`).join("\n"),
            { errors: refusal.errors },
          ),
        };
      }
      return {
        error: refusalFor(typedId, registration, {
          kind: "timed_out",
          waitId: registration.waitId,
          workflowId: registration.workflowId,
          runId: registration.runId,
          deadline: registration.deadline,
          settledAt: now.toISOString(),
        }),
      };
    }
    delivered = decision.outcome;
    stored = await store.settle(decision.outcome);
  }

  if (stored.kind !== "found") return { error: unreadableRecord(typedId) };
  // Another signal, a timeout or a cancel settled the wait first: the
  // caller is answered from what is stored.
  if (
    !delivered || stored.record.kind !== "accepted" ||
    !settledBy(stored, delivered)
  ) {
    return { error: refusalFor(typedId, registration, stored.record) };
  }

  return {
    data: {
      waitId: registration.waitId,
      workflowId: registration.workflowId,
      workflowName: registration.workflowName,
      runId: registration.runId,
      jobName: registration.jobName,
      stepName: registration.stepName,
      signal: { ...stored.record.receipt },
      awaitingResume: await isAwaitingResume(store, run),
      resumeCommand: resumeCommandFor(registration),
    },
  };
}

/**
 * Delivers a JSON message to the wait it names by creating the wait's
 * outcome record. The run record is not read for the decision and never
 * written: the step succeeds with the message as its output when the run
 * is next resumed, which is the only writer of a suspended run
 * (swamp-club#3093). So a signal is safe while the process that started the
 * run still saves it, and from any host on the datastore.
 */
export async function* workflowSignal(
  _ctx: LibSwampContext,
  deps: WorkflowSignalDeps,
  input: WorkflowSignalInput,
): AsyncIterable<WorkflowSignalEvent> {
  yield* withGeneratorSpan(
    "swamp.workflow.signal",
    { "wait.id": input.waitId },
    (async function* () {
      yield { kind: "resolving" };

      const waitId = normalizeWaitId(input.waitId);
      if (!waitId) {
        yield { kind: "error", error: unknownWait(input.waitId) };
        return;
      }
      if (!deps.signalWaits.supported) {
        yield {
          kind: "error",
          error: validationFailed(
            `This datastore cannot support a wait for a signal: ${deps.signalWaits.reason}.`,
          ),
        };
        return;
      }

      const outcome = await deliver(
        deps,
        deps.signalWaits.store,
        input,
        waitId,
      );
      if ("error" in outcome) {
        yield { kind: "error", error: outcome.error };
        return;
      }
      yield { kind: "completed", data: outcome.data };
    })(),
  );
}
