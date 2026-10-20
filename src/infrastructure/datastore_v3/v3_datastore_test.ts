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

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  AutoDefinitionChanges,
  recordKeyOf,
} from "../../domain/datastore_v3/repository_changes.ts";
import {
  type CommitLogUnitOfWork,
  PartitionsRefusedError,
} from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import { partitionOf } from "../../domain/datastore_v3/partition_key.ts";
import { runInUnitOfWork } from "../persistence/unit_of_work_scope.ts";
import { swampPath } from "../persistence/paths.ts";
import {
  bindCommitLogEngine,
  openRepoUnitOfWork,
} from "../persistence/repo_unit_of_work.ts";
import {
  COMMITS_DB_FILE,
  datastoreKeyFilter,
  DroppedWorkRecoveryRunningError,
  initializeV3Datastore,
  isFreshV3Skeleton,
  listV3Namespaces,
  openV3Datastore,
  referencedChunksOf,
  restoreV3FormatMarker,
} from "./v3_datastore.ts";
import { DatabaseSync } from "node:sqlite";
import {
  COMMIT_STORE_SCHEMA_VERSION,
  openCommitsDatabase,
} from "./sqlite_commit_store.ts";
import { ensureSupportedDatastoreFormat } from "../persistence/datastore_format_guard.ts";
import { UserError } from "../../domain/errors.ts";
import { writeDatastoreFormatMarker } from "../persistence/datastore_format_marker_writer.ts";
import {
  blobPut,
  deleteVersion,
  modelCommit,
  savePut,
  versionOp,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import { SOLO_NAMESPACE } from "../../domain/data/namespace.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-v3-datastore-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("datastoreKeyFilter: the default layout admits datastore directories and nothing local", () => {
  const admits = datastoreKeyFilter(undefined, undefined);
  assert(admits("data/aws/ec2/id/result/1/raw"));
  assert(admits("workflow-runs/w/run.yaml"));
  assertEquals(admits("_read_model_v3/_catalog_v3.db"), false);
  assertEquals(admits("not-a-datastore-dir/x"), false);
});

Deno.test("datastoreKeyFilter: configured directories and exclude patterns keep keys local", () => {
  const admits = datastoreKeyFilter(["data", "outputs"], ["data/secret/**"]);
  assert(admits("data/aws/ec2/id/result/1/raw"));
  assertEquals(admits("workflow-runs/w/run.yaml"), false);
  assertEquals(admits("data/secret/x/raw"), false);
});

Deno.test("openV3Datastore: a root commits typed changes the read model of another checkout applies", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const writer = openV3Datastore({ repoDir: join(dir, "a"), datastorePath });
    const reader = openV3Datastore({ repoDir: join(dir, "b"), datastorePath });
    try {
      const hook = () => Promise.resolve();
      const engine = writer.engineFor(hook, () => {
        throw new Error("no run repository needed");
      });
      const key = recordKeyOf(["auto-definitions", "x.yaml"]);
      const bytes = new TextEncoder().encode("name: x\n");
      await engine.runRoot({}, async () => {
        const unit = engine.openUnit() as unknown as CommitLogUnitOfWork;
        await unit.stageOps([
          new AutoDefinitionChanges(crypto.randomUUID()).write(key, bytes),
        ]);
        await unit.commit();
      });
      assertEquals((await writer.describe()).storedCommits, 1);
      await reader.catchUp();
      assertEquals(
        await Deno.readFile(
          swampPath(join(dir, "b"), "auto-definitions", "x.yaml"),
        ),
        bytes,
      );
    } finally {
      await writer.close();
      await reader.close();
    }
  });
});

Deno.test("openV3Datastore: collectChunks verifies only when asked, from the prefix given, and moves a damaged chunk aside to remove it (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const handle = openV3Datastore({ repoDir: join(dir, "a"), datastorePath });
    try {
      // Stored under a hash its bytes do not have.
      const rotten = "ab" + "0".repeat(62);
      const shard = join(datastorePath, "_blobs", "_default", "sha256", "ab");
      await Deno.mkdir(shard, { recursive: true });
      await Deno.writeFile(join(shard, rotten), new Uint8Array([1, 2, 3]));

      const plain = await handle.collectChunks(new AbortController().signal);
      assertEquals([plain.verified, plain.damaged.length], [0, 0]);

      const verified = await handle.collectChunks(
        new AbortController().signal,
        { bytes: 1024, from: "ab" },
      );
      assertEquals(verified.verified, 1);
      assertEquals(verified.damaged, [{ sha256: rotten, referenced: false }]);
      assertEquals([...Deno.readDirSync(shard)], []);
    } finally {
      await handle.close();
    }
  });
});

Deno.test("openV3Datastore: chunk GC and compaction run on an empty datastore", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const handle = openV3Datastore({ repoDir: join(dir, "a"), datastorePath });
    try {
      const report = await handle.collectChunks(new AbortController().signal);
      assertEquals(report.deleted, 0);
      assertEquals(
        await handle.compactIfDue(new AbortController().signal),
        undefined,
      );
      assertEquals(await handle.describe(), {
        storedCommits: 0,
        compactedThrough: 0,
      });
    } finally {
      await handle.close();
      // Closing twice is harmless.
      await handle.close();
    }
  });
});

Deno.test("isFreshV3Skeleton: a writer's replication state does not make it a datastore with data", async () => {
  await withTempDir(async (root) => {
    const dir = join(root, "datastore");
    await Deno.mkdir(dir);
    await initializeV3Datastore(dir, "test");
    await Deno.mkdir(join(dir, ".commits.db-replication"));
    await Deno.mkdir(join(dir, ".commits.db-litestream"));
    assert(await isFreshV3Skeleton(dir));
    await Deno.mkdir(join(dir, "other"));
    assertEquals(await isFreshV3Skeleton(dir), false);
  });
});

Deno.test("initializeV3Datastore: completes a fresh skeleton, and refuses a datastore that has commits", async () => {
  await withTempDir(async (root) => {
    const dir = join(root, "datastore");
    await Deno.mkdir(dir);
    // A setup that stopped after the marker: the re-run completes it.
    await writeDatastoreFormatMarker(dir, { format: 3, minReaderFormat: 3 });
    assert(await isFreshV3Skeleton(dir));
    await initializeV3Datastore(dir, "test");
    assert(await isFreshV3Skeleton(dir), "still empty once completed");

    // One with a commit is no skeleton.
    const handle = openV3Datastore({
      repoDir: join(root, "repo"),
      datastorePath: dir,
    });
    try {
      const engine = handle.engineFor(() => Promise.resolve(), () => {
        throw new Error("no run repository needed");
      });
      await engine.runRoot({}, async () => {
        const unit = engine.openUnit() as unknown as CommitLogUnitOfWork;
        await unit.stageOps([
          new AutoDefinitionChanges(crypto.randomUUID()).write(
            recordKeyOf(["auto-definitions", "x.yaml"]),
            new TextEncoder().encode("x"),
          ),
        ]);
        await unit.commit();
      });
    } finally {
      await handle.close();
    }
    assertEquals(await isFreshV3Skeleton(dir), false);
    await assertRejects(() => initializeV3Datastore(dir, "test"));
  });
});

Deno.test("openV3Datastore: an engine checkpoints the units open around the call, and counts no refusal it did not throw after a commit (swamp-club#3587)", async () => {
  await withTempDir(async (root) => {
    const dir = join(root, "datastore");
    await Deno.mkdir(dir);
    await initializeV3Datastore(dir, "test");
    const handle = openV3Datastore({
      repoDir: join(root, "repo"),
      datastorePath: dir,
    });
    try {
      const engine = handle.engineFor(() => Promise.resolve(), () => {
        throw new Error("no run repository needed");
      });
      assertEquals(await engine.checkpointOpenUnit(), "no-unit");
      await engine.runRoot({}, async () => {
        const unit = engine.openUnit() as unknown as CommitLogUnitOfWork;
        await runInUnitOfWork(unit, async () => {
          await unit.stageOps([
            new AutoDefinitionChanges(crypto.randomUUID()).write(
              recordKeyOf(["auto-definitions", "x.yaml"]),
              new TextEncoder().encode("x"),
            ),
          ]);
          assertEquals(await engine.checkpointOpenUnit(), "committed");
        });
        // Landed while the root is still open.
        assertEquals(await isFreshV3Skeleton(dir), false);
        await unit.commit();
      });

      const refused = new PartitionsRefusedError([{
        partition: partitionOf({
          kind: "run",
          workflowId: crypto.randomUUID(),
          runId: crypto.randomUUID(),
        }),
        reason: "expect-failed",
        message: "refused",
        versions: [],
      }], []);
      // Only a refusal a root threw after its commit counts.
      assertEquals(engine.committedBeforeThrowing(refused), false);
      assertEquals(engine.committedBeforeThrowing(new Error("x")), false);
    } finally {
      await handle.close();
    }
  });
});

/** Commits one auto-definition to `datastorePath` in `namespace`. */
async function commitIn(
  dir: string,
  datastorePath: string,
  namespace: string,
): Promise<void> {
  const datastore = openV3Datastore({
    repoDir: join(dir, `checkout-${crypto.randomUUID()}`),
    datastorePath,
    namespace,
  });
  try {
    const engine = datastore.engineFor(() => Promise.resolve(), () => {
      throw new Error("no run repository needed");
    });
    await engine.runRoot({}, async () => {
      const unit = engine.openUnit() as unknown as CommitLogUnitOfWork;
      await unit.stageOps([
        new AutoDefinitionChanges(crypto.randomUUID()).write(
          recordKeyOf(["auto-definitions", "x.yaml"]),
          new TextEncoder().encode("name: x\n"),
        ),
      ]);
      await unit.commit();
    });
  } finally {
    await datastore.close();
  }
}

Deno.test("listV3Namespaces: names each namespace with commits, never the unnamespaced one", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    assertEquals(listV3Namespaces(datastorePath, datastorePath), []);

    await commitIn(dir, datastorePath, "");
    assertEquals(listV3Namespaces(datastorePath, datastorePath), []);

    await commitIn(dir, datastorePath, "team");
    await commitIn(dir, datastorePath, "infra");
    assertEquals(listV3Namespaces(datastorePath, datastorePath), [
      "infra",
      "team",
    ]);
  });
});

Deno.test("listV3Namespaces: a datastore with no commits.db lists nothing and gains none", async () => {
  await withTempDir((dir) => {
    assertEquals(listV3Namespaces(dir, dir), []);
    assertEquals(
      [...Deno.readDirSync(dir)].map((entry) => entry.name),
      [],
    );
    return Promise.resolve();
  });
});

Deno.test("listV3Namespaces: reads a checkpointed commits.db without writing to it", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    await commitIn(dir, datastorePath, "team");
    const dbPath = join(datastorePath, COMMITS_DB_FILE);
    // The writer's close checkpoints the WAL away.
    assertEquals(
      [...Deno.readDirSync(datastorePath)].map((entry) => entry.name)
        .filter((name) => name.startsWith(`${COMMITS_DB_FILE}-`)),
      [],
    );
    const before = await Deno.readFile(dbPath);

    assertEquals(listV3Namespaces(datastorePath, datastorePath), ["team"]);

    assertEquals(await Deno.readFile(dbPath), before);
    // A writer opens it afterwards as before.
    await commitIn(dir, datastorePath, "infra");
    assertEquals(listV3Namespaces(datastorePath, datastorePath), [
      "infra",
      "team",
    ]);
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;

Deno.test("openV3Datastore: compactBefore folds a quiet history up to the cutoff, never inside the safety window, and the sweep then reclaims removed content (swamp-club#3473)", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    // Far past the chunks' real modification times, so only the release
    // grace keeps them; moved forward instead of slept.
    let now = Date.parse("2030-01-01T00:00:00.000Z");
    const handle = openV3Datastore({
      repoDir: join(dir, "a"),
      datastorePath,
      clock: () => new Date(now),
    });
    const signal = () => AbortSignal.timeout(30_000);
    const ago = (days: number) => new Date(now - days * DAY_MS).toISOString();
    const content = (text: string) =>
      handle.chunkStore.write(
        SOLO_NAMESPACE,
        new TextEncoder().encode(text.repeat(64)),
        signal(),
      );
    const storedChunks = async () => {
      const hashes: string[] = [];
      for await (const chunk of handle.storage.list("_default", signal())) {
        hashes.push(chunk.sha256);
      }
      return hashes.sort();
    };
    try {
      const reaped = await content("reaped");
      const kept = await content("kept");
      const history = [
        // Written long ago, then removed by retention 10 days ago.
        [30, [await blobPut("a", 1, reaped), versionOp("a", 1)]],
        [10, [deleteVersion("a", 1)]],
        // Older than a 3-day cutoff, but inside the 7-day safety window.
        [5, [await blobPut("b", 1, kept), versionOp("b", 1)]],
        // Newer than any cutoff here.
        [1, [await savePut("c", 1), versionOp("c", 1)]],
      ] as const;
      let seq = 1;
      for (const [days, ops] of history) {
        await handle.commitStore.append(
          modelCommit(seq, ops, { at: ago(days), txnId: `txn-${seq}` }),
        );
        seq++;
      }
      const reapedChunks = [...reaped.chunkHashes()].sort();
      const all = await storedChunks();

      // Well under the default policy's 10,000 commits: nothing is due.
      assertEquals(await handle.compactIfDue(signal()), undefined);

      // A 20-day cutoff folds only the write; the remove is newer, so the
      // base still names the reaped content.
      const older = await handle.compactBefore(
        new Date(now - 20 * DAY_MS),
        signal(),
      );
      assertEquals(older.bound.toISOString(), ago(20));
      assertEquals(older.compactedThrough, 1);
      assertEquals(older.report?.compacted, 1);
      now += DAY_MS + 60 * 60 * 1000;
      assertEquals((await handle.collectChunks(signal())).deleted, 0);
      assertEquals(await storedChunks(), all);

      // A 3-day cutoff is held back to the 7-day window: the remove folds,
      // the commits inside the window and after the cutoff stay.
      const cutoff = new Date(now - 3 * DAY_MS);
      const folded = await handle.compactBefore(cutoff, signal());
      assertEquals(folded.bound.toISOString(), ago(7));
      assertEquals(folded.compactedThrough, 2);
      assertEquals(folded.report?.compacted, 1);
      assertEquals(await handle.describe(), {
        storedCommits: 2,
        compactedThrough: 2,
      });
      // Within the release grace the reaped chunks are still kept.
      assertEquals((await handle.collectChunks(signal())).deleted, 0);
      // Past it, they are deleted and nothing else is.
      now += DAY_MS + 60 * 60 * 1000;
      const sweep = await handle.collectChunks(signal());
      assertEquals(sweep.deleted, reapedChunks.length);
      assertEquals(
        await storedChunks(),
        all.filter((hash) => !reapedChunks.includes(hash)),
      );
      for (const hash of kept.chunkHashes()) {
        assert((await storedChunks()).includes(hash));
      }

      // Two days on, the window has slid past the second write, which now
      // folds; the commit newer than the cutoff still stays.
      const later = await handle.compactBefore(cutoff, signal());
      assertEquals(later.bound.toISOString(), ago(7));
      assertEquals(later.compactedThrough, 3);
      assertEquals(await handle.describe(), {
        storedCommits: 1,
        compactedThrough: 3,
      });
      // Nothing more is older than the bound: another call folds nothing.
      const again = await handle.compactBefore(cutoff, signal());
      assertEquals(again.report, undefined);
      assertEquals(again.compactedThrough, 3);
    } finally {
      await handle.close();
    }
  });
});

Deno.test("openV3Datastore: dropped work is recovered only once no unit of the checkout is open (swamp-club#3553)", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const repoDir = join(dir, "a");
    const handle = openV3Datastore({ repoDir, datastorePath });
    try {
      assertEquals(await handle.recoverDroppedWork(), "clean");
      const engine = handle.engineFor(() => Promise.resolve(), () => {
        throw new Error("no run repository needed");
      });
      /** Writes `name` to the checkout, as a repository does, and stages it. */
      const write = async (name: string) => {
        const key = recordKeyOf(["auto-definitions", name]);
        const bytes = new TextEncoder().encode(`name: ${name}\n`);
        await Deno.mkdir(swampPath(repoDir, "auto-definitions"), {
          recursive: true,
        });
        await Deno.writeFile(
          swampPath(repoDir, "auto-definitions", name),
          bytes,
        );
        const unit = engine.openUnit() as unknown as CommitLogUnitOfWork;
        await unit.stageOps([
          new AutoDefinitionChanges(crypto.randomUUID()).write(key, bytes),
        ]);
        await unit.commit();
      };
      await engine.runRoot({}, () => write("kept.yaml"));

      // A root stays open while another drops the work it wrote.
      const release = Promise.withResolvers<void>();
      const open = engine.runRoot({}, () => release.promise);
      await engine.runRoot(
        { disposition: () => "discard" },
        () => write("dropped.yaml"),
      );
      assertEquals(handle.droppedWork()?.openUnits, 1);
      assertEquals(await handle.recoverDroppedWork(), "busy");
      const dropped = swampPath(repoDir, "auto-definitions", "dropped.yaml");
      assert(await Deno.stat(dropped).then(() => true));

      release.resolve();
      await open;
      assertEquals(await handle.recoverDroppedWork(), "recovered");
      await assertRejects(() => Deno.stat(dropped), Deno.errors.NotFound);
      await Deno.stat(swampPath(repoDir, "auto-definitions", "kept.yaml"));
      assertEquals(handle.droppedWork(), undefined);
      assertEquals(await handle.recoverDroppedWork(), "clean");
    } finally {
      await handle.close();
    }
  });
});

Deno.test("openV3Datastore: a root opened while dropped work is recovered is refused, directly or through the use-case factory (swamp-club#3586)", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const repoDir = join(dir, "a");
    const handle = openV3Datastore({ repoDir, datastorePath });
    try {
      const markDirty = () => Promise.resolve();
      const engine = handle.engineFor(markDirty, () => {
        throw new Error("no run repository needed");
      });
      bindCommitLogEngine(markDirty, engine);
      await engine.runRoot({ disposition: () => "discard" }, async () => {
        const unit = engine.openUnit() as unknown as CommitLogUnitOfWork;
        await unit.stageOps([
          new AutoDefinitionChanges(crypto.randomUUID()).write(
            recordKeyOf(["auto-definitions", "dropped.yaml"]),
            new TextEncoder().encode("dropped"),
          ),
        ]);
        await unit.commit();
      });
      assert(handle.droppedWork() !== undefined);

      const started = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      const recover = handle.readModel.recover.bind(handle.readModel);
      Object.defineProperty(handle.readModel, "recover", {
        configurable: true,
        value: async (...args: Parameters<typeof recover>) => {
          started.resolve();
          await gate.promise;
          return await recover(...args);
        },
      });
      const recovering = handle.recoverDroppedWork();
      await started.promise;
      assertThrows(() => engine.openUnit(), DroppedWorkRecoveryRunningError);
      assertThrows(
        () => openRepoUnitOfWork(markDirty),
        DroppedWorkRecoveryRunningError,
      );
      gate.resolve();
      assertEquals(await recovering, "recovered");
      await engine.openUnit().abandon();
    } finally {
      await handle.close();
    }
  });
});

Deno.test("openV3Datastore: a writer whose prepare meets a sweep batch in flight appends only once the batch has re-checked (swamp-club#3586)", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const handle = openV3Datastore({ repoDir: join(dir, "a"), datastorePath });
    try {
      // An old chunk no commit names, which the sweep will delete.
      await handle.chunkStore.write(
        SOLO_NAMESPACE,
        new Uint8Array(1024).fill(1),
        new AbortController().signal,
      );
      const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      const age = async (path: string): Promise<void> => {
        for await (const entry of Deno.readDir(path)) {
          const child = join(path, entry.name);
          if (entry.isDirectory) await age(child);
          else await Deno.utime(child, old, old);
        }
      };
      await age(join(datastorePath, "_blobs"));

      const deleting = Promise.withResolvers<void>();
      const releaseDelete = Promise.withResolvers<void>();
      const del = handle.storage.delete.bind(handle.storage);
      Object.defineProperty(handle.storage, "delete", {
        configurable: true,
        value: async (...args: Parameters<typeof del>) => {
          deleting.resolve();
          await releaseDelete.promise;
          return await del(...args);
        },
      });
      const events: string[] = [];
      const append = handle.commitStore.append.bind(handle.commitStore);
      Object.defineProperty(handle.commitStore, "append", {
        configurable: true,
        value: (...args: Parameters<typeof append>) => {
          events.push("append");
          return append(...args);
        },
      });
      const prepare = handle.outbox.prepare.bind(handle.outbox);
      let afterPrepare = false;
      Object.defineProperty(handle.outbox, "prepare", {
        configurable: true,
        value: async (...args: Parameters<typeof prepare>) => {
          await prepare(...args);
          events.push("prepare");
          afterPrepare = true;
        },
      });
      // The writer's read after its prepare: it then waits on the batch.
      const read = handle.outbox.sweepState.bind(handle.outbox);
      const checked = Promise.withResolvers<void>();
      Object.defineProperty(handle.outbox, "sweepState", {
        configurable: true,
        value: async (...args: Parameters<typeof read>) => {
          const state = await read(...args);
          if (afterPrepare) checked.resolve();
          return state;
        },
      });

      const sweeping = handle.collectChunks(new AbortController().signal);
      await deleting.promise;
      const engine = handle.engineFor(() => Promise.resolve(), () => {
        throw new Error("no run repository needed");
      });
      const writing = engine.runRoot({}, async () => {
        const unit = engine.openUnit() as unknown as CommitLogUnitOfWork;
        await unit.stageOps([
          new AutoDefinitionChanges(crypto.randomUUID()).write(
            recordKeyOf(["auto-definitions", "x.yaml"]),
            new TextEncoder().encode("x"),
          ),
        ]);
        await unit.commit();
      });
      await checked.promise;
      assertEquals(events, ["prepare"]);
      events.push("batch released");
      releaseDelete.resolve();
      await sweeping;
      await writing;
      assertEquals(events, ["prepare", "batch released", "append"]);
    } finally {
      await handle.close();
    }
  });
});

// --- swamp-club#3617: a v3 datastore whose format marker a crash lost ---

const MARKER = "datastore-format.json";
const LOST_MARKERS: readonly (string | undefined)[] = [
  undefined,
  "",
  " \n\t",
  "\0".repeat(64),
];

/** Writes `marker` at the datastore's marker path, or removes it. */
async function setMarker(dir: string, marker: string | undefined) {
  await Deno.remove(join(dir, MARKER)).catch(() => {});
  if (marker !== undefined) await Deno.writeTextFile(join(dir, MARKER), marker);
}

async function names(dir: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(dir)) found.push(entry.name);
  return found.sort();
}

Deno.test("initializeV3Datastore: syncs each created directory's parent, then the marker's directory, before commits.db exists (swamp-club#3617)", async () => {
  await withTempDir(async (root) => {
    const dir = join(root, "a", "b");
    const events: string[] = [];
    await initializeV3Datastore(dir, "test", {
      syncDirectory: async (synced) => {
        const marked = await Deno.lstat(join(dir, MARKER)).then(
          () => "marker",
          () => "no marker",
        );
        const log = await Deno.lstat(join(dir, COMMITS_DB_FILE)).then(
          () => "commits.db",
          () => "no commits.db",
        );
        events.push(`${synced}: ${marked}, ${log}`);
      },
    });
    assertEquals(events, [
      `${join(root, "a")}: no marker, no commits.db`,
      `${root}: no marker, no commits.db`,
      `${dir}: marker, no commits.db`,
    ]);
    assert(await isFreshV3Skeleton(dir));
  });
});

Deno.test("isFreshV3Skeleton: a lost marker beside a commit log with no history is a skeleton setup completes (swamp-club#3617)", async () => {
  for (const lost of LOST_MARKERS) {
    await withTempDir(async (root) => {
      const dir = join(root, "datastore");
      await initializeV3Datastore(dir, "test");
      await setMarker(dir, lost);
      assert(await isFreshV3Skeleton(dir), JSON.stringify(lost));
      await initializeV3Datastore(dir, "test");
      assertEquals(
        JSON.parse(await Deno.readTextFile(join(dir, MARKER))).format,
        3,
      );
      assertEquals(
        await ensureSupportedDatastoreFormat("/repo", {
          type: "filesystem",
          path: dir,
          format: 3,
        }),
        "v3",
      );
    });
  }
});

Deno.test("initializeV3Datastore: a resume racing another resume past a blank marker completes, not a raw NotFound (swamp-club#3617)", async () => {
  // The other resume removes the blank marker between this one's check
  // and its remove; then either is still writing, or has written, the v3
  // marker, which this one's remove must not delete.
  for (const otherWrote of [false, true]) {
    await withTempDir(async (root) => {
      const dir = join(root, "datastore");
      await initializeV3Datastore(dir, "test");
      await setMarker(dir, "");
      const synced: string[] = [];
      await initializeV3Datastore(dir, "test", {
        syncDirectory: (d) => {
          synced.push(d);
          return Promise.resolve();
        },
        rename: async (from, to) => {
          // The other resume's remove, then its write, then this one's.
          await Deno.remove(from);
          if (otherWrote) {
            await Deno.writeTextFile(
              from,
              JSON.stringify({
                format: 3,
                minReaderFormat: 3,
                writtenBy: "other",
              }),
            );
          }
          await Deno.rename(from, to);
        },
      });
      assertEquals(
        JSON.parse(await Deno.readTextFile(join(dir, MARKER))),
        {
          format: 3,
          minReaderFormat: 3,
          writtenBy: otherWrote ? "other" : "test",
        },
        `otherWrote=${otherWrote}`,
      );
      assertEquals(synced.at(-1), dir, "the marker's directory is synced");
      assertEquals(await names(dir), ["_blobs", COMMITS_DB_FILE, MARKER]);
      assert(await isFreshV3Skeleton(dir));
    });
  }
});

Deno.test("restoreV3FormatMarker: a restore past a blank marker never deletes the v3 marker another restore wrote after its check (swamp-club#3617)", async () => {
  await withTempDir(async (root) => {
    const dir = join(root, "datastore");
    await initializeV3Datastore(dir, "test");
    await setMarker(dir, "");
    const winner = '{"format":3,"minReaderFormat":3,"writtenBy":"winner"}';
    const path = await restoreV3FormatMarker(dir, "test", {
      // The other restore removes the blank marker and writes its own
      // between this one's check and its remove.
      rename: async (from, to) => {
        await Deno.remove(from);
        await Deno.writeTextFile(from, winner);
        await Deno.rename(from, to);
      },
    });
    assertEquals(await Deno.readTextFile(path), winner);
    assertEquals(await names(dir), ["_blobs", COMMITS_DB_FILE, MARKER]);
  });
});

Deno.test("isFreshV3Skeleton: a lost marker is no skeleton beside history, replication state, content or anything but a regular commits.db (swamp-club#3617)", async () => {
  for (const lost of LOST_MARKERS) {
    const label = JSON.stringify(lost);
    await withTempDir(async (root) => {
      // Commits.
      const dir = join(root, "datastore");
      await initializeV3Datastore(dir, "test");
      await commitIn(root, dir, "");
      await setMarker(dir, lost);
      assertEquals(await isFreshV3Skeleton(dir), false, label);
    });
    await withTempDir(async (root) => {
      // A compacted history: no stored commits, a compaction point.
      const dir = join(root, "datastore");
      await initializeV3Datastore(dir, "test");
      const db = new DatabaseSync(join(dir, COMMITS_DB_FILE));
      db.exec("UPDATE compaction SET point = 7 WHERE id = 1");
      db.close();
      await setMarker(dir, lost);
      assertEquals(await isFreshV3Skeleton(dir), false, label);
    });
    await withTempDir(async (root) => {
      // Replication or Litestream state, content, no commits.db.
      const dir = join(root, "datastore");
      await initializeV3Datastore(dir, "test");
      await setMarker(dir, lost);
      for (
        const extra of [".commits.db-replication", ".commits.db-litestream"]
      ) {
        await Deno.mkdir(join(dir, extra));
        assertEquals(await isFreshV3Skeleton(dir), false, `${label} ${extra}`);
        await Deno.remove(join(dir, extra));
      }
      await Deno.writeTextFile(join(dir, "_blobs", "chunk"), "x");
      assertEquals(await isFreshV3Skeleton(dir), false, label);
      await Deno.remove(join(dir, "_blobs", "chunk"));
      assert(await isFreshV3Skeleton(dir), label);
      await Deno.remove(join(dir, COMMITS_DB_FILE));
      const before = await names(dir);
      assertEquals(await isFreshV3Skeleton(dir), false, label);
      // And looking created nothing.
      assertEquals(await names(dir), before, label);
    });
    await withTempDir(async (root) => {
      // A directory, a non-SQLite file or a newer schema as commits.db.
      const dir = join(root, "datastore");
      await Deno.mkdir(dir);
      await setMarker(dir, lost);
      await Deno.mkdir(join(dir, COMMITS_DB_FILE));
      assertEquals(await isFreshV3Skeleton(dir), false, label);
      await Deno.remove(join(dir, COMMITS_DB_FILE));
      await Deno.writeTextFile(
        join(dir, COMMITS_DB_FILE),
        "not a database, long enough to have a header".repeat(4),
      );
      assertEquals(await isFreshV3Skeleton(dir), false, label);
      await Deno.remove(join(dir, COMMITS_DB_FILE));
      const db = new DatabaseSync(join(dir, COMMITS_DB_FILE));
      db.exec(`PRAGMA user_version=${COMMIT_STORE_SCHEMA_VERSION + 1}`);
      db.close();
      assertEquals(await isFreshV3Skeleton(dir), false, label);
    });
  }
});

Deno.test("isFreshV3Skeleton: a lost marker beside what setup's open leaves before the schema is a skeleton; an unrelated SQLite commits.db is not (swamp-club#3617)", async () => {
  for (const lost of LOST_MARKERS) {
    const label = JSON.stringify(lost);
    await withTempDir(async (root) => {
      const dir = join(root, "datastore");
      await Deno.mkdir(dir);
      await setMarker(dir, lost);
      const commitsDb = join(dir, COMMITS_DB_FILE);
      // Created, and stopped before anything was written: no pages.
      await Deno.writeFile(commitsDb, new Uint8Array());
      assert(await isFreshV3Skeleton(dir), `${label} empty file`);
      // Switched to WAL, and stopped before the schema transaction.
      const wal = new DatabaseSync(commitsDb);
      wal.exec("PRAGMA journal_mode=WAL");
      wal.close();
      assert(await isFreshV3Skeleton(dir), `${label} WAL, no schema`);
      await Deno.remove(commitsDb);
      // An SQLite file that is no commit log: user_version 0, no tables.
      const db = new DatabaseSync(commitsDb);
      db.exec("CREATE TABLE t (x); DROP TABLE t");
      db.close();
      assertEquals(await isFreshV3Skeleton(dir), false, `${label} unrelated`);
    });
  }
});

Deno.test("isFreshV3Skeleton: a directory holding only a lost marker, or nothing, creates no file when looked at (swamp-club#3617)", async () => {
  await withTempDir(async (root) => {
    assertEquals(await isFreshV3Skeleton(root), false);
    assertEquals(await names(root), []);
    await setMarker(root, "");
    assertEquals(await isFreshV3Skeleton(root), false);
    assertEquals(await names(root), [MARKER]);
  });
});

Deno.test("restoreV3FormatMarker: writes a v3 marker for a lost or blank one beside a v3 commit log with history (swamp-club#3617)", async () => {
  for (const lost of LOST_MARKERS) {
    await withTempDir(async (root) => {
      const dir = join(root, "datastore");
      await initializeV3Datastore(dir, "test");
      await commitIn(root, dir, "");
      await setMarker(dir, lost);
      const synced: string[] = [];
      const path = await restoreV3FormatMarker(dir, "2026.10.19.1", {
        syncDirectory: (d) => {
          synced.push(d);
          return Promise.resolve();
        },
      });
      assertEquals(path, join(dir, MARKER));
      assertEquals(JSON.parse(await Deno.readTextFile(path)), {
        format: 3,
        minReaderFormat: 3,
        writtenBy: "2026.10.19.1",
      });
      assertEquals(synced, [dir]);
      assertEquals(
        await ensureSupportedDatastoreFormat("/repo", {
          type: "filesystem",
          path: dir,
          format: 3,
        }),
        "v3",
      );
      // Again: the marker is there, nothing to do.
      assertEquals(await restoreV3FormatMarker(dir, "other"), path);
      assertEquals(
        JSON.parse(await Deno.readTextFile(path)).writtenBy,
        "2026.10.19.1",
      );
    });
  }
});

Deno.test("restoreV3FormatMarker: recovers a schema that is only in the write-ahead log (swamp-club#3617)", async () => {
  await withTempDir(async (root) => {
    const dir = join(root, "datastore");
    await Deno.mkdir(dir);
    // The schema written and never checkpointed: copied while open, as a
    // power cut leaves it.
    const source = join(root, "source.db");
    const open = openCommitsDatabase(source);
    try {
      await Deno.copyFile(source, join(dir, COMMITS_DB_FILE));
      await Deno.copyFile(`${source}-wal`, join(dir, `${COMMITS_DB_FILE}-wal`));
    } finally {
      open.close();
    }
    await restoreV3FormatMarker(dir, "test");
    assertEquals(
      JSON.parse(await Deno.readTextFile(join(dir, MARKER))).format,
      3,
    );
  });
});

Deno.test("restoreV3FormatMarker: refuses a commits.db that is missing, not a regular file, not SQLite, not v3 or newer, changing nothing (swamp-club#3617)", async () => {
  await withTempDir(async (root) => {
    const dir = join(root, "datastore");
    await Deno.mkdir(dir);
    const commitsDb = join(dir, COMMITS_DB_FILE);
    const refused = async (reason: string) => {
      const error = await assertRejects(
        () => restoreV3FormatMarker(dir, "test"),
        UserError,
        reason,
      );
      assertEquals(
        error.message.startsWith(
          `The format marker of ${dir} was not restored: `,
        ),
        true,
      );
      assertEquals(error.message.endsWith("Nothing was changed."), true);
      assertEquals((await names(dir)).includes(MARKER), false);
    };
    await refused("does not exist");
    await Deno.mkdir(commitsDb);
    await refused("is not a regular file");
    await Deno.remove(commitsDb);
    if (Deno.build.os !== "windows") {
      const elsewhere = join(root, "elsewhere.db");
      openCommitsDatabase(elsewhere).close();
      await Deno.symlink(elsewhere, commitsDb, { type: "file" });
      await refused("is not a regular file");
      await Deno.remove(commitsDb);
    }
    await Deno.writeTextFile(
      commitsDb,
      "not a database, long enough to have a header".repeat(4),
    );
    await refused("could not be read as a v3 commit log");
    await Deno.remove(commitsDb);
    // An SQLite file with no v3 schema.
    new DatabaseSync(commitsDb).close();
    await refused("is not a v3 commit log");
    await Deno.remove(commitsDb);
    const newer = openCommitsDatabase(commitsDb);
    newer.exec(`PRAGMA user_version=${COMMIT_STORE_SCHEMA_VERSION + 1}`);
    newer.close();
    await refused(`newer than this swamp's ${COMMIT_STORE_SCHEMA_VERSION}`);
    await Deno.remove(commitsDb);
    // A marker someone wrote is not replaced.
    openCommitsDatabase(commitsDb).close();
    await setMarker(dir, '{"format": 3, "minReaderFormat":');
    await assertRejects(
      () => restoreV3FormatMarker(dir, "test"),
      UserError,
      "is not a marker a crash left blank",
    );
    assertEquals(
      await Deno.readTextFile(join(dir, MARKER)),
      '{"format": 3, "minReaderFormat":',
    );
  });
});

Deno.test("restoreV3FormatMarker: a v3 marker another restore wrote first is success; anything else it met is not (swamp-club#3617)", async () => {
  await withTempDir(async (root) => {
    const dir = join(root, "datastore");
    await initializeV3Datastore(dir, "test");
    await setMarker(dir, undefined);
    const raced = (marker: string) => async (_from: string, to: string) => {
      await Deno.writeTextFile(to, marker);
      throw new Deno.errors.AlreadyExists("lost the race");
    };
    const path = await restoreV3FormatMarker(dir, "test", {
      link: raced('{"format":3,"minReaderFormat":3,"writtenBy":"winner"}'),
    });
    assertEquals(JSON.parse(await Deno.readTextFile(path)).writtenBy, "winner");
    await setMarker(dir, undefined);
    await assertRejects(
      () => restoreV3FormatMarker(dir, "test", { link: raced('{"format":2}') }),
      UserError,
      "already exists",
    );
  });
});

Deno.test("referencedChunksOf: asks the outbox before commits.db, so a commit landing between the two lookups is never missed (swamp-club#3617)", async () => {
  const chunk = "c".repeat(64);
  // A writer's commit naming `chunk` is prepared; whichever store is asked
  // first, the writer appends and settles before the second is asked.
  let stage: "prepared" | "settled" = "prepared";
  const commitStore = {
    referencedChunks(_ns: string, hashes: readonly string[]) {
      const found = new Set(
        stage === "settled" ? hashes.filter((h) => h === chunk) : [],
      );
      stage = "settled";
      return Promise.resolve(found);
    },
  };
  const outbox = {
    referencedChunks(_ns: string, hashes: readonly string[]) {
      const found = new Set(
        stage === "prepared" ? hashes.filter((h) => h === chunk) : [],
      );
      stage = "settled";
      return Promise.resolve(found);
    },
  };
  assertEquals(
    await referencedChunksOf(commitStore, outbox, "", [chunk]),
    new Set([chunk]),
  );
});
