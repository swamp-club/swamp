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

import {
  type UnitOfWork,
  UnrecordedEndError,
} from "../datastore/unit_of_work.ts";
import { UserError } from "../errors.ts";
import {
  RUN_INITIATOR_MISMATCH_CODE,
  RUN_INITIATOR_MISMATCH_REASON,
} from "./commit_authorization.ts";
import type { FileAccess } from "./file_access.ts";
import type { Intent } from "./intent.ts";
import type { Op, PutExpect } from "./op.ts";
import { CommitRejectedError, type CommitRejection } from "./partition.ts";
import type { PartitionKey } from "./partition_key.ts";
import type { RecordKey } from "./record_key.ts";

/**
 * read at commit, not staging, and once; the exception is repair after a chunk
 * GC race, where it is read again and must give the same content. Until commit
 * the file must stay readable and unchanged
 */
export type ContentSource =
  | Uint8Array
  | (() => ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>);

/**
 * putOp takes the chunk's BlobRef, so content needing a chunk cannot be built
 * before it is stored; staging the content keeps chunk uploads at commit, so an
 * abandoned unit uploads nothing
 */
export interface PendingPut {
  readonly intent: Intent;
  readonly key: RecordKey;
  readonly expect?: PutExpect;
  readonly content: ContentSource;
  readonly access?: FileAccess;
  /**
   * asked under the partition's lock on each append attempt; true drops the put,
   * since another writer now owns the record it would replace
   */
  readonly withdrawn?: () => boolean;
}

/**
 * a path alone cannot become a commit: the commit needs the intent serve
 * authorises on and the content the partition records
 */
export type TypedChange =
  | { readonly partition: PartitionKey; readonly op: Op }
  | { readonly partition: PartitionKey; readonly put: PendingPut };

/**
 * commit commits data partitions first and a workflow run's record last;
 * path-only stage is refused on v3 rather than guessed into an op
 */
export interface DirectAppendOptions {
  /**
   * commits with everything the unit has staged, in the unit's order, instead
   * of alone; a refusal of any of it refuses the append
   */
  readonly withStaged?: boolean;
}

export interface CommitLogUnitOfWork extends UnitOfWork {
  stageOp(change: TypedChange): Promise<void>;
  /**
   * the caller acknowledges once it has saved each affected run again so its
   * record names no refused data; only a root holds them, so a child refuses
   * the call. Given partitions, only their refusals are acknowledged
   */
  acknowledgeRefusals(partitions?: readonly PartitionKey[]): void;
  /**
   * all or nothing; a partition's changes split into commits only between
   * batches, so one batch lands in one commit and a batch over the limit for
   * one partition is refused
   */
  stageOps(changes: readonly TypedChange[]): Promise<void>;
  /** `release` names a lease to end with the commits, once they all land */
  checkpoint(options?: { readonly release?: string }): Promise<void>;
  /**
   * commits changes for one partition as their own commit at once, never
   * staging them, so the commit waits on nothing the unit has staged
   */
  appendNow(
    changes: readonly TypedChange[],
    options?: DirectAppendOptions,
  ): Promise<DirectAppendOutcome>;
  stagedOps(): readonly TypedChange[];
}

/** queued: held in the outbox while serve is unreachable, to land later */
export type DirectAppendOutcome = "committed" | "queued" | "excluded";

export interface PartitionRefusal {
  readonly partition: PartitionKey;
  readonly reason: CommitRejection;
  readonly message: string;
  readonly key?: string;
  readonly changedBy?: string;
  readonly changedAt?: string;
  /**
   * the data versions the refused changes recorded, by data id, so a run can
   * mark the steps that wrote them failed
   */
  readonly versions: readonly {
    readonly dataId: string;
    readonly version: number;
  }[];
}

export const PARTITIONS_REFUSED_CODE = "datastore_v3_partitions_refused";

/**
 * heldRuns are run partitions held while a refusal is unacknowledged, since a
 * run record must never name data its partition refused and is rewritten whole
 * on each save
 */
export class PartitionsRefusedError extends CommitRejectedError {
  readonly code = PARTITIONS_REFUSED_CODE;

  constructor(
    readonly refusals: readonly PartitionRefusal[],
    readonly heldRuns: readonly PartitionKey[],
    cause?: unknown,
  ) {
    if (refusals.length === 0) {
      throw new Error("PartitionsRefusedError needs at least one refusal");
    }
    const held = heldRuns.length === 0 ? "" : `; ${heldRuns.length} workflow ` +
      `run record(s) were held back, since they may name data a refused ` +
      `partition did not record (${heldRuns.join(", ")})`;
    super(
      refusals[0].reason,
      refusals.map((refusal) => refusal.message).join("; ") + held,
    );
    this.name = "PartitionsRefusedError";
    if (cause !== undefined) this.cause = cause;
  }
}

export const COMMIT_LEASE_LOST_CODE = "datastore_v3_commit_lease_lost";

/**
 * serve refused a commit because the behavior's lease was not held: nothing of
 * the refused partitions landed, though earlier commits of the command may
 * have
 */
export class CommitLeaseLostError extends UserError {
  constructor(message: string) {
    super(message, COMMIT_LEASE_LOST_CODE);
    this.name = "CommitLeaseLostError";
  }
}

const MAX_CAUSE_DEPTH = 8;

/** a refusal, or one it wraps, in which every refused partition lost its lease */
export function leaseLostRefusalOf(
  error: unknown,
): PartitionsRefusedError | undefined {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    // a change that may still land says so in its own words
    if (current instanceof MayLandLaterError) return undefined;
    if (current instanceof PartitionsRefusedError) {
      return current.refusals.every((refusal) =>
          refusal.reason === "lease-lost"
        )
        ? current
        : undefined;
    }
    if (!(current instanceof Error)) return undefined;
    current = current.cause;
  }
  return undefined;
}

/** serve refused a new run record for the initiator it names */
export class RunInitiatorMismatchError extends UserError {
  constructor(message: string, cause: unknown) {
    super(message, RUN_INITIATOR_MISMATCH_CODE);
    this.name = "RunInitiatorMismatchError";
    this.cause = cause;
  }
}

/** the refusal, raw or wrapped, as the coded error the user is shown */
export function runInitiatorMismatchOf(
  error: unknown,
): RunInitiatorMismatchError | undefined {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (current instanceof RunInitiatorMismatchError) return current;
    if (!(current instanceof Error)) return undefined;
    const reason = (current as { reason?: unknown }).reason;
    if (reason === RUN_INITIATOR_MISMATCH_REASON) {
      return new RunInitiatorMismatchError(current.message, current);
    }
    current = current.cause;
  }
  return undefined;
}

export const LEASE_LAPSED_CODE = "datastore_v3_lease_lapsed";

export const COMMIT_MAY_LAND_CODE = "datastore_v3_commit_may_land";

/**
 * a failure that can say what went wrong without saying what the datastore
 * holds, for a message whose outcome is stated elsewhere
 */
export interface ReasonWithoutOutcome {
  readonly reasonWithoutOutcome: string;
}

function reasonOf(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    const own = (current as Partial<ReasonWithoutOutcome> | undefined)
      ?.reasonWithoutOutcome;
    if (typeof own === "string") return own;
    if (!(current instanceof Error)) break;
    current = current.cause;
  }
  return messageOf(error);
}

function asSentence(text: string): string {
  const trimmed = text.trim().replace(/\.+$/, "");
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/**
 * the commit outbox could be neither cleared nor marked, so the change may
 * already be in the datastore or be landed by the next writer; rerunning
 * blindly could make it twice
 */
export class MayLandLaterError extends UnrecordedEndError {
  constructor(cause: unknown, readonly reason: unknown) {
    const why = cause === undefined ? undefined : reasonOf(cause);
    const unrecorded = reasonOf(reason);
    const failed = why === undefined ? "" : `${asSentence(why)}. `;
    const because = why !== undefined && unrecorded === why
      ? ", for the same reason,"
      : ` (${unrecorded.trim().replace(/\.+$/, "")}),`;
    super(
      `${failed}Swamp could not record that this change must not be ` +
        `committed${because} so it may already be in the v3 datastore, or ` +
        `be committed by the next swamp command that writes; a command ` +
        `that only reads does not commit it. Check the datastore before ` +
        `running this command again.`,
      COMMIT_MAY_LAND_CODE,
    );
    this.name = "MayLandLaterError";
    if (cause !== undefined) this.cause = cause;
  }

  during(failure: unknown): MayLandLaterError {
    return new MayLandLaterError(failure, this.reason);
  }
}

export const COMMIT_UNREACHABLE_CODE = "datastore_v3_commit_unreachable";

/** the storage refused access, which a retry will not fix: exits 1, not 75 */
export const COMMIT_STORAGE_UNREADABLE_CODE =
  "datastore_v3_commit_storage_unreadable";

/** the lead of a storage failure's message: refused access, or unreachable */
function storageFailureLead(cause: unknown, denied: boolean): string {
  return denied
    ? `The datastore's storage could not be read (${messageOf(cause)})`
    : `Swamp could not reach the datastore's storage (${messageOf(cause)})`;
}

/**
 * part of the change is committed, so unlike COMMIT_UNREACHABLE_CODE it is not
 * a temporary failure
 */
export const COMMIT_PARTLY_COMMITTED_CODE =
  "datastore_v3_commit_partly_committed";

interface CommitUnreachableWording {
  /** the storage refused access rather than being unreachable */
  readonly denied?: boolean;
  readonly stepsRan?: boolean;
  readonly partly?: boolean;
  readonly failure?: unknown;
}

/**
 * nothing of the commit landed or can later, so rerunning is safe; but if an
 * earlier commit of the unit landed (partly-committed code), check what changed
 * first, as a re-run can meet what landed
 */
export class CommitUnreachableError extends UserError {
  readonly #wording: CommitUnreachableWording;

  constructor(
    cause: unknown,
    options: CommitUnreachableWording = {},
  ) {
    const failed = options.failure === undefined
      ? ""
      : `The command had also failed: ${messageOf(options.failure)}. `;
    const steps = options.stepsRan === true
      ? "Its steps had already run, so check anything they changed outside " +
        "swamp"
      : "";
    const denied = options.denied === true;
    const usable = denied
      ? "the datastore's permissions are fixed"
      : "the datastore is reachable";
    const recheck = options.partly === true
      ? `${
        steps === "" ? "Check" : `${steps}, and check`
      } what it changed in the datastore once ${usable} before ` +
        "running it again."
      : steps === ""
      ? `Run it again once ${usable}.`
      : `${steps} before running it again once ${usable}.`;
    const outcome = options.partly === true
      ? "so the rest of this command's changes were not committed; part of " +
        "what this command changed was committed before that and stays " +
        "committed"
      : "so nothing this command changed was committed";
    super(
      `${storageFailureLead(cause, denied)}, ${outcome}. ${failed}${recheck}`,
      denied
        ? COMMIT_STORAGE_UNREADABLE_CODE
        : options.partly === true
        ? COMMIT_PARTLY_COMMITTED_CODE
        : COMMIT_UNREACHABLE_CODE,
    );
    this.name = "CommitUnreachableError";
    this.cause = cause;
    this.#wording = options;
  }

  afterStepsRan(): CommitUnreachableError {
    return new CommitUnreachableError(this.cause, {
      ...this.#wording,
      stepsRan: true,
    });
  }

  during(failure: unknown): CommitUnreachableError {
    return new CommitUnreachableError(this.cause, {
      ...this.#wording,
      failure,
    });
  }
}

/**
 * a direct append that did not land after its bounded retry; refused when the
 * datastore refused it rather than being unreachable
 */
export class AppendUnrecordedError extends Error {
  constructor(cause: unknown, readonly refused: boolean) {
    super(
      `${refused ? "The datastore refused" : "Swamp could not reach"} a ` +
        `commit: ${messageOf(cause)}`,
    );
    this.name = "AppendUnrecordedError";
    this.cause = cause;
  }
}

export const RUN_PARTLY_COMMITTED_CODE = "datastore_v3_run_partly_committed";

export interface PartlyCommittedRun {
  readonly workflowId: string;
  readonly runId: string;
  /**
   * the steps workflow recover would find in flight, re-run only with
   * --acknowledge-unknown; undefined when not known
   */
  readonly unknownSteps?: readonly string[];
}

export function withRunUnknownSteps(
  error: unknown,
  unknownSteps: (runId: string) => readonly string[] | undefined,
): unknown {
  return error instanceof RunPartlyCommittedError
    ? error.withUnknownSteps((run) => unknownSteps(run.runId))
    : error;
}

export function recoveryNeedsAcknowledgement(run: PartlyCommittedRun): boolean {
  return (run.unknownSteps?.length ?? 0) > 0;
}

interface RunPartlyCommittedWording {
  /** the storage refused access rather than being unreachable */
  readonly denied?: boolean;
  readonly stepsRan?: boolean;
  readonly failure?: unknown;
}

/**
 * each run's last-checkpoint record is committed in this checkout's log,
 * leaving it running; workflow recover there carries it to the datastore.
 * Rerunning the command would start another run
 */
export class RunPartlyCommittedError extends UserError {
  readonly #wording: RunPartlyCommittedWording;

  constructor(
    cause: unknown,
    readonly runs: readonly PartlyCommittedRun[],
    options: RunPartlyCommittedWording = {},
  ) {
    if (runs.length === 0) {
      throw new Error("RunPartlyCommittedError needs at least one run");
    }
    const failed = options.failure === undefined
      ? ""
      : `The command had also failed: ${messageOf(options.failure)}. `;
    const one = runs.length === 1;
    const steps = options.stepsRan === true
      ? `${one ? "Its" : "Their"} steps had already run; check what they ` +
        "changed outside swamp. "
      : "";
    // a step in flight when the run was cut is re-run by the recovery only once
    // acknowledged; said after the command because serve shortens a long
    // message for its clients
    const inFlight = runs.filter(recoveryNeedsAcknowledgement).map((run) => {
      const names = run.unknownSteps!;
      const several = names.length > 1;
      return ` Before that, check what ${several ? "steps" : "step"} ` +
        `${names.join(", ")} of run ${run.runId} did outside swamp: ` +
        `${several ? "they were" : "it was"} running when the run was cut ` +
        `off, and the recovery runs ${several ? "them" : "it"} again.`;
    }).join("");
    const recover = runs.map((run) =>
      `swamp workflow recover ${run.workflowId} --run ${run.runId}` +
      (recoveryNeedsAcknowledgement(run) ? " --acknowledge-unknown" : "")
    ).join("; ");
    super(
      `${storageFailureLead(cause, options.denied === true)}, ` +
        `so this command's end was not committed; ${
          one ? "a workflow run" : `${runs.length} workflow runs`
        } committed up to ${one ? "its" : "their"} last checkpoint in this ` +
        `checkout and ${one ? "is" : "are"} left running. ${failed}${steps}` +
        `With the datastore ${
          options.denied === true ? "readable again" : "reachable"
        }, run ${recover} in this checkout to ` +
        `settle ${one ? "it" : "them"} and send that progress to the ` +
        `datastore.${inFlight}`,
      RUN_PARTLY_COMMITTED_CODE,
    );
    this.name = "RunPartlyCommittedError";
    this.cause = cause;
    this.#wording = options;
  }

  withUnknownSteps(
    unknownSteps: (run: PartlyCommittedRun) => readonly string[] | undefined,
  ): RunPartlyCommittedError {
    const runs = this.runs.map((run) => {
      const steps = unknownSteps(run);
      return steps === undefined ? run : { ...run, unknownSteps: steps };
    });
    return new RunPartlyCommittedError(this.cause, runs, this.#wording);
  }

  afterStepsRan(): RunPartlyCommittedError {
    return new RunPartlyCommittedError(this.cause, this.runs, {
      ...this.#wording,
      stepsRan: true,
    });
  }

  during(failure: unknown): RunPartlyCommittedError {
    return new RunPartlyCommittedError(this.cause, this.runs, {
      ...this.#wording,
      failure,
    });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
