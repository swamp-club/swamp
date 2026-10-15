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
 * Lands what a dead writer left in the commit outbox (swamp-club#3490). Runs
 * under a writer hold, before the interrupted-writer recovery
 * (swamp-club#3299), which then keeps the files the landed commits own and
 * removes the rest.
 *
 * For each entry {@link planOutboxRecovery} keeps, in preparation order:
 *
 * - its txnId already landed (the writer died before settling): the chunk
 *   check runs again and the entry settles;
 * - the partition head is still the entry's base: its commit is rebuilt at
 *   the head under this writer's fence and identity, after a check that its
 *   chunks are present, and appended;
 * - otherwise the partition moved on, and the entry is dropped: landing it
 *   now could overwrite what was committed since.
 *
 * A refusal drops the entry; with either, the unit's run entries go too
 * (decision 7). Each drop is logged once. The floor then rises to this
 * writer's fence. Entries of a writer that may still be running are left
 * for it.
 *
 * @module
 */

import { SOLO_NAMESPACE } from "../../domain/data/namespace.ts";
import type { Namespace } from "../../domain/data/namespace.ts";
import type { BlobRef } from "../../domain/datastore_v3/blob_ref.ts";
import type { ChunkStore } from "../../domain/datastore_v3/chunk_store.ts";
import { Commit, type CommitWriter } from "../../domain/datastore_v3/commit.ts";
import {
  type CommitOutbox,
  decideFenceChain,
  dropsAfterRefusal,
  type OutboxDrop,
  type OutboxDropReason,
  type OutboxEntry,
  outboxKeyOf,
  planOutboxRecovery,
  sameHead,
} from "../../domain/datastore_v3/commit_outbox.ts";
import { CommitRejectedError } from "../../domain/datastore_v3/partition.ts";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import { getSwampLogger } from "../logging/logger.ts";
import { isProcessGone } from "../runtime/process.ts";
import type { SqliteCommitStore } from "./sqlite_commit_store.ts";

const logger = getSwampLogger(["datastore", "v3"]);

/** What {@link recoverCommitOutbox} works over: a v3 datastore handle's parts. */
export interface OutboxRecoveryTarget {
  readonly outbox: CommitOutbox & { readonly path: string };
  readonly commitStore: Pick<
    SqliteCommitStore,
    "append" | "headIdentity" | "landedSeq"
  >;
  readonly chunkStore: Pick<ChunkStore, "missing">;
}

/** Options for {@link recoverCommitOutbox}. */
export interface RecoverCommitOutboxOptions {
  /** The fence of the writer lease this process holds. */
  readonly fence: number;
  /** Who lands the recovered commits: this process's writer identity. */
  readonly writer: CommitWriter;
  /**
   * Whether an entry's writer may still be running; by default this
   * process's own writers, and processes on this host that are not gone.
   */
  readonly writerAlive?: (writer: CommitWriter) => boolean;
  readonly clock?: () => Date;
  readonly signal?: AbortSignal;
}

/** What {@link recoverCommitOutbox} did. */
export interface OutboxRecoveryReport {
  /** Entries whose commit was appended now. */
  readonly landed: number;
  /** Entries whose commit had landed before its writer died. */
  readonly settled: number;
  /** Entries of writers that may still be running, left alone. */
  readonly skipped: number;
  readonly drops: readonly OutboxDrop[];
}

/**
 * The outbox could not be opened or read. It holds commits of a writer that
 * died; deleting the file gives them up.
 */
export class CommitOutboxUnreadableError extends UserError {
  constructor(path: string, cause: unknown) {
    super(
      `The v3 commit outbox at ${path} cannot be read: ${
        cause instanceof Error ? cause.message : String(cause)
      }. It holds commits a swamp process prepared and may not have landed. ` +
        `Fix the cause and run the command again, or delete ${path} to give ` +
        `those commits up; nothing else is lost.`,
    );
    this.name = "CommitOutboxUnreadableError";
    this.cause = cause;
  }
}

/**
 * The writers created by this process's handles (`processCommitWriter`),
 * by instance: their entries belong to units that may still be running.
 */
const ownInstances = new Set<string>();

/** Records a writer identity this process commits under. */
export function registerOwnCommitWriter(writer: CommitWriter): void {
  ownInstances.add(writer.instance);
}

/**
 * Whether `writer` may still be running: one of this process's, or a
 * process on this host that is not gone. A process on this host with this
 * process's pid but another instance is a predecessor (a restarted
 * container) and is gone. A process on another host whose lease expired is
 * taken as gone: the lease was taken over from it.
 */
export function defaultWriterAlive(writer: CommitWriter): boolean {
  if (ownInstances.has(writer.instance)) return true;
  if (writer.host !== Deno.hostname()) return false;
  if (writer.pid === Deno.pid) return false;
  return !isProcessGone(writer.pid);
}

/**
 * Lands, settles or drops each entry of the outbox, as the module doc
 * describes. Run it holding the writer lease at `options.fence`, after the
 * fence was recorded in the outbox's chain.
 *
 * @throws CommitOutboxUnreadableError when the outbox cannot be read
 * @throws WriterFencedError when the lease is lost meanwhile; what was
 *   landed or dropped so far stays so, the rest is left for the next writer
 */
export async function recoverCommitOutbox(
  target: OutboxRecoveryTarget,
  options: RecoverCommitOutboxOptions,
): Promise<OutboxRecoveryReport> {
  const { outbox } = target;
  const clock = options.clock ?? (() => new Date());
  const signal = options.signal ?? new AbortController().signal;
  let listing: Awaited<ReturnType<CommitOutbox["entries"]>>;
  let chain;
  try {
    if (!await outbox.hasEntries()) return emptyReport();
    listing = await outbox.entries();
    chain = await outbox.chain() ?? decideFenceChain(undefined, options.fence);
  } catch (error) {
    throw markErrorPaths(new CommitOutboxUnreadableError(outbox.path, error), [
      outbox.path,
    ]);
  }
  const drops: OutboxDrop[] = [];
  for (const { key, detail } of listing.unreadable) {
    await outbox.remove([key]);
    logger
      .warn`Dropped an unreadable v3 commit outbox entry for partition ${key.partition}: ${detail}`;
  }
  const plan = planOutboxRecovery(listing.entries, {
    chain,
    now: clock().getTime(),
    writerAlive: options.writerAlive ?? defaultWriterAlive,
  });
  const drop = async (
    entry: OutboxEntry,
    reason: OutboxDropReason,
    detail?: string,
  ) => {
    await outbox.remove([outboxKeyOf(entry.commit)]);
    const recorded: OutboxDrop = detail === undefined
      ? { entry, reason }
      : { entry, reason, detail };
    drops.push(recorded);
    reportDrop(recorded);
  };
  for (const planned of plan.drops) {
    await drop(planned.entry, planned.reason, planned.detail);
  }

  let landed = 0;
  let settled = 0;
  let remaining = [...plan.sends];
  while (remaining.length > 0) {
    signal.throwIfAborted();
    const [entry, ...rest] = remaining;
    remaining = rest;
    const { commit } = entry;
    const outcome = await recoverEntry(target, entry, options, clock, signal);
    if (outcome.kind !== "dropped") {
      if (outcome.kind === "landed") landed++;
      else settled++;
      await outbox.remove([outboxKeyOf(commit)]);
      continue;
    }
    await drop(entry, outcome.reason, outcome.detail);
    const withIt = dropsAfterRefusal(entry, remaining);
    remaining = remaining.filter((other) => !withIt.includes(other));
    for (const other of withIt) await drop(other, "unit-dropped");
  }
  await outbox.raiseFloor(options.fence);
  if (landed + settled > 0) {
    logger
      .info`Landed ${landed} v3 commits a swamp process prepared before it ended, and settled ${settled} that had landed`;
  }
  return { landed, settled, skipped: plan.skipped.length, drops };
}

type EntryOutcome =
  | { readonly kind: "landed" | "settled" }
  | {
    readonly kind: "dropped";
    readonly reason: OutboxDropReason;
    readonly detail?: string;
  };

async function recoverEntry(
  target: OutboxRecoveryTarget,
  entry: OutboxEntry,
  options: RecoverCommitOutboxOptions,
  clock: () => Date,
  signal: AbortSignal,
): Promise<EntryOutcome> {
  const { commitStore, chunkStore } = target;
  const { commit } = entry;
  const namespace = commit.namespace as Namespace;
  if (
    await commitStore.landedSeq(
      commit.namespace,
      commit.partition,
      commit.txnId,
    ) !==
      undefined
  ) {
    // It landed before its writer died: run the check it never ran.
    await warnMissingChunks(chunkStore, namespace, commit, signal);
    return { kind: "settled" };
  }
  const head = await commitStore.headIdentity(
    commit.namespace,
    commit.partition,
  );
  if (!sameHead(entry.base, head)) {
    return { kind: "dropped", reason: "head-moved" };
  }
  // Its content cannot be stored again, so a commit naming a missing chunk
  // never lands; the outbox kept its chunks from sweeps, so this is damage.
  const missing = await missingChunks(chunkStore, namespace, commit, signal);
  if (missing.length > 0) {
    return {
      kind: "dropped",
      reason: "missing-chunk",
      detail: `chunk ${missing[0]} is missing`,
    };
  }
  let rebuilt: Commit;
  try {
    rebuilt = Commit.create({
      seq: head.seq + 1,
      partition: commit.partition,
      namespace: commit.namespace,
      txnId: commit.txnId,
      writer: options.writer,
      ...(commit.executedAt !== undefined
        ? { executedAt: commit.executedAt }
        : {}),
      ...(commit.principal !== undefined
        ? { principal: commit.principal }
        : {}),
      fence: options.fence,
      at: clock().toISOString(),
      ops: commit.ops,
    });
  } catch (error) {
    return { kind: "dropped", reason: "unreadable", detail: messageOf(error) };
  }
  try {
    await commitStore.append(rebuilt);
  } catch (error) {
    if (error instanceof CommitRejectedError) {
      return { kind: "dropped", reason: "refused", detail: error.message };
    }
    throw error;
  }
  await warnMissingChunks(chunkStore, namespace, commit, signal);
  return { kind: "landed" };
}

function blobsOf(commit: Commit): BlobRef[] {
  const blobs: BlobRef[] = [];
  for (const op of commit.ops) {
    if (op.kind === "put" && "blob" in op.content) blobs.push(op.content.blob);
  }
  return blobs;
}

async function missingChunks(
  chunkStore: Pick<ChunkStore, "missing">,
  namespace: Namespace,
  commit: Commit,
  signal: AbortSignal,
): Promise<string[]> {
  const missing: string[] = [];
  for (const blob of blobsOf(commit)) {
    const gone = await chunkStore.missing(
      namespace || SOLO_NAMESPACE,
      blob,
      signal,
    );
    for (const sha256 of gone) missing.push(sha256);
  }
  return missing;
}

/**
 * The post-commit check for a commit that has landed. Nothing can store a
 * missing chunk again (its writer is gone), so it is reported.
 */
async function warnMissingChunks(
  chunkStore: Pick<ChunkStore, "missing">,
  namespace: Namespace,
  commit: Commit,
  signal: AbortSignal,
): Promise<void> {
  const missing = await missingChunks(chunkStore, namespace, commit, signal);
  if (missing.length === 0) return;
  logger
    .warn`Commit ${commit.seq} of v3 partition ${commit.partition.toString()} names chunk ${
    missing[0]
  }, which is missing; reads of that content will fail`;
}

const REASONS: Record<OutboxDropReason, string> = {
  "stale-fence": "another writer took the datastore after it was prepared",
  "overtaken": "its writer had lost the datastore's writer lease",
  "expired": "it is older than the retry bound",
  "unit-dropped":
    "it is a workflow run record of a unit whose other changes were dropped",
  "head-moved": "the partition was written since",
  "refused": "the commit store refused it",
  "missing-chunk": "content it names is missing",
  "unreadable": "it could not be rebuilt",
};

function reportDrop(drop: OutboxDrop): void {
  const { commit } = drop.entry;
  const detail = drop.detail === undefined ? "" : ` (${drop.detail})`;
  logger
    .warn`Dropped a v3 commit to partition ${commit.partition.toString()} that swamp process ${commit.writer.pid} on ${commit.writer.host} prepared but did not land: ${
    REASONS[drop.reason]
  }${detail}. Its changes are not in the datastore`;
}

function emptyReport(): OutboxRecoveryReport {
  return { landed: 0, settled: 0, skipped: 0, drops: [] };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
