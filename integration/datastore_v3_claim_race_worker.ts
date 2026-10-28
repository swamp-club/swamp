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

// Worker for datastore_v3_claim_test.ts (swamp-club#4063). It stands in for
// another swamp process writing a v3 datastore directly: it takes the
// writer hold the CLI takes (lease, catch-up, claim check), tells the test
// whether it holds it, waits for the test to say commit, commits one
// auto-definition under its fence, and lets go of the lease.

import "../src/domain/models/models.ts";
import { join } from "@std/path";
import { SOLO_NAMESPACE } from "../src/domain/data/namespace.ts";
import { ChunkStore } from "../src/domain/datastore_v3/chunk_store.ts";
import {
  AutoDefinitionChanges,
  recordKeyOf,
} from "../src/domain/datastore_v3/repository_changes.ts";
import { UserError } from "../src/domain/errors.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { createCommitLogUnitOfWork } from "../src/infrastructure/datastore_v3/commit_log_unit_of_work.ts";
import { createOutboxCommitSink } from "../src/infrastructure/datastore_v3/outbox_commit_sink.ts";
import { SqliteCommitOutbox } from "../src/infrastructure/datastore_v3/sqlite_commit_outbox.ts";
import { v3OutboxPath } from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import {
  closeV3Datastores,
  v3DatastoreConfigOf,
  v3DatastoreFor,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { v3WriterFence } from "../src/infrastructure/datastore_v3/v3_writer_lock.ts";
import { FileSystemStorage } from "../src/infrastructure/persistence/fs_datastore_storage.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";

export interface ClaimRaceRequest {
  readonly repoDir: string;
  readonly datastorePath: string;
  /** The auto-definition the writer commits. */
  readonly id: string;
}

export type ClaimRaceMessage =
  | { readonly starting: true }
  | { readonly waiting: true }
  | { readonly held: true }
  | { readonly committed: number }
  | { readonly refused: string | undefined }
  | { readonly done: true }
  | { readonly failed: string };

declare const self: Worker;

let commit: (() => void) | undefined;

self.onmessage = (event: MessageEvent<ClaimRaceRequest | "commit">) => {
  if (event.data === "commit") {
    commit?.();
    return;
  }
  run(event.data).then(
    () => self.postMessage({ done: true } satisfies ClaimRaceMessage),
    (error) =>
      self.postMessage({ failed: String(error) } satisfies ClaimRaceMessage),
  );
};

/**
 * Tells the test once the writer polls the lease's records a second time:
 * it found the lease held and waits for it, past every check that comes
 * before the lease. Patched in this worker's realm only.
 */
function reportLeaseWait(datastorePath: string): void {
  const leaseDir = join(datastorePath, "_control", "writer");
  const readDir = Deno.readDir.bind(Deno);
  let reads = 0;
  Object.defineProperty(Deno, "readDir", {
    configurable: true,
    value: (path: string | URL) => {
      if (String(path) === leaseDir && ++reads === 2) {
        self.postMessage({ waiting: true } satisfies ClaimRaceMessage);
      }
      return readDir(path);
    },
  });
}

async function run(request: ClaimRaceRequest): Promise<void> {
  await initializeLogging({});
  reportLeaseWait(request.datastorePath);
  const go = new Promise<void>((resolve) => commit = resolve);
  let context;
  try {
    self.postMessage({ starting: true } satisfies ClaimRaceMessage);
    context = await requireInitializedRepoUnlocked({
      repoDir: request.repoDir,
      outputMode: "json",
    });
  } catch (error) {
    if (error instanceof UserError) {
      self.postMessage({ refused: error.code } satisfies ClaimRaceMessage);
      await closeV3Datastores();
      return;
    }
    throw error;
  }
  try {
    self.postMessage({ held: true } satisfies ClaimRaceMessage);
    await go;
    const handle = v3DatastoreFor(
      context.repoDir,
      await v3DatastoreConfigOf(context.repoDir, context.datastoreConfig),
    );
    const unit = createCommitLogUnitOfWork(() => Promise.resolve(), {
      sink: createOutboxCommitSink({
        commitStore: handle.commitStore,
        outbox: new SqliteCommitOutbox(v3OutboxPath(handle.commitsDbPath)),
      }),
      chunkStore: new ChunkStore(new FileSystemStorage(request.datastorePath)),
      namespace: SOLO_NAMESPACE,
      writer: {
        host: Deno.hostname(),
        pid: Deno.pid,
        instance: crypto.randomUUID(),
      },
      fence: v3WriterFence(request.datastorePath),
      signal: new AbortController().signal,
    });
    await unit.stageOps([
      new AutoDefinitionChanges(request.id).write(
        recordKeyOf(["auto-definitions", `${request.id}.yaml`]),
        new TextEncoder().encode("claim race"),
      ),
    ]);
    await unit.commit();
    self.postMessage(
      {
        committed: handle.commitStore.highWaterMark().cursor,
      } satisfies ClaimRaceMessage,
    );
  } finally {
    await closeV3Datastores();
  }
}
