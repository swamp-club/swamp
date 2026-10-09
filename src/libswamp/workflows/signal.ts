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
  isWaitKey,
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
} from "../../domain/workflows/wait_key_claim.ts";
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
  /** The wait that took the signal, however the signal was addressed. */
  waitId: string;
  /** The key the wait holds, when its step declared one. */
  key?: string;
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
  /**
   * False when this host has no copy of the run record, as on a second host
   * that has not synced it. `awaitingResume` is then unknown, and reported
   * as false.
   */
  runRecordAvailable: boolean;
  /** The command that resumes the run. */
  resumeCommand: string;
}

export type WorkflowSignalEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: WorkflowSignalData }
  | { kind: "error"; error: SwampError };

/**
 * How a signal names its wait: by the wait's ID, or by a workflow and a key
 * one of its `wait_for_signal` steps declares (swamp-club#3210). A key is
 * resolved to the ID of the wait that holds it before anything is decided.
 */
export type WorkflowSignalAddress =
  | { waitId: string }
  | {
    /** The workflow's name or ID. */
    workflow: string;
    key: string;
  };

export type WorkflowSignalInput = WorkflowSignalAddress & {
  /** The message. Untrusted: it is validated before anything is stored. */
  payload: unknown;
  /** Who sent it. Defaults to the OS user, as a local approval's decider. */
  submittedBy?: string;
  /**
   * Decides whether the caller may signal the wait, once it is known which
   * workflow and run the wait belongs to. It is asked before anything is
   * stored and before any answer that names the workflow, the run, the step
   * or an earlier signal. When it refuses, or when the wait cannot be placed
   * at all, the answer is the one an unknown wait ID gets. The local command
   * passes none: it does no authorization.
   */
  authorize?: (wait: SignalWaitSubject) => Promise<boolean>;
  /**
   * The command a refusal suggests for listing the open waits. Defaults to
   * the local one; a caller that answers for a server passes the form that
   * reaches it.
   */
  waitsCommand?: string;
};

/** The command that lists the open waits of the repository a signal ran in. */
const LOCAL_WAITS_COMMAND = "swamp workflow waits";

function waitsCommandOf(input: Pick<WorkflowSignalInput, "waitsCommand">) {
  return input.waitsCommand ?? LOCAL_WAITS_COMMAND;
}

/** What a wait belongs to, as far as the stored records say. */
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
   * The workflow recorded on the run, when this host finds the run record.
   * The run is looked up under `workflowId`, so the two IDs always agree; the
   * names differ when the registration's name was altered. A registration
   * whose workflow ID was altered finds no run, and this is absent.
   */
  runWorkflow?: { workflowId: string; workflowName: string };
}

/**
 * The wait that last held a key, in the `lastWait` field of a `no_open_wait`
 * error's details: what a sender who retries after a lost reply needs to
 * tell "my signal landed" from "the run has not reached its wait". Present
 * while that wait's claim is still the key's highest record, and only for a
 * caller who may signal the wait.
 */
export interface SignalLastWait {
  waitId: string;
  /** How that wait was settled. */
  settledAs: "accepted" | "timed_out" | "cancelled";
  settledAt: string;
  /** The signal that settled it, when one did. */
  receipt?: SignalReceipt;
}

/** The `lastWait` a `no_open_wait` error carries, if it carries one. */
export function signalLastWait(error: SwampError): SignalLastWait | undefined {
  const details = error.details;
  if (typeof details !== "object" || details === null) return undefined;
  return (details as { lastWait?: SignalLastWait }).lastWait;
}

/** Why a signal was not delivered, in the `refusal` field of the error's details. */
export type SignalRefusalKind =
  | "unknown"
  | "no_open_wait"
  | "expired"
  | "invalid_payload"
  | "already_settled"
  | "closed"
  | "unreadable"
  | "unsupported";

const SIGNAL_REFUSAL_KINDS: ReadonlySet<string> = new Set<SignalRefusalKind>([
  "unknown",
  "no_open_wait",
  "expired",
  "invalid_payload",
  "already_settled",
  "closed",
  "unreadable",
  "unsupported",
]);

/** The refusal an error from {@link workflowSignal} carries, if it is one. */
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
  /**
   * The workflow a name or an ID refers to, for a signal addressed by key.
   * Read only.
   */
  findWorkflow: (idOrName: string) => Promise<Workflow | null>;
  /** Where wait records are kept, or why this datastore cannot hold them. */
  signalWaits: SignalWaitSupport;
  /** The time the deadline is compared against. Defaults to the current time. */
  now?: () => Date;
  /**
   * Whether a wait with no readable registration is looked for in the run
   * records. Defaults to true. A caller that answers requests from outside
   * turns it off, so one request cannot make it read every run; such a wait
   * is then answered as unknown until `workflow waits` registers it.
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
    { receipt },
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

/** The run a wait belongs to, as this host has it. */
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

/** The wait a signal is delivered to, once its address is resolved. */
interface SignalTarget {
  waitId: string;
  /**
   * What a message calls the wait, after the word "wait": the ID as it was
   * typed, or the workflow and key it was addressed by.
   */
  typedId: string;
  /**
   * The workflow and key a key address named. Whatever record places the
   * wait must name that workflow, and that key where it names one: key
   * records are plaintext in a store other writers can reach, and a claim
   * altered to name a wait of another workflow must neither carry a signal
   * there nor be answered with what is stored about that wait.
   */
  heldUnder?: { workflowId: string; key: string };
}

/**
 * True when a record that places a wait agrees with the key address the
 * wait was resolved from, or when the wait was named by ID. `key` is left
 * out for a record that names no key: an outcome, or a step that has left
 * its wait.
 */
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
  const { waitId, typedId, heldUnder } = target;
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
      signal: { ...stored.record.receipt },
      awaitingResume: run !== null &&
        (await decideContinuation(run, store)).kind === "resumable",
      runRecordAvailable: run !== null,
      resumeCommand: resumeCommandFor(registration),
    },
  };
}

/** A key address in a message, as the workflow and key were typed. */
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
    ...(outcome.kind === "accepted" ? { receipt: { ...outcome.receipt } } : {}),
  };
}

/** What a `no_open_wait` message says of the wait that last held the key. */
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

/** Refusals after which the wait a key resolved to may still be open. */
const LEAVES_WAIT_OPEN: ReadonlySet<SignalRefusalKind> = new Set<
  SignalRefusalKind
>(["invalid_payload", "unreadable"]);

/**
 * Delivers a signal addressed by workflow and key (swamp-club#3210): the
 * key is resolved to the wait that holds it, and that wait takes the signal
 * as one named by ID does. Resolving writes nothing. A holder settled
 * between the two is answered from what is stored; the signal is never
 * moved on to another wait.
 *
 * No message names the wait ID. Telemetry removes from a message what was
 * typed, and the ID was not typed, while it is all a signal needs. It is in
 * the error's details for a caller of this function; the command prints the
 * message alone, and `workflow waits` lists the ID beside the key.
 */
async function deliverByKey(
  deps: WorkflowSignalDeps,
  store: SignalWaitStore,
  input: WorkflowSignalInput & { workflow: string; key: string },
): Promise<{ error: SwampError } | { data: WorkflowSignalData }> {
  // An unknown workflow and a key it does not declare are answered alike.
  const named = namedByKey(input);
  const typedId = `holding ${named}`;
  const workflow = await deps.findWorkflow(input.workflow);
  if (!workflow || !declaredWaitKeyStep(workflow, input.key)) {
    return { error: unknownWait(named) };
  }
  const holder = await findKeyHolder(store, workflow.id, input.key);
  if (holder.kind === "unreadable") {
    return { error: unreadableRecord(typedId) };
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
          ` Run "${waitsCommandOf(input)}" for the waits that are open.`,
        last ? { lastWait: last } : {},
      ),
    };
  }
  const waitId = holder.claim.waitId;
  const outcome = await deliver(deps, store, input, {
    waitId,
    typedId,
    heldUnder: { workflowId: workflow.id, key: input.key },
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
      yield { kind: "completed", data: outcome.data };
    })(),
  );
}
