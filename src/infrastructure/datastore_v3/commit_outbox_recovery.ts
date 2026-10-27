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
 * An entry its unit abandoned is dropped quietly: the unit reported its
 * failure. One whose txnId landed already settles, whatever drop reason it
 * would otherwise meet (swamp-club#3586). For each entry
 * {@link planOutboxRecovery} keeps, in preparation order:
 *
 * - its txnId already landed (the writer died before settling): the chunk
 *   check runs again and the entry settles;
 * - the partition head is still the entry's base: its commit is rebuilt at
 *   the head under this writer's fence and identity, after a check that its
 *   chunks are present and the chunk barrier over them (swamp-club#3617),
 *   and appended;
 * - otherwise the partition moved on, and the entry is dropped: landing it
 *   now could overwrite what was committed since.
 *
 * A refusal drops the entry; with either, the unit's run entries go too
 * (decision 7). Each drop is logged once. Entries of a writer that may
 * still be running are left for it, and marked so: the floor, which then
 * rises to this writer's fence, does not drop them (swamp-club#3564), and a
 * later recovery lands them once their writer is gone.
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
import {
  judgeRecordedProcess,
  type LocalProcess,
  type ProcessIdentity,
} from "../../domain/datastore_v3/process_liveness.ts";
import { localProcess } from "./process_identity.ts";
import type { SqliteCommitStore } from "./sqlite_commit_store.ts";

const logger = getSwampLogger(["datastore", "v3"]);

/** What {@link recoverCommitOutbox} works over: a v3 datastore handle's parts. */
export interface OutboxRecoveryTarget {
  readonly outbox: CommitOutbox & { readonly path: string };
  readonly commitStore: Pick<
    SqliteCommitStore,
    "append" | "headIdentity" | "landedSeq"
  >;
  readonly chunkStore: Pick<ChunkStore, "missing" | "syncStored">;
}

/** Options for {@link recoverCommitOutbox}. */
export interface RecoverCommitOutboxOptions {
  /** The fence of the writer lease this process holds. */
  readonly fence: number;
  /** Who lands the recovered commits: this process's writer identity. */
  readonly writer: CommitWriter;
  /**
   * Whether an entry's writer may still be running; by default this
   * process's own writers, and processes judged alive by the identity they
   * prepared it under.
   */
  readonly writerAlive?: (
    writer: CommitWriter,
    process: ProcessIdentity | undefined,
  ) => boolean;
  readonly clock?: () => Date;
  readonly signal?: AbortSignal;
  /**
   * How many times an entry is built again on a moved head before it is
   * dropped, for a target whose appends go to serve (swamp-club#3985). Serve
   * judges each commit against its own log, so an entry whose base moved is
   * sent on the new head rather than dropped as `head-moved`. Absent for a
   * local commit store, whose moved head drops the entry.
   */
  readonly forwardedAttempts?: number;
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
 * Whether `writer`, which prepared an entry under `process`, may still be
 * running, judged from `local`: one of this process's, or a process judged
 * alive (swamp-club#3564). A process with this process's pid but another
 * instance is a predecessor (a restarted container) and is gone. One this
 * process cannot judge (another host, namespace or boot, or an entry from a
 * swamp before identities) is taken as gone: the recovery runs under a
 * newer lease, so that writer is fenced already.
 */
export function writerAliveFrom(
  local: LocalProcess,
): (writer: CommitWriter, process: ProcessIdentity | undefined) => boolean {
  return (writer, process) => {
    if (ownInstances.has(writer.instance)) return true;
    return judgeRecordedProcess(
      {
        pid: writer.pid,
        ...(process !== undefined ? { process } : {}),
        notThisProcess: true,
      },
      local,
    ) === "alive";
  };
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
    if (!await outbox.hasEntries()) {
      // The floor rises with every completed recovery, an empty one too: an
      // entry a writer that lost the lease prepares after it is overtaken.
      await outbox.raiseFloor(options.fence);
      return emptyReport();
    }
    listing = await outbox.entries();
    chain = await outbox.chain() ?? decideFenceChain(undefined, options.fence);
  } catch (error) {
    throw markErrorPaths(new CommitOutboxUnreadableError(outbox.path, error), [
      outbox.path,
    ]);
  }
  const drops: OutboxDrop[] = [];
  // An unreadable entry names no writer to judge; under the lease, only this
  // process's own units could still be using one, and theirs parse.
  for (const { key, detail } of listing.unreadable) {
    await outbox.discard([key]);
    logger
      .warn`Dropped an unreadable v3 commit outbox entry for partition ${key.partition}: ${detail}`;
  }
  // Read before judging: a landed entry settles, never drops (swamp-club#3586).
  const landedKeys = new Set<OutboxEntry>();
  for (const entry of listing.entries) {
    if (entry.abandonedAt !== undefined) continue;
    const { commit } = entry;
    if (
      await target.commitStore.landedSeq(
        commit.namespace,
        commit.partition,
        commit.txnId,
      ) !== undefined
    ) {
      landedKeys.add(entry);
    }
  }
  const plan = planOutboxRecovery(listing.entries, {
    chain,
    now: clock().getTime(),
    writerAlive: options.writerAlive ?? writerAliveFrom(await localProcess()),
    landed: (entry) => landedKeys.has(entry),
  });
  // Left before anything lands and before the floor rises past them: a
  // writer that prepares one again from now on clears its mark, so a later
  // floor drops it as any entry prepared after a recovery.
  await outbox.markLeft(
    plan.skipped.map((entry) => outboxKeyOf(entry.commit)),
    options.fence,
  );
  const drop = async (
    entry: OutboxEntry,
    reason: OutboxDropReason,
    detail?: string,
    uncertain = false,
  ) => {
    // A drop is reported, so it is fsynced: a run entry whose drop a power
    // cut undid could land after its unit's dropped data commit.
    await outbox.discard([outboxKeyOf(entry.commit)]);
    const recorded: OutboxDrop = {
      entry,
      reason,
      ...(detail !== undefined ? { detail } : {}),
      ...(uncertain ? { uncertain } : {}),
    };
    drops.push(recorded);
    reportDrop(recorded);
  };
  let landed = 0;
  let settled = 0;
  for (const entry of plan.settles) {
    // It landed before its writer died: run the check it never ran.
    await warnMissingChunks(
      target.chunkStore,
      entry.commit.namespace as Namespace,
      entry.commit,
      signal,
    );
    await outbox.settle([outboxKeyOf(entry.commit)]);
    settled++;
  }
  for (const planned of plan.drops) {
    await drop(
      planned.entry,
      planned.reason,
      planned.detail,
      planned.uncertain === true,
    );
  }

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
      await outbox.settle([outboxKeyOf(commit)]);
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
  if (
    options.forwardedAttempts === undefined && !sameHead(entry.base, head)
  ) {
    return { kind: "dropped", reason: "head-moved" };
  }
  // Its content cannot be stored again, so a commit naming a missing chunk
  // never lands; the outbox kept its chunks from sweeps, so this is damage.
  // On a storage that reads sizes, a chunk a crash left short (torn) is
  // missing too (swamp-club#3617).
  const missing = await missingChunks(chunkStore, namespace, commit, signal);
  if (missing.length > 0) {
    return {
      kind: "dropped",
      reason: "missing-chunk",
      detail: `chunk ${missing[0]} is missing or damaged`,
    };
  }
  // The chunk barrier (swamp-club#3617): a swamp from before it prepared
  // entries with its chunks' renames perhaps still in the page cache, so
  // their names are made durable before the commit naming them lands. A
  // failed barrier leaves the entry for the next recovery.
  await chunkStore.syncStored(
    namespace || SOLO_NAMESPACE,
    [...new Set(blobsOf(commit).flatMap((blob) => blob.chunkHashes()))],
    signal,
  );
  const build = (seq: number): Commit =>
    Commit.create({
      seq,
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
  let rebuilt: Commit;
  try {
    rebuilt = build(head.seq + 1);
  } catch (error) {
    return { kind: "dropped", reason: "unreadable", detail: messageOf(error) };
  }
  for (let attempt = 1;; attempt++) {
    try {
      await commitStore.append(rebuilt);
      break;
    } catch (error) {
      // Serve's head moved past the one the entry was rebuilt on: the
      // target caught up, so build it again on the new head.
      if (
        options.forwardedAttempts !== undefined &&
        attempt < options.forwardedAttempts &&
        error instanceof CommitRejectedError && error.reason === "seq-gap"
      ) {
        const moved = await commitStore.headIdentity(
          commit.namespace,
          commit.partition,
        );
        rebuilt = build(moved.seq + 1);
        continue;
      }
      if (error instanceof CommitRejectedError) {
        return { kind: "dropped", reason: "refused", detail: error.message };
      }
      throw error;
    }
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
 * missing chunk again (its writer is gone), so it is reported; a check that
 * fails is reported too, and never fails the recovery (swamp-club#3586).
 */
async function warnMissingChunks(
  chunkStore: Pick<ChunkStore, "missing">,
  namespace: Namespace,
  commit: Commit,
  signal: AbortSignal,
): Promise<void> {
  let missing: string[];
  try {
    missing = await missingChunks(chunkStore, namespace, commit, signal);
  } catch (error) {
    logger
      .warn`Checking the content v3 commit ${commit.seq} of partition ${commit.partition.toString()} names failed; reads of that content may fail: ${error}`;
    return;
  }
  if (missing.length === 0) return;
  logger
    .warn`Commit ${commit.seq} of v3 partition ${commit.partition.toString()} names chunk ${
    missing[0]
  }, which is missing or damaged; reads of that content will fail`;
}

const REASONS: Record<OutboxDropReason, string> = {
  "abandoned": "its command gave it up and reported the failure",
  "stale-fence":
    "another writer may have taken the datastore after it was prepared",
  "overtaken": "its writer had lost the datastore's writer lease",
  "expired": "it is older than the retry bound",
  "unit-dropped":
    "it is a workflow run record of a unit whose other changes were dropped",
  "head-moved": "the partition was written since",
  "refused": "the commit store refused it",
  "missing-chunk": "content it names is missing or damaged",
  "unreadable": "it could not be rebuilt",
};

function reportDrop(drop: OutboxDrop): void {
  const { commit } = drop.entry;
  if (drop.reason === "abandoned") {
    // Its failure was reported when its command ended.
    logger
      .debug`Dropped an abandoned v3 commit outbox entry for partition ${commit.partition.toString()}`;
    return;
  }
  const detail = drop.detail === undefined ? "" : ` (${drop.detail})`;
  if (drop.uncertain === true) {
    logger
      .warn`Dropped a v3 commit to partition ${commit.partition.toString()} that swamp process ${commit.writer.pid} on ${commit.writer.host} prepared: ${
      REASONS[drop.reason]
    }${detail}. Its record of landing has been pruned, so its changes may or may not be in the datastore`;
    return;
  }
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
