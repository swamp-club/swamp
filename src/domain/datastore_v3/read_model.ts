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

/**
 * the read model is a cache of the commits: it can be rebuilt at any time, and
 * applying a commit twice changes nothing; it is per checkout, catching up from
 * its own cursor
 */

import { UserError } from "../errors.ts";
import { UNREADABLE_CONTENT_CODE } from "../datastore/unreadable_content.ts";
import type { BlobRef } from "./blob_ref.ts";
import type { PartitionKey } from "./partition_key.ts";
import type { RecordKey } from "./record_key.ts";

export interface CatchUpResult {
  readonly applied: number;
  readonly cursor: number;
}

export type LiveRecordContent =
  | { readonly kind: "inline" }
  | { readonly kind: "blob"; readonly blob: BlobRef };

export interface LiveRecord {
  readonly key: RecordKey;
  readonly sha256: string;
  readonly content: LiveRecordContent;
}

/**
 * the cursor stays before the commit so the next catch-up retries it; a key the
 * read model must not write, and a file and directory claiming one path, are
 * permanent: logged, skipped and still indexed
 */
export class ReadModelApplyError extends Error {
  constructor(
    readonly namespace: string,
    readonly partition: string,
    readonly seq: number,
    readonly detail: string,
    options?: ErrorOptions,
  ) {
    super(
      `Cannot apply commit ${seq} of partition ${partition}${
        namespace === "" ? "" : ` in namespace ${namespace}`
      } to the read model: ${detail}`,
      options,
    );
    this.name = "ReadModelApplyError";
  }
}

export const CATCH_UP_UNREACHABLE_CODE = "datastore_v3_catch_up_unreachable";

/**
 * nothing was changed: commits before a failed one stay applied and the cursor
 * stays before it, and the next command finishes once the storage is reachable
 */
export class ReadModelCatchUpUnreachableError extends UserError {
  constructor(cause: Error) {
    super(
      `Swamp could not reach the datastore's storage while bringing this ` +
        `checkout up to date (${cause.message}), so nothing was changed. ` +
        `The next command finishes bringing it up to date once the ` +
        `datastore is reachable; run this one again then.`,
      CATCH_UP_UNREACHABLE_CODE,
    );
    this.name = "ReadModelCatchUpUnreachableError";
    this.cause = cause;
  }
}

/**
 * a checkout file holds the only copy of committed content whose chunks storage
 * refused to store, and can be neither moved nor copied aside; nothing was
 * overwritten and the section stops so the copy is not lost
 */
export class CheckoutCopyAtRiskError extends ReadModelApplyError {
  constructor(
    namespace: string,
    partition: string,
    seq: number,
    readonly path: string,
    reason: string,
    options?: ErrorOptions,
  ) {
    super(
      namespace,
      partition,
      seq,
      `${path} holds the only copy of committed content the datastore cannot store again, and it cannot be moved aside (${reason}); free space in the repository's .swamp directory or restore write access to the datastore, then run the command again`,
      options,
    );
    this.name = "CheckoutCopyAtRiskError";
  }
}

/**
 * its file is absent from the checkout; later commits still apply, and the read
 * model retries it when the chunk changes
 */
export interface UnreadableRecord {
  readonly namespace: string;
  readonly recordKey: string;
  readonly partition: string;
  readonly seq: number;
  readonly position: number;
  readonly blob?: BlobRef;
  readonly chunk?: string;
  readonly reason: "missing" | "damaged";
  readonly lastAttempt: Date;
}

/** a later section with put rights stores its chunks and deletes the file */
export interface AtRiskCopy {
  readonly namespace: string;
  readonly sha256: string;
  readonly recordKey: string;
  readonly size: number;
  readonly createdAt: Date;
  readonly lastAttempt: Date;
}

export const UNREADABLE_RECORD_CODE = UNREADABLE_CONTENT_CODE;

export function unreadableRecordAdvice(recordKey: string): string {
  const repaired =
    "A checkout that still holds the file stores its chunks again when it next runs a command; otherwise ";
  switch (recordKey.split("/")[0]) {
    case "data":
      return `${repaired}write that data again, or delete the version with \`swamp data delete\`.`;
    case "auto-definitions":
      return `${repaired}save the definition again.`;
    case "definitions-evaluated":
    case "workflows-evaluated":
      return `${repaired}evaluate the definition or workflow again.`;
    case "outputs":
    case "workflow-runs":
      return `${repaired}run the method or workflow again; data garbage collection removes the old record.`;
    case "config":
      return `${repaired}save that configuration again.`;
    default:
      return `${repaired}write the record again.`;
  }
}

/**
 * its file is absent because a chunk is missing or damaged, so reading it fails
 * loudly instead of reading as absent
 */
export class UnreadableRecordError extends UserError {
  constructor(readonly record: UnreadableRecord) {
    super(
      `The record ${record.recordKey} cannot be read: ${
        record.chunk === undefined
          ? "a chunk of its content"
          : `chunk ${record.chunk}`
      } is ${record.reason} in the datastore. ${
        unreadableRecordAdvice(record.recordKey)
      }`,
      UNREADABLE_RECORD_CODE,
    );
    this.name = "UnreadableRecordError";
  }
}

/**
 * The index is not complete yet: the read model has not caught up with the
 * whole change feed since it was built or last reset, so it may be missing
 * records. Run {@link ReadModel.catchUp} until it returns.
 */
export class ReadModelIncompleteError extends Error {
  constructor() {
    super(
      "The read model has not caught up with every commit since it was built or reset; catch up before reading its index",
    );
    this.name = "ReadModelIncompleteError";
  }
}

/** a temporary failure, so it exits 75 (EX_TEMPFAIL) as lock contention does */
export const READ_MODEL_BUSY_CODE = "datastore_v3_read_model_busy";

export class ReadModelBusyError extends UserError {
  constructor(waitedMs: number) {
    super(
      `Another swamp process is still bringing this checkout's files up to date with the v3 datastore, and it did not finish within ${
        Math.round(waitedMs / 1000)
      }s. Nothing was read. Run the command again once it has finished.`,
      READ_MODEL_BUSY_CODE,
    );
    this.name = "ReadModelBusyError";
  }
}

/**
 * an abort stops between commits or during a chunk read, leaving the cursor at
 * the last commit fully applied; waiting for another process's lock is not
 * abortable, as the OS lock has no abort hook
 */
export interface ReadModel {
  // until a catch-up completes the files may lag the state: a net replay
  // records puts a later commit replaces without writing them, so read files
  // only after a catch-up
  /**
   * a file a crash or power loss could still lose is repaired, never trusted:
   * the first open after a reboot checks files written since and applies every
   * commit again if one was lost
   */
  catchUp(signal: AbortSignal): Promise<CatchUpResult>;

  /**
   * the store-wide cursor does not move and a later catchUp skips these
   * commits; a key another partition also writes keeps the file of the latest
   * put in the feed, so this partition's record may not be the file
   */
  catchUpPartition(
    namespace: string,
    partition: PartitionKey,
    signal: AbortSignal,
  ): Promise<CatchUpResult>;

  /**
   * rejects until a catch-up has reached the end of the feed since the read
   * model was built or reset: until then a partition catch-up or cut-short
   * replay may have filled only part of the index
   */
  liveRecords(
    namespace: string,
    partition: PartitionKey,
  ): Promise<readonly LiveRecord[]>;

  /**
   * waits and rejects like liveRecords, so a partial index never reads as the
   * set of chunks to keep
   */
  chunksInUse(namespace: string): Promise<ReadonlySet<string>>;

  close(): Promise<void>;
}
