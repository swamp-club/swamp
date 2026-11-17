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

// each pause falls between finished transactions, so a writer stopped there with
// its files closed leaves the disk as a killed process would

import { dirname } from "@std/path";
import { SOLO_NAMESPACE } from "../src/domain/data/namespace.ts";
import { ChunkStore } from "../src/domain/datastore_v3/chunk_store.ts";
import {
  AutoDefinitionChanges,
  recordKeyOf,
} from "../src/domain/datastore_v3/repository_changes.ts";
import {
  type CommitSink,
  createCommitLogUnitOfWork,
} from "../src/infrastructure/datastore_v3/commit_log_unit_of_work.ts";
import { createOutboxCommitSink } from "../src/infrastructure/datastore_v3/outbox_commit_sink.ts";
import { SqliteCommitOutbox } from "../src/infrastructure/datastore_v3/sqlite_commit_outbox.ts";
import { SqliteCommitStore } from "../src/infrastructure/datastore_v3/sqlite_commit_store.ts";
import { FileSystemStorage } from "../src/infrastructure/persistence/fs_datastore_storage.ts";

export type OutboxCrashPause =
  | "before-prepare"
  | "after-prepare"
  | "after-append";

export interface OutboxCrashRequest {
  readonly datastorePath: string;
  readonly checkoutFile: string;
  readonly commitsDb: string;
  readonly outboxPath: string;
  readonly fence: number;
  readonly writerPid: number;
  readonly id: string;
  readonly bytes: number;
  readonly pauses: readonly OutboxCrashPause[];
}

export interface StoppedWriter {
  /** where the writer stopped; undefined when it committed without stopping */
  readonly stoppedAt: OutboxCrashPause | undefined;
}

/**
 * runs the writer, calling onPause at each named pause it passes; at `stopAt`
 * it never goes on, and its store and outbox are closed as the OS closes a
 * dead process's files
 */
export async function runStoppedWriter(
  request: OutboxCrashRequest,
  stopAt: OutboxCrashPause,
  onPause: (point: OutboxCrashPause) => Promise<void>,
): Promise<StoppedWriter> {
  const stopped = Promise.withResolvers<OutboxCrashPause>();
  const pauses = [...request.pauses];
  const pauseAt = async (point: OutboxCrashPause): Promise<void> => {
    if (pauses[0] !== point) return;
    pauses.shift();
    if (point === stopAt) {
      stopped.resolve(point);
      await new Promise<never>(() => {});
    }
    await onPause(point);
  };
  const store = SqliteCommitStore.open(request.commitsDb);
  const outbox = new SqliteCommitOutbox(request.outboxPath);
  const committed = run(request, store, outbox, pauseAt);
  try {
    const outcome = await Promise.race([
      stopped.promise,
      committed.then(() => undefined),
    ]);
    return { stoppedAt: outcome };
  } finally {
    await store.close();
    await outbox.close();
  }
}

export function outboxCrashContent(bytes: number): Uint8Array {
  const content = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) content[i] = (i * 31 + 7) % 251;
  return content;
}

async function run(
  request: OutboxCrashRequest,
  store: SqliteCommitStore,
  outbox: SqliteCommitOutbox,
  pauseAt: (point: OutboxCrashPause) => Promise<void>,
): Promise<void> {
  const chunkStore = new ChunkStore(
    new FileSystemStorage(request.datastorePath),
  );
  const sink = createOutboxCommitSink({ commitStore: store, outbox });
  const inner = sink.outbox!;
  const paused: CommitSink = {
    head: sink.head,
    append: async (commit) => {
      const result = await sink.append(commit);
      await pauseAt("after-append");
      return result;
    },
    outbox: {
      ...inner,
      headIdentity: async (namespace, partition) => {
        await pauseAt("before-prepare");
        return await inner.headIdentity(namespace, partition);
      },
      prepare: async (preparation) => {
        await inner.prepare(preparation);
        await pauseAt("after-prepare");
      },
    },
  };
  const content = outboxCrashContent(request.bytes);
  await Deno.mkdir(dirname(request.checkoutFile), { recursive: true });
  await Deno.writeFile(request.checkoutFile, content);
  const unit = createCommitLogUnitOfWork(() => Promise.resolve(), {
    sink: paused,
    chunkStore,
    namespace: SOLO_NAMESPACE,
    writer: {
      host: Deno.hostname(),
      pid: request.writerPid,
      instance: crypto.randomUUID(),
    },
    fence: request.fence,
    signal: new AbortController().signal,
  });
  await unit.stageOps([
    new AutoDefinitionChanges(request.id).write(
      recordKeyOf(["auto-definitions", `${request.id}.yaml`]),
      content,
    ),
  ]);
  await unit.commit();
}
