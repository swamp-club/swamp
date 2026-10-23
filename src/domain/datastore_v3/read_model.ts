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
 * The v3 read model port (swamp-club#3239): the local files, the v3 catalog
 * and the live-record index, brought up to date with the commit store.
 *
 * The read model is a cache of the commits: it can be rebuilt from them at
 * any time, and applying a commit a second time changes nothing. It is
 * per checkout: each repository catches its own local files up from its own
 * cursor. Dormant: nothing in production uses it yet.
 *
 * @module
 */

import { UserError } from "../errors.ts";
import { UNREADABLE_CONTENT_CODE } from "../datastore/unreadable_content.ts";
import type { BlobRef } from "./blob_ref.ts";
import type { PartitionKey } from "./partition_key.ts";
import type { RecordKey } from "./record_key.ts";

/** What a catch-up applied. */
export interface CatchUpResult {
  /** How many commits it applied. Commits it skipped are not counted. */
  readonly applied: number;
  /** The store-wide cursor after it: the last change it applied or skipped. */
  readonly cursor: number;
}

/** Where a live record's content is: inline in its commit, or in chunks. */
export type LiveRecordContent =
  | { readonly kind: "inline" }
  | { readonly kind: "blob"; readonly blob: BlobRef };

/**
 * One record present in a partition, as the live-record index holds it.
 * Chunk garbage collection computes the chunks in use from these.
 */
export interface LiveRecord {
  readonly key: RecordKey;
  /** The SHA-256 of the record's bytes. */
  readonly sha256: string;
  readonly content: LiveRecordContent;
}

/**
 * A commit could not be applied: a put's blob still lives in a pre-v3
 * layout, a write failed, or, for a commit already compacted away, a chunk
 * it names is missing or damaged (elsewhere such a put is an
 * {@link UnreadableRecord}, swamp-club#3617). The cursor
 * stays before the commit, so the next catch-up tries it again. A key the
 * read model must not write, and a file and a directory claiming one path,
 * are permanent instead: such a put is logged and skipped, and stays
 * indexed.
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

/** Error code for {@link ReadModelCatchUpUnreachableError}. */
export const CATCH_UP_UNREACHABLE_CODE = "datastore_v3_catch_up_unreachable";

/**
 * Bringing a checkout up to date could not reach the datastore's storage
 * (swamp-club#3802): to read a commit's content while the read model caught
 * up (`cause` is then the {@link ReadModelApplyError}; the commits before it
 * stay applied and the cursor stays before it), or to read the replica's
 * lineage while a reader made its copy current. Nothing was changed, and the
 * next command finishes once the storage is reachable.
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
 * A checkout file holds the only copy of committed content whose chunks the
 * storage refused to store again, and the file can be neither moved nor
 * copied aside into the read model's `at-risk` directory
 * (swamp-club#3617). Nothing was overwritten or removed; the section stops
 * so the copy is not lost.
 */
export class CheckoutCopyAtRiskError extends ReadModelApplyError {
  constructor(
    namespace: string,
    partition: string,
    seq: number,
    /** The checkout file kept in place. */
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
 * A record the read model could not materialise because a chunk its content
 * names is missing or damaged (swamp-club#3617). Its file is absent from the
 * checkout; later commits still apply, and the read model retries it when
 * the chunk changes.
 */
export interface UnreadableRecord {
  readonly namespace: string;
  /** The record key, a `/` path relative to the namespace's cache root. */
  readonly recordKey: string;
  /** The partition whose put it is. */
  readonly partition: string;
  /** The put's seq in its partition; 0 for a record of the compacted base. */
  readonly seq: number;
  /** The put's position in the change feed (its ownership mark). */
  readonly position: number;
  /** The content's reference. */
  readonly blob?: BlobRef;
  /** The first chunk found missing or damaged, when known. */
  readonly chunk?: string;
  /** `missing`: a chunk is absent or short. `damaged`: one fails its hash. */
  readonly reason: "missing" | "damaged";
  /** When the read model last tried to read it. */
  readonly lastAttempt: Date;
}

/**
 * A checkout file moved aside into the read model's `at-risk` directory
 * because it held the only copy of committed chunks the storage refused to
 * store (swamp-club#3617). A later section with put rights stores its chunks
 * and deletes it.
 */
export interface AtRiskCopy {
  readonly namespace: string;
  /** The whole file's SHA-256: its name in the at-risk directory. */
  readonly sha256: string;
  /** The record key the file was at; empty when unknown. */
  readonly recordKey: string;
  readonly size: number;
  readonly createdAt: Date;
  readonly lastAttempt: Date;
}

/** The error code of {@link UnreadableRecordError}. */
export const UNREADABLE_RECORD_CODE = UNREADABLE_CONTENT_CODE;

/**
 * How to repair or remove an unreadable record, by the kind its key names.
 * A checkout that still holds the file repairs it on its next command.
 */
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
 * A read of a record the read model could not materialise
 * (swamp-club#3617): its file is absent because a chunk is missing or
 * damaged, so reading it fails loudly instead of reading as absent.
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

/**
 * The read side of the commit log for one checkout.
 *
 * The catch-ups take an `AbortSignal`. An abort stops between commits, or
 * during a chunk read, and leaves the cursor at the last commit fully
 * applied. Waiting for another process to release the read model's lock is
 * not abortable: the OS lock has no abort hook.
 */
export interface ReadModel {
  /**
   * Applies every commit that landed after the stored cursor, in landing
   * order, a page of commits at a time, advancing the cursor after each
   * page's effects. A file a crash or power loss could still lose is
   * repaired, never trusted: the first open after a reboot checks the files
   * written since, and applies every commit again if one was lost. When it
   * reaches the end of the change feed, the index is complete.
   */
  catchUp(signal: AbortSignal): Promise<CatchUpResult>;

  /**
   * Applies one partition's commits after the last one this read model
   * applied, before a read of that partition. The store-wide cursor does not
   * move; a later {@link catchUp} skips the commits applied here. A record
   * key another partition also writes (a same-key definition rename) keeps
   * the file of the put latest in the change feed, so the partition's own
   * record may not be the file there (swamp-club#3256).
   */
  catchUpPartition(
    namespace: string,
    partition: PartitionKey,
    signal: AbortSignal,
  ): Promise<CatchUpResult>;

  /**
   * The records present in a partition, by key, once any catch-up in
   * progress has finished. Rejects with
   * {@link ReadModelIncompleteError} until a catch-up has reached the end of
   * the change feed since the read model was built or reset: until then a
   * partition catch-up or a replay cut short may have filled only part of
   * the index.
   */
  liveRecords(
    namespace: string,
    partition: PartitionKey,
  ): Promise<readonly LiveRecord[]>;

  /**
   * The SHA-256 of every chunk a live record's blob names in a namespace,
   * parts expanded: the chunks chunk garbage collection must keep. Waits
   * and rejects with {@link ReadModelIncompleteError} like
   * {@link liveRecords}, so a partial index never reads as the set to keep.
   */
  chunksInUse(namespace: string): Promise<ReadonlySet<string>>;

  /** Waits for a catch-up in progress, then closes. Closing again does nothing. */
  close(): Promise<void>;
}
