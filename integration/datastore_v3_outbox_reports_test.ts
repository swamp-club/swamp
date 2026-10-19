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
 * What a v3 writer reports, and what the next recovery does, when a commit's
 * outbox entry meets a fault (swamp-club#3586): a reported failure never
 * lands, a commit a successor landed is reported committed, a failing check
 * after the append never fails a landed commit, and a landed entry settles
 * rather than being dropped as lost. Real stores on a v3 filesystem
 * datastore; faults are injected by replacing a store method on the handle.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  AutoDefinitionChanges,
  recordKeyOf,
} from "../src/domain/datastore_v3/repository_changes.ts";
import {
  COMMIT_MAY_LAND_CODE,
  type CommitLogUnitOfWork,
  MayLandLaterError,
} from "../src/domain/datastore_v3/commit_log_unit_of_work.ts";
import type { CommitWriter } from "../src/domain/datastore_v3/commit.ts";
import { partitionOf } from "../src/domain/datastore_v3/partition_key.ts";
import { WriterFencedError } from "../src/domain/datastore_v3/writer_lease.ts";
import {
  initializeV3Datastore,
  openV3Datastore,
  type V3Datastore,
} from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import { recoverCommitOutbox } from "../src/infrastructure/datastore_v3/commit_outbox_recovery.ts";

await initializeLogging({});

const DAY_MS = 24 * 60 * 60 * 1000;

/** Past the inline limit, so the content is stored as chunks. */
const CHUNKED = 200 * 1024;

/** Another process's writer: a recovery lands what it prepared. */
const OTHER: CommitWriter = { host: "other", pid: 1, instance: "other" };

interface Datastore {
  readonly dir: string;
  readonly datastorePath: string;
  /** A handle for a checkout, writing under `fence` when given. */
  open(
    name: string,
    options?: {
      readonly fence?: number;
      readonly assertWriterCurrent?: () => void;
    },
  ): Promise<V3Datastore>;
}

async function withDatastore(
  fn: (datastore: Datastore) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-v3-outbox-reports-" });
  const handles: V3Datastore[] = [];
  try {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    await fn({
      dir,
      datastorePath,
      async open(name, options = {}) {
        const handle = openV3Datastore({
          repoDir: join(dir, name),
          datastorePath,
          ...(options.fence !== undefined
            ? { writerFence: () => options.fence }
            : {}),
          ...(options.assertWriterCurrent !== undefined
            ? { assertWriterCurrent: options.assertWriterCurrent }
            : {}),
        });
        handles.push(handle);
        if (options.fence !== undefined) {
          await handle.raiseWriterFence(options.fence);
        }
        return handle;
      },
    });
  } finally {
    for (const handle of handles) await handle.close().catch(() => {});
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/** Commits one auto-definition per id through `handle`'s engine. */
async function write(
  handle: V3Datastore,
  ids: readonly string[],
  bytes = 64,
): Promise<void> {
  const engine = handle.engineFor(() => Promise.resolve(), () => {
    throw new Error("no run repository needed");
  });
  await engine.runRoot({}, async () => {
    const unit = engine.openUnit() as unknown as CommitLogUnitOfWork;
    await unit.stageOps(
      ids.map((id) =>
        new AutoDefinitionChanges(id).write(
          recordKeyOf(["auto-definitions", `${id}.yaml`]),
          new Uint8Array(bytes).fill(7),
        )
      ),
    );
    await unit.commit();
  });
}

async function commitsOf(handle: V3Datastore, id: string): Promise<number> {
  return (await handle.commitStore.readPartition(
    "",
    partitionOf({ kind: "definition", id }),
    1,
    100,
  )).length;
}

/** Replaces `object[method]` on the instance, as a fault. */
function fault<T extends object, K extends keyof T>(
  object: T,
  method: K,
  replacement: T[K],
): () => void {
  Object.defineProperty(object, method, {
    value: replacement,
    configurable: true,
    writable: true,
  });
  return () => {
    delete (object as Record<PropertyKey, unknown>)[method as PropertyKey];
  };
}

/** Holds `handle`'s writer between its prepare and its append. */
function pauseAfterPrepare(handle: V3Datastore): {
  readonly prepared: Promise<void>;
  resume(): void;
} {
  const prepared = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const prepare = handle.outbox.prepare.bind(handle.outbox);
  let first = true;
  fault(handle.outbox, "prepare", async (preparation) => {
    await prepare(preparation);
    if (!first) return;
    first = false;
    prepared.resolve();
    await gate.promise;
  });
  return { prepared: prepared.promise, resume: () => gate.resolve() };
}

const diskFull = () => Promise.reject(new Error("database or disk is full"));

Deno.test("v3 outbox reports: an append that fails with a discard that fails too is reported failed and never landed (swamp-club#3586)", async () => {
  await withDatastore(async (datastore) => {
    const writer = await datastore.open("a", { fence: 1 });
    const id = crypto.randomUUID();
    fault(writer.commitStore, "append", diskFull);
    fault(writer.outbox, "discard", diskFull);
    await assertRejects(() => write(writer, [id]), Error, "disk is full");
    // The close's retry fails again.
    await writer.close();

    const next = await datastore.open("b", { fence: 2 });
    const report = await recoverCommitOutbox(next, {
      fence: 2,
      writer: OTHER,
      writerAlive: () => false,
    });
    assertEquals(report.landed, 0);
    assertEquals(await commitsOf(next, id), 0);
    assertEquals(await next.outbox.hasEntries(), false);
  });
});

Deno.test("v3 outbox reports: when neither the discard nor the abandoned mark can be written, the failure says the change may land (swamp-club#3586)", async () => {
  await withDatastore(async (datastore) => {
    const writer = await datastore.open("a", { fence: 1 });
    fault(writer.commitStore, "append", diskFull);
    fault(writer.outbox, "discard", diskFull);
    fault(writer.outbox, "abandon", diskFull);
    const error = await assertRejects(() =>
      write(writer, [crypto.randomUUID()])
    );
    assert(error instanceof MayLandLaterError, String(error));
    assertEquals(error.code, COMMIT_MAY_LAND_CODE);
    assert(error.message.includes("disk is full"));
  });
});

Deno.test("v3 outbox reports: an entry left for its live writer, whose refused discard fails, is never landed once the writer is gone (swamp-club#3586)", async () => {
  await withDatastore(async (datastore) => {
    const writer = await datastore.open("a", { fence: 1 });
    const id = crypto.randomUUID();
    const paused = pauseAfterPrepare(writer);
    const writing = write(writer, [id]).then(() => undefined, (e) => e);
    await paused.prepared;

    // R1 runs under a newer lease, finds the writer alive and leaves it.
    const recoverer = await datastore.open("b", { fence: 2 });
    const first = await recoverCommitOutbox(recoverer, {
      fence: 2,
      writer: OTHER,
      writerAlive: () => true,
    });
    assertEquals(first.skipped, 1);

    // The writer resumes, is refused by the store's fence, and its
    // discard fails.
    fault(writer.outbox, "discard", diskFull);
    paused.resume();
    const failure = await writing;
    assert(failure instanceof WriterFencedError, String(failure));
    await writer.close();

    // A later recovery, the writer gone, lands nothing.
    await recoverer.raiseWriterFence(3);
    const later = await recoverCommitOutbox(recoverer, {
      fence: 3,
      writer: OTHER,
      writerAlive: () => false,
    });
    assertEquals(later.landed, 0);
    assertEquals(await commitsOf(recoverer, id), 0);
  });
});

Deno.test("v3 outbox reports: a writer whose prepared commit a successor landed reports it committed (swamp-club#3586)", async () => {
  await withDatastore(async (datastore) => {
    let lost = false;
    const writer = await datastore.open("a", {
      fence: 1,
      assertWriterCurrent: () => {
        if (lost) throw new WriterFencedError(1, 2);
      },
    });
    const id = crypto.randomUUID();
    const paused = pauseAfterPrepare(writer);
    const writing = write(writer, [id]);
    await paused.prepared;

    const successor = await datastore.open("b", { fence: 2 });
    const report = await recoverCommitOutbox(successor, {
      fence: 2,
      writer: OTHER,
      writerAlive: () => false,
    });
    assertEquals(report.landed, 1);
    lost = true;
    paused.resume();
    await writing;
    assertEquals(await commitsOf(successor, id), 1);
  });
});

Deno.test("v3 outbox reports: a fenced writer reports committed only the commit its successor landed (swamp-club#3586)", async () => {
  await withDatastore(async (datastore) => {
    let lost = false;
    const writer = await datastore.open("a", {
      fence: 1,
      assertWriterCurrent: () => {
        if (lost) throw new WriterFencedError(1, 2);
      },
    });
    const [landedId, laterId] = [crypto.randomUUID(), crypto.randomUUID()];
    const paused = pauseAfterPrepare(writer);
    const writing = write(writer, [landedId, laterId]);
    await paused.prepared;

    const successor = await datastore.open("b", { fence: 2 });
    await recoverCommitOutbox(successor, {
      fence: 2,
      writer: OTHER,
      writerAlive: () => false,
    });
    lost = true;
    paused.resume();
    await assertRejects(() => writing, WriterFencedError);
    assertEquals(await commitsOf(successor, landedId), 1);
    assertEquals(await commitsOf(successor, laterId), 0);
  });
});

Deno.test("v3 outbox reports: a check that fails after the append reports the commit committed (swamp-club#3586)", async () => {
  await withDatastore(async (datastore) => {
    const writer = await datastore.open("a", { fence: 1 });
    const id = crypto.randomUUID();
    let appended = false;
    const append = writer.commitStore.append.bind(writer.commitStore);
    fault(writer.commitStore, "append", async (commit) => {
      const result = await append(commit);
      appended = true;
      return result;
    });
    const has = writer.storage.has.bind(writer.storage);
    fault(
      writer.storage,
      "has",
      (namespace, hashes, signal) =>
        appended
          ? Promise.reject(new Deno.errors.PermissionDenied("EIO: stat failed"))
          : has(namespace, hashes, signal),
    );
    await write(writer, [id], CHUNKED);
    assert(appended);
    assertEquals(await commitsOf(writer, id), 1);
    assertEquals(await writer.outbox.hasEntries(), false);
  });
});

Deno.test("v3 outbox reports: a landed entry whose settle was lost settles after the retry bound, never dropped as lost (swamp-club#3586)", async () => {
  await withDatastore(async (datastore) => {
    const writer = await datastore.open("a", { fence: 1 });
    const id = crypto.randomUUID();
    fault(writer.outbox, "settle", diskFull);
    await write(writer, [id]);
    assertEquals(await writer.outbox.hasEntries(), true);

    const later = new Date(Date.now() + 8 * DAY_MS);
    const recoverer = await datastore.open("b", { fence: 2 });
    const report = await recoverCommitOutbox(recoverer, {
      fence: 2,
      writer: OTHER,
      writerAlive: () => false,
      clock: () => later,
    });
    assertEquals(report.drops, []);
    assertEquals(report.settled, 1);
    assertEquals(await commitsOf(recoverer, id), 1);
    assertEquals(await recoverer.outbox.hasEntries(), false);
  });
});

Deno.test("v3 outbox reports: a landed entry whose settle was lost settles after a chain restart, never dropped as lost (swamp-club#3586)", async () => {
  await withDatastore(async (datastore) => {
    const writer = await datastore.open("a", { fence: 1 });
    const id = crypto.randomUUID();
    const restore = fault(writer.outbox, "settle", diskFull);
    await write(writer, [id]);
    restore();

    // Another copy's fences came between: the chain restarts at 10.
    await writer.outbox.recordFence(10, { replicated: true });
    const report = await recoverCommitOutbox(writer, {
      fence: 10,
      writer: OTHER,
      writerAlive: () => false,
    });
    assertEquals(report.drops, []);
    assertEquals(report.settled, 1);
    assertEquals(await writer.outbox.hasEntries(), false);
  });
});

Deno.test("v3 outbox reports: a commit that lands reads no landing and marks nothing abandoned (swamp-club#3586)", async () => {
  await withDatastore(async (datastore) => {
    const writer = await datastore.open("a", { fence: 1 });
    const calls: string[] = [];
    const landedSeq = writer.commitStore.landedSeq.bind(writer.commitStore);
    fault(writer.commitStore, "landedSeq", (...args) => {
      calls.push("landedSeq");
      return landedSeq(...args);
    });
    const abandon = writer.outbox.abandon.bind(writer.outbox);
    fault(writer.outbox, "abandon", (keys) => {
      calls.push("abandon");
      return abandon(keys);
    });
    await write(writer, [crypto.randomUUID(), crypto.randomUUID()], CHUNKED);
    assertEquals(calls, []);
  });
});
