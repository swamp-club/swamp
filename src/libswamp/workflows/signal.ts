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
import type {
  WorkflowRepository,
  WorkflowRunRepository,
} from "../../domain/workflows/repositories.ts";
import type { Workflow } from "../../domain/workflows/workflow.ts";
import {
  IDEMPOTENCY_KEY_FORM,
  isIdempotencyKey,
  isWaitKey,
  receiptForCaller,
  type SignalReceipt,
} from "../../domain/workflows/signal_wait.ts";
import {
  decideSignal,
  normalizeWaitId,
  registrationOf,
  type StoredWaitRecord,
  type WaitOutcome,
  type WaitRegistration,
} from "../../domain/workflows/signal_wait_records.ts";
import { decideContinuation } from "../../domain/workflows/run_continuation.ts";
import {
  settledBy,
  type SignalWaitStore,
  type SignalWaitSupport,
} from "../../domain/workflows/signal_wait_store.ts";
import { findWorkflowByIdOrName } from "../../domain/workflows/workflow_lookup.ts";
import {
  declaredWaitKeyStep,
  findKeyHolder,
  findSettledKeyHolder,
  type WaitKeyClaim,
} from "../../domain/workflows/wait_key_claim.ts";
import {
  ensureRegistered,
  outcomeAt,
  removeSupersededPendingSignal,
} from "../../domain/workflows/signal_wait_cleanup.ts";
import {
  type DeclaredEarlyWait,
  declaredEarlyWait,
  findSignalByIdempotencyKey,
  holdEarlySignal,
  validateEarlyPayload,
} from "../../domain/workflows/early_signal.ts";
import {
  heldUntil,
  isReceivedForWait,
  type PendingSignal,
} from "../../domain/workflows/pending_signal.ts";
import { earlySlots } from "../../domain/workflows/signal_wait.ts";
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
  key?: string;
  workflowId: string;
  workflowName: string;
  runId: string;
  jobName: string;
  stepName: string;
  signal: SignalReceipt;
  /**
   * True when this signal settled the run's last wait and no gate or nested
   * run is still waited on, so the run can be resumed. Read from the run
   * record as this host has it, which on a shared datastore may be behind.
   */
  awaitingResume: boolean;
  /**
   * False when this host has no copy of the run record, as on a second host
   * that has not synced it. `awaitingResume` is then unknown, and reported
   * as false.
   */
  runRecordAvailable: boolean;
  resumeCommand: string;
  /**
   * true when a wait took the signal from where it was held. A step that took
   * it as it opened its wait succeeded inside its run and no resume applies it;
   * for a wait open already, `awaitingResume` says whether its run can be
   * resumed.
   */
  taken?: true;
  /**
   * True when the signal carried an idempotency key a signal already
   * received carries: `signal` is that one's receipt, and this one was
   * neither delivered nor held.
   */
  duplicate?: true;
}

export interface PendingSignalReceipt {
  id: string;
  receivedAt: string;
  submittedBy: string;
  idempotencyKey?: string;
}

/**
 * a signal by key that arrived before its wait opened and is held as the key's
 * pending signal. No wait or run took it yet, so none is named; the step takes
 * it only if it opens its wait by `heldUntil`.
 */
export interface WorkflowSignalPendingData {
  pending: true;
  key: string;
  workflowId: string;
  workflowName: string;
  signal: PendingSignalReceipt;
  heldUntil: string;
  /**
   * the wait that last held the key, as on a no_open_wait refusal. A step with
   * acceptEarly never refuses a retry by key, so this is how a sender retrying
   * after a lost reply learns its first signal landed.
   */
  lastWait?: SignalLastWait;
  duplicate?: true;
}

export type WorkflowSignalEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: WorkflowSignalData }
  | { kind: "pending"; data: WorkflowSignalPendingData }
  | { kind: "error"; error: SwampError };

/**
 * how a signal names its wait: by the wait's id, or by a workflow and a key one
 * of its wait_for_signal steps declares; a key is resolved to the id of the
 * wait that holds it before anything is decided
 */
export type WorkflowSignalAddress =
  | { waitId: string }
  | {
    workflow: string;
    key: string;
  };

export type WorkflowSignalInput = WorkflowSignalAddress & {
  /** The message. Untrusted: it is validated before anything is stored. */
  payload: unknown;
  submittedBy?: string;
  /**
   * asked before anything is stored or any answer names the workflow, run, step
   * or an earlier signal; a refusal or unplaceable wait gets the answer an
   * unknown wait id gets; the local command passes none
   */
  authorize?: (wait: SignalWaitSubject) => Promise<boolean>;
  waitsCommand?: string;
  /**
   * false when the caller cannot be told a signal is held: a signal by key that
   * finds no open wait is then refused no_open_wait and nothing is stored,
   * whatever the step declares. Defaults to true.
   */
  holdEarly?: boolean;
  /**
   * a signal whose key matches one already received from the same sender for
   * the wait or its key is answered with that receipt, marked `duplicate`, and
   * is neither delivered nor held again
   */
  idempotencyKey?: string;
};

const LOCAL_WAITS_COMMAND = "swamp workflow waits";

function waitsCommandOf(input: Pick<WorkflowSignalInput, "waitsCommand">) {
  return input.waitsCommand ?? LOCAL_WAITS_COMMAND;
}

export interface SignalWaitSubject {
  waitId: string;
  workflowId: string;
  /**
   * Absent when only the wait's outcome is left, which does not name it, and
   * this host has no record of the run to take the name from.
   */
  workflowName?: string;
  runId: string;
  /**
   * the workflow recorded on the run, when this host has the record; the ids
   * always agree, the names differ when the registration's name was altered
   */
  runWorkflow?: { workflowId: string; workflowName: string };
}

/**
 * the wait that last held a key, in a no_open_wait error's details, for a
 * retrying sender to tell "my signal landed" from "the run has not reached its
 * wait"; only for a caller who may signal the wait
 */
export interface SignalLastWait {
  waitId: string;
  settledAs: "accepted" | "timed_out" | "cancelled";
  settledAt: string;
  receipt?: SignalReceipt;
}

export function signalLastWait(error: SwampError): SignalLastWait | undefined {
  const details = error.details;
  if (typeof details !== "object" || details === null) return undefined;
  return (details as { lastWait?: SignalLastWait }).lastWait;
}

export type SignalRefusalKind =
  | "unknown"
  | "no_open_wait"
  | "expired"
  | "invalid_payload"
  | "already_settled"
  | "already_pending"
  | "closed"
  | "unreadable"
  | "unsupported";

const SIGNAL_REFUSAL_KINDS: ReadonlySet<string> = new Set<SignalRefusalKind>([
  "unknown",
  "no_open_wait",
  "expired",
  "invalid_payload",
  "already_settled",
  "already_pending",
  "closed",
  "unreadable",
  "unsupported",
]);

export function signalRefusalKind(
  error: SwampError,
): SignalRefusalKind | undefined {
  const details = error.details;
  if (typeof details !== "object" || details === null) return undefined;
  const refusal = (details as { refusal?: unknown }).refusal;
  return typeof refusal === "string" && SIGNAL_REFUSAL_KINDS.has(refusal)
    ? refusal as SignalRefusalKind
    : undefined;
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
  findWorkflow: (idOrName: string) => Promise<Workflow | null>;
  signalWaits: SignalWaitSupport;
  now?: () => Date;
  /**
   * a caller answering outside requests turns it off so one request cannot make
   * it read every run; such a wait is then answered as unknown until `workflow
   * waits` registers it. Defaults to true.
   */
  scanRunRecords?: boolean;
}

export function createWorkflowSignalDeps(
  runRepo: WorkflowSignalDeps["runRepo"],
  signalWaits: SignalWaitSupport,
  workflowRepo: Pick<WorkflowRepository, "findByName" | "findById">,
): WorkflowSignalDeps {
  return {
    runRepo,
    signalWaits,
    findWorkflow: (idOrName) => findWorkflowByIdOrName(workflowRepo, idOrName),
  };
}

function senderOf(input: Pick<WorkflowSignalInput, "submittedBy">): string {
  // `||`, not `??`: a receipt needs a sender, and USER can be set but empty.
  return input.submittedBy || Deno.env.get("USER") ||
    Deno.env.get("USERNAME") || "unknown";
}

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
 * finds the run whose record holds a wait with no registration; suspended runs
 * are searched first, every run only when none holds it, to tell a settled wait
 * from an id nothing issued
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

type WaitPlace = Pick<
  WaitRegistration,
  "workflowId" | "workflowName" | "runId" | "jobName" | "stepName"
>;

function resumeCommandFor(place: WaitPlace): string {
  return `swamp workflow resume ${
    quoteShellWord(place.workflowName)
  } --run ${place.runId}`;
}

/**
 * A name read from a wait record, for a message. The record comes from a
 * store other writers can reach, so control characters, which could carry
 * terminal escape sequences, are not printed.
 */
function printable(name: string): string {
  // deno-lint-ignore no-control-regex
  return name.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

function whereOf(place: WaitPlace): string {
  return `step "${printable(place.stepName)}" of workflow "${
    printable(place.workflowName)
  }" (run ${printable(place.runId)})`;
}

function refused(
  kind: SignalRefusalKind,
  message: string,
  details: Record<string, unknown> = {},
): SwampError {
  return validationFailed(message, { ...details, refusal: kind });
}

function unknownWait(typedId: string): SwampError {
  const error = notFound("Signal wait", typedId);
  return {
    ...error,
    details: { ...(error.details as object), refusal: "unknown" },
  };
}

function expiredAt(typedId: string, deadline: string): SwampError {
  return refused(
    "expired",
    `Wait ${typedId} expired at ${deadline} and no longer accepts a signal.`,
  );
}

function closedBeforeSignal(typedId: string, waitsCommand: string): SwampError {
  return refused(
    "closed",
    `Wait ${typedId} was closed before a signal arrived: its run ended, or its step moved on to a new wait. ` +
      `Run "${waitsCommand}" for the waits still open.`,
  );
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
  return refused(
    "already_settled",
    `Wait ${typedId} is already settled: ${where} received signal ${receipt.id}.`,
    { receipt: receiptForCaller(receipt) },
  );
}

function unreadableRecord(typedId: string): SwampError {
  return refused(
    "unreadable",
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
  waitsCommand: string,
  closed = false,
): SwampError {
  const where = whereOf(place);
  switch (outcome.kind) {
    case "accepted":
      return alreadySettled(typedId, where, outcome.receipt);
    case "timed_out":
      return refused(
        "expired",
        `Wait ${typedId} expired at ${outcome.deadline}: ${where} no longer accepts a signal.` +
          (closed
            ? ""
            : ` Resume the run to fail the step with wait_timeout: ${
              resumeCommandFor(place)
            }`),
      );
    case "cancelled":
      return refused(
        "closed",
        `Wait ${typedId} was closed before a signal arrived: the run of ${where} ended, or the step moved on to a new wait. ` +
          `Run "${waitsCommand}" for the waits still open.`,
      );
  }
}

async function runOf(
  deps: WorkflowSignalDeps,
  place: Pick<WaitPlace, "workflowId" | "runId">,
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

async function resolveRegistration(
  deps: WorkflowSignalDeps,
  store: SignalWaitStore,
  typedId: string,
  waitId: string,
  authorize: WorkflowSignalInput["authorize"],
  heldUnder: SignalTarget["heldUnder"],
  waitsCommand: string,
): Promise<
  | { registration: WaitRegistration; authorized: boolean }
  | { error: SwampError }
> {
  const stored = await store.findRegistration(waitId);
  // The caller is authorized by `deliver`, which reads the run record first.
  if (stored.kind === "found") {
    return heldBy(stored.record, heldUnder)
      ? { registration: stored.record, authorized: false }
      : { error: unreadableRecord(typedId) };
  }

  // No registration, or one that cannot be read: the run record still
  // holds the whole wait, so it is asked, and the registration rebuilt.
  const held = deps.scanRunRecords === false
    ? undefined
    : await locateInRunRecords(deps, waitId);
  const outcome = await store.findOutcome(waitId);
  if (!held) {
    // A settled wait whose registration is gone: answered from the outcome
    // alone, which names the run but not the step.
    if (outcome.kind === "found") {
      if (
        !heldBy({ workflowId: outcome.record.workflowId, key: null }, heldUnder)
      ) {
        return { error: unreadableRecord(typedId) };
      }
      // The outcome does not name the workflow, so the run it references is
      // asked: a workflow renamed since is still authorized under the name
      // the run recorded. Without the run record only the id is left.
      const run = authorize ? await runOf(deps, outcome.record) : null;
      if (
        authorize && !(await authorize({
          waitId,
          workflowId: outcome.record.workflowId,
          runId: outcome.record.runId,
          ...(run
            ? {
              workflowName: run.workflowName,
              runWorkflow: {
                workflowId: run.workflowId,
                workflowName: run.workflowName,
              },
            }
            : {}),
        }))
      ) return { error: unknownWait(typedId) };
      if (outcome.record.kind === "accepted") {
        return {
          error: alreadySettled(
            typedId,
            `run ${outcome.record.runId}`,
            outcome.record.receipt,
          ),
        };
      }
      if (outcome.record.kind === "timed_out") {
        return { error: expiredAt(typedId, outcome.record.deadline) };
      }
      return {
        error: stored.kind === "unreadable"
          ? unreadableRecord(typedId)
          : closedBeforeSignal(typedId, waitsCommand),
      };
    }
    // Nothing says which workflow the wait belongs to, so a caller that
    // must be authorized cannot be: it learns nothing about the wait.
    return {
      error:
        authorize || (stored.kind === "absent" && outcome.kind === "absent")
          ? unknownWait(typedId)
          : unreadableRecord(typedId),
    };
  }

  const { run, jobName, step } = held;
  if (
    !heldBy({
      workflowId: run.workflowId,
      key: step.signalWait ? step.signalWait.key : null,
    }, heldUnder)
  ) return { error: unreadableRecord(typedId) };
  const place: WaitPlace = {
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    runId: run.id,
    jobName,
    stepName: step.stepName,
  };
  if (
    authorize && !(await authorize({
      waitId,
      workflowId: place.workflowId,
      workflowName: place.workflowName,
      runId: place.runId,
      runWorkflow: {
        workflowId: run.workflowId,
        workflowName: run.workflowName,
      },
    }))
  ) return { error: unknownWait(typedId) };
  if (outcome.kind === "found") {
    return {
      error: refusalFor(typedId, place, outcome.record, waitsCommand, true),
    };
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
      error: refused(
        "closed",
        `Wait ${typedId} is closed: ${whereOf(place)} is ${step.status}` +
          (step.error ? ` (${step.error})` : "") + ".",
      ),
    };
  }
  return {
    authorized: true,
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

interface SignalTarget {
  waitId: string;
  typedId: string;
  /**
   * the workflow and key a key address named; any record placing the wait must
   * name them: key records are plaintext in a store other writers can reach,
   * and an altered claim must neither carry a signal nor be answered from
   */
  heldUnder?: { workflowId: string; key: string };
  /**
   * the receipt id of the pending signal this caller stored for the key; a wait
   * settled by that signal took this caller's signal, whoever created the
   * outcome, and is answered as delivered
   */
  pendingReceiptId?: string;
}

function heldBy(
  placed: { workflowId: string; key?: string | null },
  heldUnder: SignalTarget["heldUnder"],
): boolean {
  if (!heldUnder) return true;
  return placed.workflowId === heldUnder.workflowId &&
    (placed.key === null || placed.key === heldUnder.key);
}

async function deliver(
  deps: WorkflowSignalDeps,
  store: SignalWaitStore,
  input: WorkflowSignalInput,
  target: SignalTarget,
): Promise<{ error: SwampError } | { data: WorkflowSignalData }> {
  const { waitId, typedId, heldUnder, pendingReceiptId } = target;
  const resolved = await resolveRegistration(
    deps,
    store,
    typedId,
    waitId,
    input.authorize,
    heldUnder,
    waitsCommandOf(input),
  );
  if ("error" in resolved) return resolved;
  const { registration } = resolved;
  const now = deps.now?.() ?? new Date();
  const run = await runOf(deps, registration);
  if (
    input.authorize && !resolved.authorized && !(await input.authorize({
      waitId: registration.waitId,
      workflowId: registration.workflowId,
      workflowName: registration.workflowName,
      runId: registration.runId,
      ...(run
        ? {
          runWorkflow: {
            workflowId: run.workflowId,
            workflowName: run.workflowName,
          },
        }
        : {}),
    }))
  ) return { error: unknownWait(typedId) };
  // a step never returns to a wait it left: if the run record shows it past
  // this wait with no outcome stored, answer from the record instead of
  // accepting a signal that is never applied
  const left = stepLeftWait(run, registration);
  if (
    left && (await store.findOutcome(registration.waitId)).kind === "absent"
  ) {
    const receipt = left.signalWait?.receipt;
    return {
      error: receipt
        ? alreadySettled(typedId, whereOf(registration), receipt)
        : refused(
          "closed",
          `Wait ${typedId} is closed: ${
            whereOf(registration)
          } is ${left.status}` +
            (left.error ? ` (${left.error})` : "") + ".",
        ),
    };
  }
  if (stepHoldsUnreadableWait(run, registration)) {
    return {
      error: refused(
        "unreadable",
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
  let duplicate = false;
  if (stored.kind === "absent") {
    const submittedBy = senderOf(input);
    const decision = decideSignal(
      registration,
      input.payload,
      submittedBy,
      now,
      input.idempotencyKey,
    );
    if (!decision.accepted) {
      const refusal = decision.refusal;
      if (refusal.kind === "invalid_payload") {
        return {
          error: refused(
            "invalid_payload",
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
        }, waitsCommandOf(input)),
      };
    }
    delivered = decision.outcome;
    stored = await store.settle(decision.outcome);
  } else if (
    pendingReceiptId !== undefined && stored.kind === "found" &&
    stored.record.kind === "accepted" &&
    stored.record.receipt.id === pendingReceiptId
  ) {
    delivered = stored.record;
  }
  // The wait was settled by another copy of this signal, from the same
  // sender under the same idempotency key: an earlier attempt, or one that
  // won the create at the same moment. Answered with that one.
  if (
    input.idempotencyKey !== undefined && stored.kind === "found" &&
    stored.record.kind === "accepted" &&
    !(delivered && settledBy(stored, delivered)) &&
    stored.record.receipt.idempotencyKey === input.idempotencyKey &&
    stored.record.receipt.submittedBy === senderOf(input)
  ) {
    delivered = stored.record;
    duplicate = true;
  }

  if (stored.kind !== "found") return { error: unreadableRecord(typedId) };
  // Another signal, a timeout or a cancel settled the wait first: the
  // caller is answered from what is stored.
  if (
    !delivered || stored.record.kind !== "accepted" ||
    !settledBy(stored, delivered)
  ) {
    return {
      error: refusalFor(
        typedId,
        registration,
        stored.record,
        waitsCommandOf(input),
      ),
    };
  }

  return {
    data: {
      waitId: registration.waitId,
      ...(registration.key !== undefined ? { key: registration.key } : {}),
      workflowId: registration.workflowId,
      workflowName: registration.workflowName,
      runId: registration.runId,
      jobName: registration.jobName,
      stepName: registration.stepName,
      signal: receiptForCaller(stored.record.receipt),
      awaitingResume: run !== null &&
        (await decideContinuation(run, store)).kind === "resumable",
      runRecordAvailable: run !== null,
      resumeCommand: resumeCommandFor(registration),
      ...(duplicate ? { duplicate: true as const } : {}),
    },
  };
}

function namedByKey(address: { workflow: string; key: string }): string {
  return `key "${printable(address.key)}" of workflow "${
    printable(address.workflow)
  }"`;
}

/**
 * The wait that last held a key no open wait holds now, for the caller to be
 * told of. Nothing is said of a wait the caller may not signal, or of one
 * whose outcome names another workflow than the key was resolved under.
 */
async function lastWaitUnder(
  deps: WorkflowSignalDeps,
  store: SignalWaitStore,
  input: WorkflowSignalInput,
  workflowId: string,
  key: string,
): Promise<SignalLastWait | undefined> {
  const settled = await findSettledKeyHolder(store, workflowId, key);
  if (!settled || settled.outcome.workflowId !== workflowId) return undefined;
  const { outcome } = settled;
  if (input.authorize) {
    const run = await runOf(deps, outcome);
    const allowed = await input.authorize({
      waitId: outcome.waitId,
      workflowId: outcome.workflowId,
      runId: outcome.runId,
      ...(run
        ? {
          workflowName: run.workflowName,
          runWorkflow: {
            workflowId: run.workflowId,
            workflowName: run.workflowName,
          },
        }
        : {}),
    });
    if (!allowed) return undefined;
  }
  return {
    waitId: outcome.waitId,
    settledAs: outcome.kind,
    settledAt: outcome.settledAt,
    ...(outcome.kind === "accepted"
      ? { receipt: receiptForCaller(outcome.receipt) }
      : {}),
  };
}

function lastWaitSentence(last: SignalLastWait): string {
  switch (last.settledAs) {
    case "accepted":
      return ` The last wait under the key was settled by signal ${
        last.receipt?.id ?? "unknown"
      } at ${last.settledAt}. A signal you sent at about that time has landed; one meant for a later run is early.`;
    case "timed_out":
      return ` The last wait under the key expired unsignalled at ${last.settledAt}.`;
    case "cancelled":
      return ` The last wait under the key was closed at ${last.settledAt}, before a signal arrived.`;
  }
}

const LEAVES_WAIT_OPEN: ReadonlySet<SignalRefusalKind> = new Set<
  SignalRefusalKind
>(["invalid_payload", "unreadable"]);

/**
 * no message names the wait id (telemetry strips what was typed, the id was
 * not); it is in the error's details. A holder settled mid-resolve is answered
 * from storage, never moved to another wait
 */
async function deliverByKey(
  deps: WorkflowSignalDeps,
  store: SignalWaitStore,
  input: WorkflowSignalInput & { workflow: string; key: string },
): Promise<
  | { error: SwampError }
  | { data: WorkflowSignalData }
  | { pending: WorkflowSignalPendingData }
> {
  // An unknown workflow and a key it does not declare are answered alike.
  const named = namedByKey(input);
  const typedId = `holding ${named}`;
  const workflow = await deps.findWorkflow(input.workflow);
  if (!workflow || !declaredWaitKeyStep(workflow, input.key)) {
    return { error: unknownWait(named) };
  }
  // A retry of a signal that was received is answered with that signal,
  // before the key's holder is asked: the key may be free again, or held by
  // the next run's wait, and neither is to take the signal a second time.
  if (input.idempotencyKey !== undefined) {
    const earlier = await findSignalByIdempotencyKey(
      store,
      { workflowId: workflow.id, key: input.key },
      {
        idempotencyKey: input.idempotencyKey,
        submittedBy: senderOf(input),
      },
      deps.now?.() ?? new Date(),
    );
    // A caller that cannot be told a signal is held is not told this one
    // is: it goes on to the refusal it can read.
    if (earlier?.kind === "pending" && input.holdEarly !== false) {
      const { pending } = pendingAnswer(input, workflow, earlier.record);
      return { pending: { ...pending, duplicate: true } };
    }
    if (earlier?.kind === "settled") {
      return await landedAnswer(
        deps,
        input,
        workflow,
        earlier.claim,
        { ...earlier.outcome.receipt },
        { duplicate: true, store },
      );
    }
  }
  const holder = await findKeyHolder(store, workflow.id, input.key);
  if (holder.kind === "unreadable") {
    return { error: unreadableRecord(typedId) };
  }
  // a step that sets `acceptEarly` has a signal with no open wait held for its
  // next one, only for a caller that can be told so
  const declaredEarly = declaredEarlyWait(workflow, input.key);
  const early = input.holdEarly === false ? undefined : declaredEarly;
  if (holder.kind === "free" && early) {
    return await arriveEarly(deps, store, input, workflow, early);
  }
  if (holder.kind === "free") {
    // A sender who retries after a lost reply gets this refusal, as does one
    // who is early for the next run. The wait that last held the key tells
    // the two apart.
    const last = await lastWaitUnder(
      deps,
      store,
      input,
      workflow.id,
      input.key,
    );
    return {
      error: refused(
        "no_open_wait",
        `No open wait holds ${named}, so the signal was not delivered and nothing was stored.` +
          (last ? lastWaitSentence(last) : "") +
          (declaredEarly
            ? " The step holds a signal sent before its wait opens, but only for a client that can read that answer: upgrade swamp where the signal is sent."
            : "") +
          ` Run "${waitsCommandOf(input)}" for the waits that are open.`,
        last ? { lastWait: last } : {},
      ),
    };
  }
  const outcome = await deliverToHolder(
    deps,
    store,
    input,
    workflow,
    holder.claim.waitId,
  );
  if (!("error" in outcome)) return outcome;
  // The holder was past its deadline, or was closed in between: no open wait
  // holds the key, so the signal is early for the next one, not late.
  const refusal = signalRefusalKind(outcome.error);
  return early && (refusal === "expired" || refusal === "closed")
    ? await arriveEarly(deps, store, input, workflow, early)
    : outcome;
}

async function deliverToHolder(
  deps: WorkflowSignalDeps,
  store: SignalWaitStore,
  input: WorkflowSignalInput & { workflow: string; key: string },
  workflow: Workflow,
  waitId: string,
  pendingReceiptId?: string,
): Promise<{ error: SwampError } | { data: WorkflowSignalData }> {
  const named = namedByKey(input);
  const typedId = `holding ${named}`;
  const outcome = await deliver(deps, store, input, {
    waitId,
    typedId,
    heldUnder: { workflowId: workflow.id, key: input.key },
    ...(pendingReceiptId !== undefined ? { pendingReceiptId } : {}),
  });
  if (!("error" in outcome)) return outcome;
  const kind = signalRefusalKind(outcome.error);
  // The claim names a wait nothing here knows: answered as that wait's ID
  // would be, in the words of the address that was given.
  const error = kind === "unknown" ? unknownWait(named) : outcome.error;
  return {
    error: {
      ...error,
      message: kind !== undefined && LEAVES_WAIT_OPEN.has(kind)
        ? `${error.message}\n"${
          waitsCommandOf(input)
        }" lists the wait and its ID.`
        : error.message,
      details: { ...(error.details as object), waitId },
    },
  };
}

function receiptOfPending(pending: PendingSignal): PendingSignalReceipt {
  return {
    id: pending.receiptId,
    receivedAt: pending.receivedAt,
    submittedBy: pending.submittedBy,
    ...(pending.idempotencyKey !== undefined
      ? { idempotencyKey: pending.idempotencyKey }
      : {}),
  };
}

function pendingAnswer(
  input: { key: string },
  workflow: Workflow,
  record: PendingSignal,
): { pending: WorkflowSignalPendingData } {
  return {
    pending: {
      pending: true,
      key: input.key,
      workflowId: workflow.id,
      workflowName: workflow.name,
      signal: receiptOfPending(record),
      heldUntil: heldUntil(record).toISOString(),
    },
  };
}

/**
 * the answer for a signal a wait took with nobody left to deliver it to; the
 * wait's run may have ended and its registration be gone, so the claim says
 * where the signal landed. The caller is authorized against that wait.
 */
async function landedAnswer(
  deps: WorkflowSignalDeps,
  input: WorkflowSignalInput & { workflow: string; key: string },
  workflow: Workflow,
  claim: WaitKeyClaim,
  receipt: SignalReceipt,
  how: { store: SignalWaitStore } & ({ taken: true } | { duplicate: true }),
): Promise<{ error: SwampError } | { data: WorkflowSignalData }> {
  const place: WaitPlace = {
    workflowId: workflow.id,
    workflowName: workflow.name,
    runId: claim.runId,
    jobName: claim.jobName,
    stepName: claim.stepName,
  };
  const run = await runOf(deps, place);
  if (
    input.authorize && !(await input.authorize({
      waitId: claim.waitId,
      workflowId: workflow.id,
      workflowName: workflow.name,
      runId: claim.runId,
      ...(run
        ? {
          runWorkflow: {
            workflowId: run.workflowId,
            workflowName: run.workflowName,
          },
        }
        : {}),
    }))
  ) return { error: unknownWait(namedByKey(input)) };
  return {
    data: {
      waitId: claim.waitId,
      key: input.key,
      ...place,
      signal: receiptForCaller(receipt),
      // a step that took the signal on opening its wait succeeded inside its
      // run, and no resume applies it; a wait already open may have been given
      // it by another reader, and the run says whether it is still suspended
      awaitingResume: run !== null &&
        (await decideContinuation(run, how.store)).kind === "resumable",
      runRecordAvailable: run !== null,
      resumeCommand: resumeCommandFor(place),
      ..."taken" in how ? { taken: true } : { duplicate: true },
    },
  };
}

/**
 * holds a signal by key that found no open wait as the key's pending signal. No
 * wait exists to authorize against: a caller answering for a server authorizes
 * the workflow first; a wait found on the way is authorized by `deliver`.
 */
async function arriveEarly(
  deps: WorkflowSignalDeps,
  store: SignalWaitStore,
  input: WorkflowSignalInput & { workflow: string; key: string },
  workflow: Workflow,
  early: DeclaredEarlyWait,
): Promise<
  | { error: SwampError }
  | { data: WorkflowSignalData }
  | { pending: WorkflowSignalPendingData }
> {
  const named = namedByKey(input);
  const now = deps.now?.() ?? new Date();
  const validation = validateEarlyPayload(early.schema, input.payload, now);
  if (!validation.valid) {
    return {
      error: refused(
        "invalid_payload",
        `Payload refused for ${named}; nothing was stored:\n` +
          validation.errors.map((error) => `  - ${error}`).join("\n"),
        // `early`: no wait was open, so none stays open.
        { errors: validation.errors, early: true },
      ),
    };
  }
  const submittedBy = senderOf(input);
  const arrival = await holdEarlySignal(store, {
    workflowId: workflow.id,
    key: input.key,
    payload: validation.payload,
    submittedBy,
    acceptEarly: early.acceptEarly,
    ...(input.idempotencyKey !== undefined
      ? { idempotencyKey: input.idempotencyKey }
      : {}),
    // Only a wait whose run recorded the name the caller was authorized
    // under takes the signal. The local command authorizes nobody.
    ...(input.authorize ? { authorizedFor: workflow.name } : {}),
  }, now);
  // The signal it was stored over is read by nothing now. A failure here
  // leaves that record for the sweep; the signal itself is stored.
  if (
    (arrival.kind === "pending" || arrival.kind === "held" ||
      arrival.kind === "taken") && arrival.record
  ) {
    try {
      await removeSupersededPendingSignal(store, arrival.record);
    } catch {
      // Left for the sweep.
    }
  }
  switch (arrival.kind) {
    case "pending": {
      const answer = pendingAnswer(input, workflow, arrival.record);
      const last = await lastWaitUnder(
        deps,
        store,
        input,
        workflow.id,
        input.key,
      );
      return last ? { pending: { ...answer.pending, lastWait: last } } : answer;
    }
    case "already_pending":
      // The same signal, sent twice at the same moment: one was stored.
      if (
        input.idempotencyKey !== undefined &&
        arrival.record.idempotencyKey === input.idempotencyKey &&
        arrival.record.submittedBy === submittedBy
      ) {
        const { pending } = pendingAnswer(input, workflow, arrival.record);
        return { pending: { ...pending, duplicate: true } };
      }
      // Who sent it stays in the details: the message reaches telemetry.
      return {
        error: refused(
          "already_pending",
          `A signal is already pending for ${named}: signal ${arrival.record.receiptId}, held until ${
            heldUntil(arrival.record).toISOString()
          }. This one was not stored. A key holds one pending signal. Send again after that time if no step has taken it.`,
          {
            receipt: receiptOfPending(arrival.record),
            heldUntil: heldUntil(arrival.record).toISOString(),
          },
        ),
      };
    case "unreadable":
      return { error: unreadableRecord(`holding ${named}`) };
    case "contended":
      return {
        error: refused(
          "no_open_wait",
          `The signal for ${named} was not held: the key changed hands while it arrived. Send it again.`,
        ),
      };
    case "held": {
      const { claim, record } = arrival;
      // The step registers its wait before it reads the slot, so a wait not
      // registered yet has not read it: it will find this signal there.
      if (
        record && claim.early !== undefined &&
        earlySlots(claim.early).includes(record.slot) &&
        (await store.findRegistration(claim.waitId)).kind === "absent"
      ) {
        // unless the signal is older than that wait allows: every reader then
        // leaves it where it is, so it is not answered as held. The wait's
        // workflow name and schema cannot be read before it is registered.
        if (isReceivedForWait(record, { ...claim, early: claim.early })) {
          return pendingAnswer(input, workflow, record);
        }
        return {
          error: refused(
            "no_open_wait",
            `The signal for ${named} was not delivered: it arrived too long before the wait that is opening for a step to take it. Send it again once the wait is open. Run "${
              waitsCommandOf(input)
            }" for the waits that are open.`,
          ),
        };
      }
      // Otherwise the wait is signalled as any open wait is. One whose
      // claim reads this signal's slot takes the stored signal first.
      return await deliverToHolder(
        deps,
        store,
        input,
        workflow,
        claim.waitId,
        record?.receiptId,
      );
    }
    case "duplicate":
      return await landedAnswer(
        deps,
        input,
        workflow,
        arrival.claim,
        { ...arrival.outcome.receipt },
        { duplicate: true, store },
      );
    case "taken":
      return await landedAnswer(
        deps,
        input,
        workflow,
        arrival.claim,
        { ...receiptOfPending(arrival.record), waitId: arrival.claim.waitId },
        { taken: true, store },
      );
  }
}

/**
 * creates the wait's outcome record and never writes the run record; the step
 * succeeds with the message when the run is next resumed (the only writer of a
 * suspended run), so any host may signal
 */
export async function* workflowSignal(
  _ctx: LibSwampContext,
  deps: WorkflowSignalDeps,
  input: WorkflowSignalInput,
): AsyncIterable<WorkflowSignalEvent> {
  yield* withGeneratorSpan(
    "swamp.workflow.signal",
    "waitId" in input ? { "wait.id": input.waitId } : { "wait.key": input.key },
    (async function* () {
      yield { kind: "resolving" };

      const byKey = "waitId" in input ? undefined : input;
      let target: SignalTarget | undefined;
      if ("waitId" in input) {
        const waitId = normalizeWaitId(input.waitId);
        if (!waitId) {
          yield { kind: "error", error: unknownWait(input.waitId) };
          return;
        }
        target = { waitId, typedId: input.waitId };
      } else if (!isWaitKey(input.key)) {
        // A string that is not in the form of a key is one no step declares.
        yield { kind: "error", error: unknownWait(namedByKey(input)) };
        return;
      }
      if (
        input.idempotencyKey !== undefined &&
        !isIdempotencyKey(input.idempotencyKey)
      ) {
        yield {
          kind: "error",
          error: validationFailed(
            `An idempotency key is ${IDEMPOTENCY_KEY_FORM}.`,
          ),
        };
        return;
      }
      if (!deps.signalWaits.supported) {
        yield {
          kind: "error",
          error: refused(
            "unsupported",
            `This datastore cannot support a wait for a signal: ${deps.signalWaits.reason}.`,
          ),
        };
        return;
      }

      const store = deps.signalWaits.store;
      const outcome = target
        ? await deliver(deps, store, input, target)
        : await deliverByKey(deps, store, byKey!);
      if ("error" in outcome) {
        yield { kind: "error", error: outcome.error };
        return;
      }
      if ("pending" in outcome) {
        yield { kind: "pending", data: outcome.pending };
        return;
      }
      yield { kind: "completed", data: outcome.data };
    })(),
  );
}
