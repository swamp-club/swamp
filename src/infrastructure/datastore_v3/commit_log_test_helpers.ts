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
 * Doubles and fixtures for commit-log unit tests (swamp-club#3240).
 *
 * @module
 */

import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import { SOLO_NAMESPACE } from "../../domain/data/namespace.ts";
import { ChunkStore } from "../../domain/datastore_v3/chunk_store.ts";
import type { Commit } from "../../domain/datastore_v3/commit.ts";
import type {
  CommitStoreAppendResult,
  PartitionHead,
} from "../../domain/datastore_v3/commit_store.ts";
import { createIntent, type Intent } from "../../domain/datastore_v3/intent.ts";
import { type PutOp, putOp } from "../../domain/datastore_v3/op.ts";
import { Partition } from "../../domain/datastore_v3/partition.ts";
import {
  type PartitionKey,
  partitionOf,
} from "../../domain/datastore_v3/partition_key.ts";
import { RecordKey } from "../../domain/datastore_v3/record_key.ts";
import type { DatastoreStorage } from "../../domain/datastore/datastore_storage.ts";
import type {
  HeadIdentity,
  OutboxKey,
  OutboxPreparation,
  SweepState,
} from "../../domain/datastore_v3/commit_outbox.ts";
import type {
  CommitLogUnitOptions,
  CommitSink,
  SinkOutbox,
} from "./commit_log_unit_of_work.ts";

export const WRITER = { host: "host-a", pid: 4242, instance: "cli-1" } as const;
export const AT = new Date("2026-10-11T12:00:00.000Z");

/**
 * A commit sink over in-memory partitions, applying each commit through
 * `Partition.append` as the store does. Hooks let a test fail a call.
 */
export class MemorySink implements CommitSink {
  readonly partitions = new Map<string, Partition>();
  /** Every commit applied, in the order it landed. */
  readonly landed: Commit[] = [];
  /** Every append call, in order, by partition key. */
  readonly appendCalls: string[] = [];
  /** Runs before each append; a throw fails the append before it applies. */
  beforeAppend: (commit: Commit) => void | Promise<void> = () => {};
  /** Runs after an append applied; a throw fails the call after it landed. */
  afterAppend: (commit: Commit) => void | Promise<void> = () => {};
  /** Runs before each head read; a throw fails the read. */
  beforeHead: () => void = () => {};

  #partition(key: PartitionKey): Partition {
    const name = key.toString();
    let partition = this.partitions.get(name);
    if (partition === undefined) {
      partition = Partition.empty(key);
      this.partitions.set(name, partition);
    }
    return partition;
  }

  async append(commit: Commit): Promise<CommitStoreAppendResult> {
    this.appendCalls.push(commit.partition.toString());
    await this.beforeAppend(commit);
    const partition = this.#partition(commit.partition);
    const result = partition.append(commit);
    if (result.kind === "appended") this.landed.push(commit);
    await this.afterAppend(commit);
    return result.kind === "appended"
      ? result
      : { kind: "duplicate", seq: partition.seq };
  }

  head(_namespace: string, partition: PartitionKey): Promise<PartitionHead> {
    this.beforeHead();
    const found = this.#partition(partition);
    return Promise.resolve({
      seq: found.seq,
      highestFence: found.highestFence,
    });
  }

  /** The commits that landed on one partition, in seq order. */
  commitsOf(partition: PartitionKey): Commit[] {
    return this.landed.filter((commit) => commit.partition.equals(partition));
  }
}

/**
 * A {@link MemorySink} with an in-memory outbox (swamp-club#3490), recording
 * every outbox call in `events` beside the appends.
 */
export class OutboxMemorySink extends MemorySink {
  /** The entries prepared and not removed, by txnId. */
  readonly entries = new Map<string, OutboxPreparation>();
  /** Outbox calls and appends, in order: `prepare:<txnId>`, `settle:`, `discard:`, `append:`. */
  readonly events: string[] = [];
  /** The sweep state each read returns, in turn; quiet once used up. */
  sweepStates: SweepState[] = [];
  /** Runs before each removal; a throw fails it. */
  beforeRemove: (keys: readonly OutboxKey[]) => void = () => {};

  constructor() {
    super();
    const append = this.append.bind(this);
    this.append = (commit) => {
      this.events.push(`append:${commit.txnId}`);
      return append(commit);
    };
  }

  readonly outbox: SinkOutbox = {
    headIdentity: (namespace, partition) =>
      this.headIdentityOf(namespace, partition),
    prepare: (preparation) => {
      this.events.push(`prepare:${preparation.commit.txnId}`);
      this.entries.set(preparation.commit.txnId, preparation);
      return Promise.resolve();
    },
    settle: (keys) => this.#remove("settle", keys),
    discard: (keys) => this.#remove("discard", keys),
    sweepState: () =>
      Promise.resolve(this.sweepStates.shift() ?? { epoch: 0, active: false }),
  };

  #remove(
    kind: "settle" | "discard",
    keys: readonly OutboxKey[],
  ): Promise<void> {
    this.beforeRemove(keys);
    for (const key of keys) {
      this.events.push(`${kind}:${key.txnId}`);
      this.entries.delete(key.txnId);
    }
    return Promise.resolve();
  }

  async headIdentityOf(
    namespace: string,
    partition: PartitionKey,
  ): Promise<HeadIdentity> {
    const head = await this.head(namespace, partition);
    const last = this.commitsOf(partition).at(-1);
    return { seq: head.seq, txnId: head.seq === 0 ? undefined : last?.txnId };
  }
}

export const MODEL_A_ID = "11111111-1111-4111-8111-111111111111";
export const MODEL_B_ID = "22222222-2222-4222-8222-222222222222";
export const WORKFLOW_ID = "33333333-3333-4333-8333-333333333333";
export const RUN_ID = "44444444-4444-4444-8444-444444444444";

export function runPartition(): PartitionKey {
  return partitionOf({ kind: "run", workflowId: WORKFLOW_ID, runId: RUN_ID });
}

export function runIntent(): Intent {
  return createIntent({
    kind: "run.update",
    run: { workflowId: WORKFLOW_ID, runId: RUN_ID },
  });
}

/** A put on the fixture run's record. */
export function runPut(text: string): Promise<PutOp> {
  return putOp({
    intent: runIntent(),
    key: RecordKey.create(
      `workflow-runs/${WORKFLOW_ID}/${RUN_ID}.yaml`,
    ),
    inline: btoa(text),
  });
}

/** A hook standing for one v3 repository context. */
export function contextHook(): MarkDirtyHook {
  return () => Promise.resolve();
}

/**
 * Unit options over a sink and a chunk storage (an in-memory one in unit
 * tests: `MemoryStorage` from `v3_test_helpers.ts`).
 */
export function unitOptions<S extends DatastoreStorage>(
  sink: CommitSink,
  storage: S,
  overrides: Partial<CommitLogUnitOptions> = {},
): CommitLogUnitOptions & { storage: S } {
  return {
    sink,
    chunkStore: new ChunkStore(storage),
    namespace: SOLO_NAMESPACE,
    writer: WRITER,
    signal: new AbortController().signal,
    clock: () => AT,
    ...overrides,
    storage,
  };
}
