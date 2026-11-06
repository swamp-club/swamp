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
 * lands what a dead writer left in the outbox; an entry whose partition moved
 * on is dropped, since landing it could overwrite later commits; entries of a
 * writer that may still run are left, marked
 */

import {
  RUN_INITIATOR_MISMATCH_CODE,
  RUN_INITIATOR_MISMATCH_REASON,
} from "../../domain/datastore_v3/commit_authorization.ts";
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
import { ServeCommitRefusedError } from "./serve_upstream_errors.ts";
import { carryOfLanded } from "../../domain/datastore_v3/offline_rebase.ts";
import { flushOfflineEntries, type OfflineFlushPort } from "./offline_flush.ts";
import type { SqliteCommitStore } from "./sqlite_commit_store.ts";

const logger = getSwampLogger(["datastore", "v3"]);

export interface OutboxRecoveryTarget {
  readonly outbox: CommitOutbox & { readonly path: string };
  readonly commitStore:
    & Pick<SqliteCommitStore, "append" | "headIdentity" | "landedSeq">
    & {
      readonly appendUnderLease?: (
        commit: Commit,
        leaseId: string | undefined,
      ) => Promise<unknown>;
    };
  readonly chunkStore: Pick<ChunkStore, "missing" | "syncStored">;
  readonly offline?: OfflineFlushPort;
}

export interface RecoverCommitOutboxOptions {
  readonly fence: number;
  readonly writer: CommitWriter;
  readonly writerAlive?: (
    writer: CommitWriter,
    process: ProcessIdentity | undefined,
  ) => boolean;
  readonly clock?: () => Date;
  readonly signal?: AbortSignal;
  /**
   * an entry serve answers with a moved head is dropped, never built again on a
   * newer head, where a put or tombstone with no `expect` would overwrite a
   * newer record
   */
  readonly forwarded?: boolean;
}

/**
 * a caller's copy leaves out the commits it may not read, so a forwarded
 * entry's moved head is not always visible in it
 */
const FORWARDED_HEAD_MOVED =
  "serve's partition moved on since, possibly by commits this checkout " +
  "cannot read";

export interface OutboxRecoveryReport {
  readonly landed: number;
  readonly settled: number;
  readonly accepted?: number;
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

export function registerOwnCommitWriter(writer: CommitWriter): void {
  ownInstances.add(writer.instance);
}

/**
 * a writer this process cannot judge (another host, namespace or boot, or a
 * pre-identity entry) counts as gone, since recovery runs under a newer lease
 * and it is fenced already
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
  for (const { key, detail, state } of listing.unreadable) {
    // one queued offline, rejected or quarantined may be the only record of
    // what a run changed: kept, never dropped
    if (state !== undefined) {
      logger
        .warn`Kept an unreadable v3 commit outbox entry for partition ${key.partition} (${state}) in this checkout's outbox; it is not sent: ${detail}`;
      continue;
    }
    await outbox.discard([key]);
    logger
      .warn`Dropped an unreadable v3 commit outbox entry for partition ${key.partition}: ${detail}`;
  }
  // read before judging: a landed entry settles, never drops
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
  let accepted = 0;
  for (const entry of plan.settles) {
    await warnMissingChunks(
      target.chunkStore,
      entry.commit.namespace as Namespace,
      entry.commit,
      signal,
    );
    // an offline entry a cut-off flush landed is recorded as this checkout's
    // own, with what it renumbered, before it leaves the outbox, so the
    // partition's later entries follow it
    if (entry.state === "offline") {
      await recordLandedOffline(target.offline, entry, clock().getTime());
    }
    await outbox.settle([outboxKeyOf(entry.commit)]);
    if (entry.state === "quarantined") accepted++;
    else settled++;
  }
  const discarded = await settleDiscarded(target.offline, plan.held);
  for (const planned of plan.drops) {
    await drop(
      planned.entry,
      planned.reason,
      planned.detail,
      planned.uncertain === true,
    );
  }

  let remaining = [...plan.sends];
  let deferred = 0;
  // Partitions an entry was left in: later entries of one wait with it, as
  // they were prepared after it.
  const deferredPartitions = new Set<string>();
  while (remaining.length > 0) {
    signal.throwIfAborted();
    const [entry, ...rest] = remaining;
    remaining = rest;
    const { commit } = entry;
    const outcome = deferredPartitions.has(commit.partition.toString())
      ? { kind: "deferred" as const }
      : await recoverEntry(target, entry, options, clock, signal);
    if (outcome.kind === "rejected") {
      // kept with its code, and its partition waits with it, as a deferred
      // entry's does
      const withIt = dropsAfterRefusal(entry, remaining);
      remaining = remaining.filter((other) => !withIt.includes(other));
      deferredPartitions.add(commit.partition.toString());
      await outbox.markState(
        [outboxKeyOf(commit)],
        "rejected",
        outcome.reason,
        outcome.code,
      );
      if (withIt.length > 0) {
        await outbox.markLeft(
          withIt.map((left) => outboxKeyOf(left.commit)),
          options.fence,
        );
      }
      logger
        .warn`Serve refused a run record this checkout saved because it names another initiator; it is kept in this checkout's outbox. Run the work again: ${outcome.reason}`;
      continue;
    }
    if (outcome.kind === "deferred") {
      // Left for a later recovery, and marked so the floor never drops it.
      // Its unit's run entries wait with it: a run record never lands
      // without the data commit it names.
      const withIt = dropsAfterRefusal(entry, remaining);
      remaining = remaining.filter((other) => !withIt.includes(other));
      deferredPartitions.add(commit.partition.toString());
      for (const other of withIt) {
        deferredPartitions.add(other.commit.partition.toString());
      }
      await outbox.markLeft(
        [entry, ...withIt].map((left) => outboxKeyOf(left.commit)),
        options.fence,
      );
      deferred += 1 + withIt.length;
      continue;
    }
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
  // what the checkout queued while serve was unreachable goes last, once
  // everything else landed; never dropped, kept when it cannot land
  if (plan.offline.length > 0 && target.offline !== undefined) {
    await flushOfflineEntries(target.offline, plan.offline, {
      writer: options.writer,
      fence: options.fence,
      clock,
      signal,
    });
  }
  await outbox.raiseFloor(options.fence);
  if (landed + settled > 0) {
    logger
      .info`Landed ${landed} v3 commits a swamp process prepared before it ended, and settled ${settled} that had landed`;
  }
  if (accepted > 0) {
    logger
      .info`${accepted} change(s) this checkout kept quarantined were accepted at serve by an admin and have landed; they are no longer kept in this checkout's outbox`;
  }
  if (discarded > 0) {
    logger
      .info`${discarded} change(s) this checkout kept quarantined were discarded at serve by an admin; they stay in this checkout's outbox as rejected and are never sent`;
  }
  if (deferred > 0) {
    logger
      .info`Left ${deferred} v3 commits a swamp process prepared before it ended for a later recovery: another command's lease at serve covers their behavior now`;
  }
  return {
    landed,
    settled,
    accepted,
    skipped: plan.skipped.length + deferred + plan.held.length,
    drops,
  };
}

type EntryOutcome =
  | { readonly kind: "landed" | "settled" }
  | { readonly kind: "deferred" }
  | {
    readonly kind: "rejected";
    readonly reason: string;
    readonly code: string;
  }
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
    await warnMissingChunks(chunkStore, namespace, commit, signal);
    return { kind: "settled" };
  }
  const head = await commitStore.headIdentity(
    commit.namespace,
    commit.partition,
  );
  if (!sameHead(entry.base, head)) {
    return {
      kind: "dropped",
      reason: "head-moved",
      ...(options.forwarded === true ? { detail: FORWARDED_HEAD_MOVED } : {}),
    };
  }
  // its content cannot be stored again, so a commit naming a missing chunk
  // never lands; the outbox kept its chunks from sweeps, so this is damage; on
  // sized storage a torn chunk counts as missing
  const missing = await missingChunks(chunkStore, namespace, commit, signal);
  if (missing.length > 0) {
    return {
      kind: "dropped",
      reason: "missing-chunk",
      detail: `chunk ${missing[0]} is missing or damaged`,
    };
  }
  // chunk barrier: an older swamp may have prepared entries with chunk renames
  // still in the page cache, so their names are made durable before the commit
  // lands; a failed barrier leaves the entry for the next recovery
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
      ...(commit.clockOffsetMs !== undefined
        ? { clockOffsetMs: commit.clockOffsetMs }
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
  try {
    // A forwarded entry names the lease it was built under, or none: never
    // one this process holds now.
    if (options.forwarded === true && commitStore.appendUnderLease) {
      const send = commitStore.appendUnderLease;
      try {
        await send(rebuilt, entry.lease?.leaseId);
      } catch (error) {
        // The lease it was built under has ended, usually with the process
        // that held it. Its head has not moved, so nothing was written
        // since: it is sent again under no lease, which serve refuses only
        // while another holder's lease covers the partition.
        if (
          entry.lease === undefined ||
          !(error instanceof CommitRejectedError) ||
          error.reason !== "lease-lost"
        ) {
          throw error;
        }
        await send(rebuilt, undefined);
      }
    } else {
      await commitStore.append(rebuilt);
    }
  } catch (error) {
    // serve's head moved past the copy's: the entry is never built again on the
    // newer head
    if (
      options.forwarded === true &&
      error instanceof CommitRejectedError && error.reason === "seq-gap"
    ) {
      return {
        kind: "dropped",
        reason: "head-moved",
        detail: FORWARDED_HEAD_MOVED,
      };
    }
    // Sent under no lease, on a head that has not moved, it is refused only
    // while someone else's lease covers the partition: it is left for a
    // later recovery, never lost.
    if (
      error instanceof CommitRejectedError && error.reason === "lease-lost"
    ) {
      return { kind: "deferred" };
    }
    if (
      error instanceof CommitRejectedError && error.reason === "stale-lease"
    ) {
      return {
        kind: "dropped",
        reason: "lease-superseded",
        detail: error.message,
      };
    }
    // serve refusing a forwarded commit on the caller's access or content is
    // final: it never landed, and a narrowed grant refuses it every time. If an
    // earlier attempt landed it, the next catch-up brings it back
    // a run record an older swamp wrote is kept and reported, never dropped
    // silently: its work is run again
    if (
      error instanceof ServeCommitRefusedError &&
      error.reason === RUN_INITIATOR_MISMATCH_REASON
    ) {
      return {
        kind: "rejected",
        reason: error.message,
        code: RUN_INITIATOR_MISMATCH_CODE,
      };
    }
    if (
      error instanceof CommitRejectedError ||
      error instanceof ServeCommitRefusedError
    ) {
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
 * nothing can store a missing chunk again (its writer is gone), so it is
 * reported; a check that fails is reported too, never failing the recovery
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
  "lease-superseded":
    "the model lease it was made under has ended or changed hands",
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

export const DISCARDED_AT_SERVE_REASON = "discarded at serve by an admin";

async function recordLandedOffline(
  port: OfflineFlushPort | undefined,
  entry: OutboxEntry,
  at: number,
): Promise<void> {
  if (port?.recordOwnLanded === undefined) return;
  const { commit } = entry;
  const landed = (await port.partitionCommits(
    commit.namespace,
    commit.partition,
  )).find((candidate) => candidate.txnId === commit.txnId);
  await port.recordOwnLanded(
    outboxKeyOf(commit),
    at,
    landed === undefined ? undefined : carryOfLanded(commit, landed),
  );
}

async function settleDiscarded(
  port: OfflineFlushPort | undefined,
  held: readonly OutboxEntry[],
): Promise<number> {
  if (port?.quarantineState === undefined) return 0;
  let discarded = 0;
  for (const entry of held) {
    if (entry.state !== "quarantined") continue;
    let state;
    try {
      state = await port.quarantineState(entry);
    } catch (error) {
      logger
        .debug`Could not ask serve about the quarantined change ${entry.commit.txnId}; asking again later: ${error}`;
      return discarded;
    }
    if (state !== "discarded") continue;
    await port.mark(
      [outboxKeyOf(entry.commit)],
      "rejected",
      DISCARDED_AT_SERVE_REASON,
    );
    discarded++;
  }
  return discarded;
}
