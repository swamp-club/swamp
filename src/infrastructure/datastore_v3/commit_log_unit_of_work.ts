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
 * The commit-log unit of work: datastore rework Phase 3 (swamp-club#3240).
 *
 * A unit stages typed changes and, when it commits, turns them into one
 * commit per partition. Dormant: nothing outside the v3 directories imports
 * it (`integration/datastore_v3_rules_test.ts`); tests open it through
 * `runInCommitLogRoot` until the v3 opt-in wires it in.
 *
 * **Commit order and failure (decisions 4, 6 and 7 of "v3 domain model",
 * `design/enablers/datastores.md`).** Each partition commits on its own, in
 * the order its first change was staged, with workflow-run partitions last,
 * so a run record never names data that has not landed. For each partition
 * the unit stores the content that needs storing (chunks before the commit
 * that names them), then appends one commit through the {@link CommitSink}.
 * There is no atomicity across partitions: when a partition fails, the
 * partitions before it stay committed and the ones after it are not tried.
 *
 * - A partition whose commit failed stays **pending** with its txnId and
 *   ops. The next `checkpoint` of the same unit, or its `commit`, rebuilds
 *   its commit at the partition's current head with the same txnId, so a
 *   commit that did land the first time is reported `duplicate` by the store
 *   and lands once. `commit` ends the unit whether or not it succeeds (the
 *   `UnitOfWork` contract), so what is still pending when the unit's own
 *   commit fails is lost with it; the Phase 4 outbox makes it durable. A
 *   caller that must retry checkpoints first.
 * - A refusal (`CommitRejectedError`) surfaces unchanged, and the refused
 *   partition's changes are dropped: they can never land as they are, and
 *   keeping them would block every partition staged after them. A
 *   `seq-gap` is the exception: another append moved the head first, so the
 *   append is rebuilt at the new head once more in the same flush, and if
 *   that also meets a gap the partition stays pending.
 * - `abandon` discards staged and pending changes. A checkpoint already in
 *   progress finishes first, so what it commits stays committed. Chunks
 *   already stored stay unreferenced until chunk garbage collection
 *   reclaims them.
 * - Run partitions commit after the others of the same flush, but a
 *   partition dropped as refused does not hold back a run partition a later
 *   checkpoint commits: keeping a run record from naming refused data is
 *   left to the issue that stages run records (decision 7).
 *
 * **The outbox seam.** The unit appends through a {@link CommitSink}. In
 * Phase 3 that is the local `CommitStore`; Phase 4 passes the outbox, which
 * makes the pending retry durable.
 *
 * **Root and child units.** A unit opened with an open commit-log unit for
 * the same hook as `parent` is its child. A child keeps its changes to
 * itself: its `commit` hands them, in order, to its nearest open ancestor,
 * and its `abandon` discards them. A change staged after the child committed
 * goes to that ancestor; one staged after it was abandoned is refused. Only
 * a root commits to the log, and
 * `checkpoint` on a child throws. A root's checkpoint commits what has been
 * handed to it so far; a child still open keeps its changes until it ends.
 *
 * @module
 */

import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import type {
  StagedChange,
  UnitOfWork,
} from "../../domain/datastore/unit_of_work.ts";
import type { Namespace } from "../../domain/data/namespace.ts";
import type { BlobRef } from "../../domain/datastore_v3/blob_ref.ts";
import type { ChunkStore } from "../../domain/datastore_v3/chunk_store.ts";
import {
  Commit,
  type CommitWriter,
  MAX_COMMIT_OPS,
} from "../../domain/datastore_v3/commit.ts";
import type {
  CommitLogUnitOfWork,
  ContentSource,
  PendingPut,
  TypedChange,
} from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import type { CommitStore } from "../../domain/datastore_v3/commit_store.ts";
import {
  createIntent,
  intentPartition,
} from "../../domain/datastore_v3/intent.ts";
import {
  isOp,
  MAX_INLINE_BYTES,
  type Op,
  type PutOp,
  putOp,
} from "../../domain/datastore_v3/op.ts";
import { CommitRejectedError } from "../../domain/datastore_v3/partition.ts";
import { PartitionKey } from "../../domain/datastore_v3/partition_key.ts";
import { RecordKey } from "../../domain/datastore_v3/record_key.ts";
import { unitOfWorkBinding } from "../persistence/unit_of_work_binding.ts";

/**
 * Where a commit-log unit appends its commits: the outbox seam. Phase 3
 * passes the `CommitStore` itself; Phase 4 passes the outbox. `head` gives
 * the seq the next commit takes.
 */
export type CommitSink = Pick<CommitStore, "append" | "head">;

/** What a commit-log unit needs to commit. */
export interface CommitLogUnitOptions {
  readonly sink: CommitSink;
  /** Stores content too large to inline. */
  readonly chunkStore: ChunkStore;
  /** The datastore namespace; empty for an unnamespaced datastore. */
  readonly namespace: Namespace;
  readonly writer: CommitWriter;
  /** The writer's fence (its solo writer lock's or leader lease's), if any. */
  readonly fence?: number;
  /**
   * Bounds content uploads for the whole operation the unit serves, every
   * checkpoint and the final commit included; an abort rejects the commit
   * in progress.
   */
  readonly signal: AbortSignal;
  /** The clock a commit's `at` is read from; the system clock by default. */
  readonly clock?: () => Date;
  /**
   * The unit that was ambient when this one opened. The new unit is its
   * child when it is an open commit-log unit for the same hook, or the
   * child of its nearest open ancestor when it has ended; otherwise a root.
   */
  readonly parent?: UnitOfWork;
}

/** A path-only change staged into a commit-log unit, which takes typed ones. */
export class PathOnlyChangeRefusedError extends Error {
  constructor(readonly change: StagedChange) {
    const target = change.kind === "bulk" ? change.reason : change.path;
    super(
      `A datastore ${change.kind} of ${target} was staged without its intent ` +
        "and content; a v3 datastore commits only typed changes, so it was " +
        "refused",
    );
    this.name = "PathOnlyChangeRefusedError";
  }
}

/** One partition's changes on their way to a single commit. */
interface Group {
  readonly partition: PartitionKey;
  /** Fixed when the group forms, so a retry of its commit lands once. */
  readonly txnId: string;
  readonly changes: readonly TypedChange[];
}

/** What a commit-log unit exposes to its children. Adapter-private. */
interface CommitLogState {
  readonly hook: MarkDirtyHook;
  isOpen(): boolean;
  readonly parent: UnitOfWork | undefined;
  /** Takes a committed child's changes, in order. */
  adopt(changes: readonly TypedChange[]): void;
}

const states = new WeakMap<UnitOfWork, CommitLogState>();

/**
 * The open commit-log unit a new unit over `markDirty` rolls up into, given
 * the ambient unit `candidate`: `candidate` when it is an open commit-log
 * unit for that hook, otherwise its nearest open ancestor; undefined when
 * there is none, so the new unit is a root.
 */
export function commitLogParentFor(
  markDirty: MarkDirtyHook,
  candidate: UnitOfWork | undefined,
): UnitOfWork | undefined {
  if (candidate === undefined) return undefined;
  const state = states.get(candidate);
  if (state === undefined || state.hook !== markDirty) return undefined;
  return state.isOpen() ? candidate : nearestOpenAncestor(state.parent);
}

function nearestOpenAncestor(
  parent: UnitOfWork | undefined,
): UnitOfWork | undefined {
  let unit = parent;
  while (unit !== undefined) {
    const state = states.get(unit);
    if (state === undefined) return undefined;
    if (state.isOpen()) return unit;
    unit = state.parent;
  }
  return undefined;
}

/**
 * Builds a commit-log unit over `markDirty`, the hook of the v3 repository
 * context it serves, and binds it to that hook. See the module doc for what
 * commit, checkpoint and abandon do.
 */
export function createCommitLogUnitOfWork(
  markDirty: MarkDirtyHook,
  options: CommitLogUnitOptions,
): CommitLogUnitOfWork {
  const parent = commitLogParentFor(markDirty, options.parent);
  const clock = options.clock ?? (() => new Date());
  /** Every change staged, for `stagedOps`. */
  const all: TypedChange[] = [];
  /** Changes not yet formed into groups, in staging order. */
  let staged: TypedChange[] = [];
  /** Groups formed but not yet confirmed by the sink, in commit order. */
  let pending: Group[] = [];
  /** How many ops each partition holds across `staged`, by key. */
  const counts = new Map<string, number>();
  let ended: "committed" | "abandoned" | undefined;
  /** Serializes this unit's commits and checkpoints. */
  let flushing: Promise<void> = Promise.resolve();

  /**
   * Records changes all or nothing: when any partition would go over
   * MAX_COMMIT_OPS, none of them is recorded.
   */
  const record = (changes: readonly TypedChange[]): void => {
    const next = new Map(counts);
    for (const change of changes) {
      const key = change.partition.toString();
      const count = (next.get(key) ?? 0) + 1;
      if (count > MAX_COMMIT_OPS) {
        throw new Error(
          `Partition ${key} has more than ${MAX_COMMIT_OPS} changes staged in ` +
            "one unit of work; checkpoint before staging more",
        );
      }
      next.set(key, count);
    }
    for (const [key, count] of next) counts.set(key, count);
    for (const change of changes) {
      staged.push(change);
      all.push(change);
    }
  };

  const flush = (): Promise<void> => {
    const run = flushing.then(async () => {
      pending = [...pending, ...formGroups(staged)];
      staged = [];
      counts.clear();
      // Run partitions last (decision 7); a stable sort keeps the rest in
      // the order they were first touched.
      pending.sort((a, b) => runRank(a) - runRank(b));
      while (pending.length > 0) {
        try {
          await appendGroup(pending[0], options, clock);
        } catch (error) {
          // A refused commit can never land as it is: drop it, so the
          // partitions staged after it can still commit. A seq gap only
          // means another append moved the head first; the group stays
          // pending and is rebuilt at the new head.
          if (
            error instanceof CommitRejectedError && error.reason !== "seq-gap"
          ) {
            pending = pending.slice(1);
          }
          throw error;
        }
        pending = pending.slice(1);
      }
    });
    flushing = run.catch(() => {});
    return run;
  };

  const state: CommitLogState = {
    hook: markDirty,
    isOpen: () => ended === undefined,
    parent,
    adopt(changes) {
      record(changes);
    },
  };

  const end = async (as: "committed" | "abandoned"): Promise<void> => {
    if (ended !== undefined) throw new Error(`unit of work already ${ended}`);
    ended = as;
    if (as === "abandoned") {
      await flushing;
      staged = [];
      pending = [];
      return;
    }
    if (parent !== undefined) {
      const target = states.get(parent)?.isOpen()
        ? parent
        : nearestOpenAncestor(parent);
      if (target === undefined) {
        throw new Error(
          "a child unit of work committed after its root ended; its changes " +
            "were not committed",
        );
      }
      states.get(target)!.adopt(staged);
      staged = [];
      return;
    }
    await flush();
  };

  const uow: CommitLogUnitOfWork = {
    async stageOp(change: TypedChange): Promise<void> {
      const checked = await checkChange(change);
      if (ended === "abandoned") {
        // Abandon discards: a write still landing in an abandoned unit's
        // scope is discarded with it, not rolled into an ancestor.
        throw new Error("unit of work already abandoned");
      }
      if (ended !== undefined) {
        const ancestor = nearestOpenAncestor(parent);
        if (ancestor !== undefined) {
          return await (ancestor as CommitLogUnitOfWork).stageOp(checked);
        }
        throw new Error(`unit of work already ${ended}`);
      }
      record([checked]);
    },
    stage(change: StagedChange): Promise<void> {
      return Promise.reject(new PathOnlyChangeRefusedError(change));
    },
    async checkpoint(): Promise<void> {
      if (ended !== undefined) {
        throw new Error(`checkpoint called after the unit of work ${ended}`);
      }
      if (parent !== undefined) {
        throw new Error(
          "checkpoint called on a child unit of work; its root commits",
        );
      }
      await flush();
    },
    commit: () => end("committed"),
    abandon: () => end("abandoned"),
    staged: () => Object.freeze([]),
    stagedOps: () => Object.freeze([...all]),
  };
  states.set(uow, state);
  unitOfWorkBinding.bind(uow, markDirty);
  return uow;
}

/**
 * Checks a typed change where it is staged, so a bad one fails at the call
 * that made it rather than at commit.
 */
async function checkChange(change: TypedChange): Promise<TypedChange> {
  if (!(change.partition instanceof PartitionKey)) {
    throw new TypeError("A typed change's partition must be a PartitionKey");
  }
  if ("op" in change) {
    const op = change.op;
    if (!isOp(op)) {
      throw new TypeError(
        "A typed change's op must be built by the op factories",
      );
    }
    if (op.kind === "lease") {
      throw new Error(
        "A lease op is written by the lease machinery, never staged into a " +
          "unit of work",
      );
    }
    if (op.kind === "put" || op.kind === "tombstone") {
      requireSamePartition(intentPartition(op.intent), change.partition);
    }
    if (op.kind === "data-version" && change.partition.kind !== "model") {
      throw new Error(
        `A data-version op belongs in a model partition, not ${change.partition}`,
      );
    }
    return Object.freeze({ partition: change.partition, op });
  }
  const put = change.put;
  const intent = createIntent(put.intent);
  requireSamePartition(intentPartition(intent), change.partition);
  if (!(put.key instanceof RecordKey)) {
    throw new TypeError("A pending put's key must be a RecordKey");
  }
  if (
    !(put.content instanceof Uint8Array) && typeof put.content !== "function"
  ) {
    throw new TypeError(
      "A pending put's content must be bytes or a function returning a stream",
    );
  }
  // Builds the put once with empty content, so a bad key or expect fails
  // here rather than blocking the partitions after it at commit.
  await putOp({
    intent,
    key: put.key,
    inline: "",
    ...(put.expect === undefined ? {} : { expect: put.expect }),
  });
  const frozen: PendingPut = Object.freeze({
    ...put,
    intent,
    // A copy, so a caller reusing its buffer cannot change what commits.
    content: put.content instanceof Uint8Array
      ? new Uint8Array(put.content)
      : put.content,
  });
  return Object.freeze({ partition: change.partition, put: frozen });
}

function requireSamePartition(target: PartitionKey, partition: PartitionKey) {
  if (!target.equals(partition)) {
    throw new Error(
      `A change for partition ${target} was staged for partition ${partition}`,
    );
  }
}

/** Groups changes by partition, in the order each was first touched. */
function formGroups(changes: readonly TypedChange[]): Group[] {
  const groups = new Map<string, TypedChange[]>();
  const partitions = new Map<string, PartitionKey>();
  for (const change of changes) {
    const key = change.partition.toString();
    if (!groups.has(key)) {
      groups.set(key, []);
      partitions.set(key, change.partition);
    }
    groups.get(key)!.push(change);
  }
  return [...groups].map(([key, grouped]) => ({
    partition: partitions.get(key)!,
    txnId: crypto.randomUUID(),
    changes: grouped,
  }));
}

function runRank(group: Group): number {
  return group.partition.kind === "run" ? 1 : 0;
}

/**
 * Stores the group's content, then appends its commit at the partition's
 * current head. The head read and the append run under the partition's
 * lock, so two units in one process never take the same seq. Once the
 * commit has landed, any of its chunks that chunk garbage collection
 * deleted meanwhile are stored again (see {@link restoreMissingChunks}).
 */
async function appendGroup(
  group: Group,
  options: CommitLogUnitOptions,
  clock: () => Date,
): Promise<void> {
  const ops: Op[] = [];
  const stored: StoredContent[] = [];
  for (const change of group.changes) {
    if ("op" in change) {
      ops.push(change.op);
      continue;
    }
    const op = await storePut(change.put, options);
    if ("blob" in op.content) {
      stored.push({ source: change.put.content, blob: op.content.blob });
    }
    ops.push(op);
  }
  await withPartitionLock(
    options.sink,
    options.namespace,
    group.partition,
    async () => {
      // A seq gap means another writer moved the head between the read and
      // the append; one rebuild at the new head usually lands it.
      for (let attempt = 1;; attempt++) {
        const head = await options.sink.head(
          options.namespace,
          group.partition,
        );
        const commit = Commit.create({
          seq: head.seq + 1,
          partition: group.partition,
          namespace: options.namespace,
          txnId: group.txnId,
          writer: options.writer,
          ...(options.fence === undefined ? {} : { fence: options.fence }),
          at: clock().toISOString(),
          ops,
        });
        try {
          await options.sink.append(commit);
          return;
        } catch (error) {
          if (
            attempt < SEQ_GAP_ATTEMPTS &&
            error instanceof CommitRejectedError && error.reason === "seq-gap"
          ) {
            continue;
          }
          throw error;
        }
      }
    },
  );
  await restoreMissingChunks(stored, options);
}

/** Content a landed commit names as chunks, and where it came from. */
interface StoredContent {
  readonly source: ContentSource;
  readonly blob: BlobRef;
}

/**
 * The writer's half of closing chunk garbage collection's race
 * (swamp-club#3249). A sweep can delete a chunk this unit found present
 * and refreshed before its commit landed; the sweep re-checks references
 * after deleting and restores what a commit landed on meanwhile, so what is
 * left is a commit landing after that re-check. Checked here, after the
 * commit has landed (appended or a duplicate), any chunk of it missing is
 * stored again from the put's content source, which stays readable until
 * the unit ends. Content stored again must give the same reference;
 * a source that changed cannot repair the commit, and that is an error.
 */
async function restoreMissingChunks(
  stored: readonly StoredContent[],
  options: CommitLogUnitOptions,
): Promise<void> {
  const { chunkStore, namespace, signal } = options;
  for (const { source, blob } of stored) {
    const missing = await chunkStore.missing(namespace, blob, signal);
    if (missing.length === 0) continue;
    const again = await chunkStore.write(
      namespace,
      source instanceof Uint8Array ? source : await source(),
      signal,
    );
    if (!again.equals(blob)) {
      throw new Error(
        `A landed commit names chunk ${
          missing[0]
        }, which is missing, and its content source no longer gives content ${blob.sha256}`,
      );
    }
  }
}

/** How many times one flush tries a partition's append through seq gaps. */
const SEQ_GAP_ATTEMPTS = 2;

/** Builds a pending put's op, storing its content inline or as chunks. */
async function storePut(
  put: PendingPut,
  options: CommitLogUnitOptions,
): Promise<PutOp> {
  const content = await storeContent(put.content, options);
  return await putOp({
    intent: put.intent,
    key: put.key,
    ...content,
    ...(put.expect === undefined ? {} : { expect: put.expect }),
  });
}

/**
 * Inlines content of at most {@link MAX_INLINE_BYTES}, and stores anything
 * longer through the chunk store. A stream source is read, a piece at a
 * time, until it ends or holds more than the inline limit; what was read is
 * then handed to the chunk store ahead of the rest.
 */
async function storeContent(
  source: ContentSource,
  options: CommitLogUnitOptions,
): Promise<{ inline: string } | { blob: BlobRef }> {
  const { chunkStore, namespace, signal } = options;
  signal.throwIfAborted();
  if (source instanceof Uint8Array) {
    return source.length <= MAX_INLINE_BYTES
      ? { inline: toBase64(source) }
      : { blob: await chunkStore.write(namespace, source, signal) };
  }
  const reader = (await source()).getReader();
  const head: Uint8Array[] = [];
  let headBytes = 0;
  let handedOn = false;
  try {
    while (headBytes <= MAX_INLINE_BYTES) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) return { inline: toBase64(concat(head, headBytes)) };
      head.push(value);
      headBytes += value.length;
    }
    // The chunk store now owns the stream: it cancels it, and so the
    // source, when the write fails or aborts.
    handedOn = true;
    return {
      blob: await chunkStore.write(namespace, resume(head, reader), signal),
    };
  } finally {
    if (!handedOn) await reader.cancel().catch(() => {});
  }
}

/**
 * A stream of the pieces already read followed by the rest of `reader`.
 * Cancelling it cancels the source.
 */
function resume(
  pieces: readonly Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  let next = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (next < pieces.length) {
        controller.enqueue(pieces[next++]);
        return;
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  }, { highWaterMark: 0 });
}

function concat(pieces: readonly Uint8Array[], length: number): Uint8Array {
  const joined = new Uint8Array(length);
  let at = 0;
  for (const piece of pieces) {
    joined.set(piece, at);
    at += piece.length;
  }
  return joined;
}

/** Canonical base64, as `putOp` requires of inline content. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * The tail of each partition's append queue, by sink. Entries are removed
 * when their queue drains, so the map holds only partitions being appended.
 */
const partitionLocks = new WeakMap<CommitSink, Map<string, Promise<void>>>();

/**
 * Runs `fn` after every earlier append to the same partition of the same
 * sink has settled. The lock is released whether `fn` resolves or throws.
 */
async function withPartitionLock(
  sink: CommitSink,
  namespace: string,
  partition: PartitionKey,
  fn: () => Promise<void>,
): Promise<void> {
  let queues = partitionLocks.get(sink);
  if (queues === undefined) {
    queues = new Map();
    partitionLocks.set(sink, queues);
  }
  const key = `${namespace}\u0000${partition}`;
  const before = queues.get(key) ?? Promise.resolve();
  const run = before.then(fn);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  try {
    await run;
  } finally {
    if (queues.get(key) === tail) queues.delete(key);
  }
}

/** How many partitions of a sink have an append queued or running; for tests. */
export function partitionLockCountForTesting(sink: CommitSink): number {
  return partitionLocks.get(sink)?.size ?? 0;
}
