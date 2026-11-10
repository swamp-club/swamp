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

import { RunStartChanges } from "../../domain/datastore_v3/repository_changes.ts";
import {
  AppendUnrecordedError,
  type TypedChange,
} from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import { CommitRejectedError } from "../../domain/datastore_v3/partition.ts";
import {
  setV3DatastoreFaultsForTesting,
  type V3Datastore,
} from "./v3_datastore.ts";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import { WorkflowRunCheckpointer } from "../persistence/workflow_run_checkpointer.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";
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
  offlineSubjectOf,
  openV3Datastore,
  referencedChunksOf,
  restoreV3FormatMarker,
  unreachableAsCatchUpError,
  V3_CHECKOUT_FILTER_CHANGED_CODE,
  v3CheckoutFilterRefusal,
  v3MarkerState,
} from "./v3_datastore.ts";
import {
  ReadModelApplyError,
  ReadModelCatchUpUnreachableError,
} from "../../domain/datastore_v3/read_model.ts";
import { readModelStateDir, v3CatalogPath } from "./record_path_guard.ts";
import { READ_MODEL_STATE_FILE } from "./sqlite_read_model.ts";
import { writerAliveFrom } from "./commit_outbox_recovery.ts";
import { localProcess } from "./process_identity.ts";
import { DatabaseSync } from "node:sqlite";
import {
  COMMIT_STORE_SCHEMA_VERSION,
  openCommitsDatabase,
} from "./sqlite_commit_store.ts";
import { ensureSupportedDatastoreFormat } from "../persistence/datastore_format_guard.ts";
import { UserError } from "../../domain/errors.ts";
import { writeDatastoreFormatMarker } from "../persistence/datastore_format_marker_writer.ts";
import {
  V3_COPY_SETUP_RACED_CODE,
  V3CopySetupRacedError,
} from "../../domain/datastore_v3/copy_setup_raced_error.ts";
import {
  blobPut,
  deleteVersion,
  MODEL_ID,
  MODEL_TYPE,
  modelCommit,
  savePut,
  versionOp,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import { SOLO_NAMESPACE } from "../../domain/data/namespace.ts";
import { DEFAULT_DATASTORE_SUBDIRS } from "../../domain/datastore/datastore_config.ts";
import { Data } from "../../domain/data/data.ts";
import { ModelOutput } from "../../domain/models/model_output.ts";
import type { DefinitionId } from "../../domain/definitions/definition.ts";
import { CatalogStore } from "../persistence/catalog_store.ts";
import { FileSystemUnifiedDataRepository } from "../persistence/unified_data_repository.ts";
import { YamlOutputRepository } from "../persistence/yaml_output_repository.ts";
import { ServeCommitRefusedError } from "./serve_upstream_errors.ts";

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
    await writeDatastoreFormatMarker(dir, { format: 3, minReaderFormat: 3 });
    assert(await isFreshV3Skeleton(dir));
    await initializeV3Datastore(dir, "test");
    assert(await isFreshV3Skeleton(dir), "still empty once completed");

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
      assertEquals(engine.committedBeforeThrowing(refused), false);
      assertEquals(engine.committedBeforeThrowing(new Error("x")), false);
    } finally {
      await handle.close();
    }
  });
});

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
    assertEquals(
      [...Deno.readDirSync(datastorePath)].map((entry) => entry.name)
        .filter((name) => name.startsWith(`${COMMITS_DB_FILE}-`)),
      [],
    );
    const before = await Deno.readFile(dbPath);

    assertEquals(listV3Namespaces(datastorePath, datastorePath), ["team"]);

    assertEquals(await Deno.readFile(dbPath), before);
    await commitIn(dir, datastorePath, "infra");
    assertEquals(listV3Namespaces(datastorePath, datastorePath), [
      "infra",
      "team",
    ]);
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;

Deno.test("openV3Datastore: compactBefore folds a quiet history up to the cutoff, never inside the policy's last day, and the sweep then reclaims removed content (swamp-club#3473, swamp-club#3916)", async () => {
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
    const signal = () => new AbortController().signal;
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
        [30, [await blobPut("a", 1, reaped), versionOp("a", 1)]],
        [10, [deleteVersion("a", 1)]],
        [5, [await blobPut("b", 1, kept), versionOp("b", 1)]],
        [1.5, [await savePut("c", 1), versionOp("c", 1)]],
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

      assertEquals(await handle.compactIfDue(signal()), undefined);

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

      const cutoff = new Date(now - 3 * DAY_MS);
      const folded = await handle.compactBefore(cutoff, signal());
      assertEquals(folded.bound.toISOString(), ago(3));
      assertEquals(folded.compactedThrough, 3);
      assertEquals(folded.report?.compacted, 2);
      assertEquals(await handle.describe(), {
        storedCommits: 1,
        compactedThrough: 3,
      });
      assertEquals((await handle.collectChunks(signal())).deleted, 0);
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

      await handle.commitStore.append(
        modelCommit(5, [await savePut("d", 1), versionOp("d", 1)], {
          at: ago(0.5),
          txnId: "txn-5",
        }),
      );
      const latest = await handle.compactBefore(new Date(now), signal());
      assertEquals(latest.bound.toISOString(), ago(1));
      assertEquals(latest.compactedThrough, 4);
      assertEquals(await handle.describe(), {
        storedCommits: 1,
        compactedThrough: 4,
      });
      const again = await handle.compactBefore(new Date(now), signal());
      assertEquals(again.report, undefined);
      assertEquals(again.compactedThrough, 4);
    } finally {
      await handle.close();
    }
  });
});

Deno.test("openV3Datastore: a compaction stopped between batches keeps what it folded, and the next one goes on (swamp-club#3916)", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const now = Date.parse("2030-01-01T00:00:00.000Z");
    const handle = openV3Datastore({
      repoDir: join(dir, "a"),
      datastorePath,
      clock: () => new Date(now),
    });
    try {
      for (let seq = 1; seq <= 3500; seq++) {
        await handle.commitStore.append(
          modelCommit(seq, [await savePut("a", seq), versionOp("a", seq)], {
            at: new Date(now - 60_000).toISOString(),
          }),
        );
      }
      const controller = new AbortController();
      const signal = controller.signal;
      const check = signal.throwIfAborted.bind(signal);
      let checks = 0;
      signal.throwIfAborted = () => {
        if (++checks === 2) {
          controller.abort(new DOMException("budget", "TimeoutError"));
        }
        check();
      };
      await assertRejects(() => handle.compactIfDue(signal));
      assertEquals(await handle.describe(), {
        storedCommits: 3250,
        compactedThrough: 250,
      });
      const report = await handle.compactIfDue(new AbortController().signal);
      assertEquals(report?.point, 1000);
      assertEquals(await handle.describe(), {
        storedCommits: 2500,
        compactedThrough: 1000,
      });
    } finally {
      await handle.close();
    }
  });
});

Deno.test("openV3Datastore: compactIfDue folds commits written moments ago once 500 lie below the newest 2,500, and a retry of a folded commit is still a duplicate (swamp-club#3916)", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const now = Date.parse("2030-01-01T00:00:00.000Z");
    const handle = openV3Datastore({
      repoDir: join(dir, "a"),
      datastorePath,
      clock: () => new Date(now),
    });
    const signal = () => new AbortController().signal;
    const commit = async (seq: number) =>
      modelCommit(seq, [await savePut("a", seq), versionOp("a", seq)], {
        at: new Date(now - 60_000).toISOString(),
      });
    try {
      for (let seq = 1; seq <= 2999; seq++) {
        await handle.commitStore.append(await commit(seq));
      }
      assertEquals(await handle.compactIfDue(signal()), undefined);
      await handle.commitStore.append(await commit(3000));
      const report = await handle.compactIfDue(signal());
      assertEquals(report?.point, 500);
      assertEquals(report?.compacted, 500);
      assertEquals(await handle.describe(), {
        storedCommits: 2500,
        compactedThrough: 500,
      });
      assertEquals(await handle.commitStore.append(await commit(1)), {
        kind: "duplicate",
        seq: 1,
      });
      assertEquals(await handle.commitStore.append(await commit(500)), {
        kind: "duplicate",
        seq: 500,
      });
      assertEquals(await handle.commitStore.append(await commit(3001)), {
        kind: "appended",
        seq: 3001,
      });
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

const MARKER = "datastore-format.json";
const LOST_MARKERS: readonly (string | undefined)[] = [
  undefined,
  "",
  " \n\t",
  "\0".repeat(64),
];

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
      const dir = join(root, "datastore");
      await initializeV3Datastore(dir, "test");
      await commitIn(root, dir, "");
      await setMarker(dir, lost);
      assertEquals(await isFreshV3Skeleton(dir), false, label);
    });
    await withTempDir(async (root) => {
      const dir = join(root, "datastore");
      await initializeV3Datastore(dir, "test");
      const db = new DatabaseSync(join(dir, COMMITS_DB_FILE));
      db.exec("UPDATE compaction SET point = 7 WHERE id = 1");
      db.close();
      await setMarker(dir, lost);
      assertEquals(await isFreshV3Skeleton(dir), false, label);
    });
    await withTempDir(async (root) => {
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
      assertEquals(await names(dir), before, label);
    });
    await withTempDir(async (root) => {
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
      await Deno.writeFile(commitsDb, new Uint8Array());
      assert(await isFreshV3Skeleton(dir), `${label} empty file`);
      const wal = new DatabaseSync(commitsDb);
      wal.exec("PRAGMA journal_mode=WAL");
      wal.close();
      assert(await isFreshV3Skeleton(dir), `${label} WAL, no schema`);
      await Deno.remove(commitsDb);
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
    new DatabaseSync(commitsDb).close();
    await refused("is not a v3 commit log");
    await Deno.remove(commitsDb);
    const newer = openCommitsDatabase(commitsDb);
    newer.exec(`PRAGMA user_version=${COMMIT_STORE_SCHEMA_VERSION + 1}`);
    newer.close();
    await refused(`newer than this swamp's ${COMMIT_STORE_SCHEMA_VERSION}`);
    await Deno.remove(commitsDb);
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function forgetCheckoutFilter(repoDir: string): void {
  const db = new DatabaseSync(
    join(readModelStateDir(Deno.realPathSync(repoDir)), READ_MODEL_STATE_FILE),
  );
  try {
    db.exec("DELETE FROM checkout_filter");
  } finally {
    db.close();
  }
}

Deno.test("openV3Datastore: refuses a checkout whose directories changed since it was projected, opening nothing, and opens again with the previous ones (swamp-club#3691)", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const repoDir = join(dir, "a");
    const projected = {
      directories: ["data", "config"],
      exclude: ["**/*.tmp"],
    };
    const first = openV3Datastore({ repoDir, datastorePath, ...projected });
    const commitsDb = first.commitsDbPath;
    const catalogDb = v3CatalogPath(Deno.realPathSync(repoDir));
    try {
      await first.catchUp();
    } finally {
      await first.close();
    }
    await openV3Datastore({
      repoDir,
      datastorePath,
      directories: ["config", "data", "config"],
      exclude: ["**/*.tmp"],
    }).close();
    // SQLite removes a database's WAL once its last connection closes: a
    // handle the refusal leaked would keep one.
    for (const db of [commitsDb, catalogDb]) {
      assertEquals(await pathExists(`${db}-wal`), false, db);
    }

    const writer = {
      host: Deno.hostname(),
      pid: 99_999_999,
      instance: crypto.randomUUID(),
    };
    for (
      const changed of [
        { directories: ["config"], exclude: ["**/*.tmp"] },
        { directories: ["data", "config"] },
        {},
      ]
    ) {
      const error = assertThrows(
        () => openV3Datastore({ repoDir, datastorePath, writer, ...changed }),
        UserError,
        "directories",
      );
      assertEquals(error.code, V3_CHECKOUT_FILTER_CHANGED_CODE);
    }
    for (const db of [commitsDb, catalogDb]) {
      assertEquals(await pathExists(`${db}-wal`), false, db);
    }
    assertEquals(
      writerAliveFrom(await localProcess())(writer, undefined),
      false,
      "the refused handle's writer was never registered",
    );

    const again = openV3Datastore({ repoDir, datastorePath, ...projected });
    try {
      await again.catchUp();
    } finally {
      await again.close();
    }
  });
});

Deno.test("openV3Datastore: a checkout with no recorded filter is stamped with the current one (swamp-club#3691)", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const repoDir = join(dir, "a");
    await openV3Datastore({ repoDir, datastorePath }).close();
    forgetCheckoutFilter(repoDir);
    await openV3Datastore({
      repoDir,
      datastorePath,
      directories: ["config"],
    }).close();
    assertThrows(
      () => openV3Datastore({ repoDir, datastorePath }),
      UserError,
      "directories",
    );
    await openV3Datastore({
      repoDir,
      datastorePath,
      directories: ["config"],
    }).close();
  });
});

Deno.test("v3CheckoutFilterRefusal: names a changed filter without opening the checkout or stamping one (swamp-club#3691)", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const repoDir = join(dir, "a");
    await Deno.mkdir(repoDir);
    assertEquals(
      v3CheckoutFilterRefusal(repoDir, ["config"], undefined),
      undefined,
    );
    await openV3Datastore({ repoDir, datastorePath }).close();
    assertEquals(
      v3CheckoutFilterRefusal(repoDir, undefined, undefined),
      undefined,
    );
    const refusal = v3CheckoutFilterRefusal(repoDir, ["config"], undefined);
    assert(refusal?.includes("directories"), refusal);

    forgetCheckoutFilter(repoDir);
    assertEquals(
      v3CheckoutFilterRefusal(repoDir, ["config"], undefined),
      undefined,
    );
    await openV3Datastore({ repoDir, datastorePath }).close();
  });
});

Deno.test("openV3Datastore: the default directories listed in full and left out are one filter, in either order (swamp-club#3691)", async () => {
  // Setup writes the default set out in full; an override such as
  // SWAMP_DATASTORE gives none.
  const listed = { directories: [...DEFAULT_DATASTORE_SUBDIRS].reverse() };
  for (const [first, second] of [[listed, {}], [{}, listed]]) {
    await withTempDir(async (dir) => {
      const datastorePath = join(dir, "datastore");
      await initializeV3Datastore(datastorePath, "test");
      const repoDir = join(dir, "a");
      await openV3Datastore({ repoDir, datastorePath, ...first }).close();
      await openV3Datastore({ repoDir, datastorePath, ...second }).close();
    });
  }
});

Deno.test("openV3Datastore: exclude patterns without a negation are one filter in any order, while reordering a negation is refused (swamp-club#3691)", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const plain = join(dir, "plain");
    await openV3Datastore({
      repoDir: plain,
      datastorePath,
      exclude: ["**/*.tmp", "data/scratch/**"],
    }).close();
    await openV3Datastore({
      repoDir: plain,
      datastorePath,
      exclude: [" data/scratch/** ", "**/*.tmp", "# a comment", "**/*.tmp"],
    }).close();

    // With a negation the last match wins, so the order is the filter.
    const negated = join(dir, "negated");
    await openV3Datastore({
      repoDir: negated,
      datastorePath,
      exclude: ["data/**", "!data/keep/**"],
    }).close();
    const error = assertThrows(
      () =>
        openV3Datastore({
          repoDir: negated,
          datastorePath,
          exclude: ["!data/keep/**", "data/**"],
        }),
      UserError,
    );
    assertEquals(error.code, V3_CHECKOUT_FILTER_CHANGED_CODE);
  });
});

Deno.test("V3CheckoutFilterChangedError: says the change is the repository's, affects every checkout, and that a fresh checkout loses the local-only files (swamp-club#3691)", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const repoDir = join(dir, "a");
    await openV3Datastore({
      repoDir,
      datastorePath,
      directories: ["config", "outputs"],
    }).close();
    const error = assertThrows(
      () => openV3Datastore({ repoDir, datastorePath }),
      UserError,
    );
    const message = error.message;
    assertStringIncludes(message, "repository's datastore config");
    assertStringIncludes(message, "every existing checkout");
    assertStringIncludes(message, "never committed");
    assertStringIncludes(message, "copy them out");
    assertStringIncludes(
      message,
      join(Deno.realPathSync(repoDir), ".swamp", "data"),
    );
    assert(
      message.indexOf("Restore the previous directories") <
        message.indexOf("fresh checkout"),
      message,
    );
  });
});

function checkoutWriter(dir: string) {
  const datastorePath = join(dir, "datastore");
  const repoDir = join(dir, "a");
  const handle = openV3Datastore({ repoDir, datastorePath });
  const hook = () => Promise.resolve();
  const engine = handle.engineFor(hook, () => {
    throw new Error("no run repository needed");
  });
  const data = new FileSystemUnifiedDataRepository(
    repoDir,
    swampPath(repoDir, "data"),
    new CatalogStore(join(dir, "_catalog.db")),
    hook,
    undefined,
    SOLO_NAMESPACE,
    true,
  );
  const outputs = new YamlOutputRepository(
    repoDir,
    swampPath(repoDir, "outputs"),
    hook,
  );
  return {
    handle,
    data,
    outputs,
    kept: <T>(fn: () => Promise<T>) => engine.runRoot({}, fn),
    dropped: <T>(fn: () => Promise<T>) =>
      engine.runRoot({ disposition: () => "discard" }, fn),
    listed: async (name: string): Promise<string[]> => {
      const dir = data.getDataNameDir(MODEL_TYPE, MODEL_ID, name);
      try {
        return (await Array.fromAsync(Deno.readDir(dir)))
          .map((entry) => entry.name)
          .sort();
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return [];
        throw error;
      }
    },
  };
}

function dataNamed(name: string): Data {
  return Data.create({
    name,
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource" },
    ownerDefinition: { ownerType: "manual", ownerRef: "test" },
  });
}

for (const name of [".kubeconfig", "kubeconfig"]) {
  Deno.test(`openV3Datastore: a dropped save of data ${name} is swept, leaving the versions the datastore holds (swamp-club#3736)`, async () => {
    await withTempDir(async (dir) => {
      await initializeV3Datastore(join(dir, "datastore"), "test");
      const writer = checkoutWriter(dir);
      const bytes = new TextEncoder().encode("apiVersion: v1\n");
      try {
        await writer.kept(() =>
          writer.data.save(MODEL_TYPE, MODEL_ID, dataNamed(name), bytes)
        );
        await writer.dropped(() =>
          writer.data.save(MODEL_TYPE, MODEL_ID, dataNamed(name), bytes)
        );
        assertEquals(await writer.listed(name), ["1", "2", "latest"]);
        assertEquals(await writer.handle.recoverDroppedWork(), "recovered");
        assertEquals(await writer.listed(name), ["1", "latest"]);
        assertEquals(
          (await Deno.readTextFile(
            join(
              writer.data.getDataNameDir(MODEL_TYPE, MODEL_ID, name),
              "latest",
            ),
          )).trim(),
          "1",
        );
      } finally {
        await writer.handle.close();
      }
    });
  });

  Deno.test(`openV3Datastore: a dropped first save of data ${name} leaves no version and no latest (swamp-club#3736)`, async () => {
    await withTempDir(async (dir) => {
      await initializeV3Datastore(join(dir, "datastore"), "test");
      const writer = checkoutWriter(dir);
      try {
        await writer.dropped(() =>
          writer.data.save(
            MODEL_TYPE,
            MODEL_ID,
            dataNamed(name),
            new TextEncoder().encode("apiVersion: v1\n"),
          )
        );
        assertEquals(await writer.handle.recoverDroppedWork(), "recovered");
        assertEquals(await writer.listed(name), []);
      } finally {
        await writer.handle.close();
      }
    });
  });
}

for (const method of [".probe", "probe"]) {
  Deno.test(`openV3Datastore: a dropped output of method ${method} is swept (swamp-club#3736)`, async () => {
    await withTempDir(async (dir) => {
      await initializeV3Datastore(join(dir, "datastore"), "test");
      const writer = checkoutWriter(dir);
      try {
        const output = ModelOutput.create({
          definitionId: MODEL_ID as DefinitionId,
          provenance: {
            definitionHash: "abc123",
            modelVersion: "2026.02.09.1",
            triggeredBy: "manual",
          },
          methodName: method,
          status: "failed",
          startedAt: new Date(),
        });
        await writer.dropped(() =>
          writer.outputs.save(MODEL_TYPE, method, output)
        );
        const methodDir = swampPath(
          join(dir, "a"),
          "outputs",
          MODEL_TYPE.normalized,
          method,
        );
        assertEquals(
          (await Array.fromAsync(Deno.readDir(methodDir))).length,
          1,
        );
        assertEquals(await writer.handle.recoverDroppedWork(), "recovered");
        const left = await Array.fromAsync(Deno.readDir(methodDir)).catch(
          (error) => {
            if (error instanceof Deno.errors.NotFound) return [];
            throw error;
          },
        );
        assertEquals(left, []);
      } finally {
        await writer.handle.close();
      }
    });
  });
}

for (const old of [true, false]) {
  const label = old ? "an old mtime" : "a new mtime";
  Deno.test(`openV3Datastore: a dropped getFilePath write whose file has ${label} is swept (swamp-club#3736)`, async () => {
    await withTempDir(async (dir) => {
      await initializeV3Datastore(join(dir, "datastore"), "test");
      const writer = checkoutWriter(dir);
      const bytes = new TextEncoder().encode("artifact\n");
      try {
        await assertRejects(() =>
          writer.dropped(async () => {
            const { contentPath } = await writer.data.allocateVersion(
              MODEL_TYPE,
              MODEL_ID,
              dataNamed("artifact"),
            );
            await Deno.writeFile(contentPath, bytes);
            if (old) {
              const longAgo = new Date("2020-01-01T00:00:00.000Z");
              await Deno.utime(contentPath, longAgo, longAgo);
            }
            throw new Error("the method failed");
          })
        );
        assertEquals(await writer.listed("artifact"), ["1"]);
        assertEquals(await writer.handle.recoverDroppedWork(), "recovered");
        assertEquals(await writer.listed("artifact"), []);
        await writer.kept(() =>
          writer.data.save(MODEL_TYPE, MODEL_ID, dataNamed("artifact"), bytes)
        );
        assertEquals(await writer.listed("artifact"), ["2", "latest"]);
      } finally {
        await writer.handle.close();
      }
    });
  });

  Deno.test(`openV3Datastore: a dropped save whose files have ${label} is swept, leaving the committed version (swamp-club#3736)`, async () => {
    await withTempDir(async (dir) => {
      await initializeV3Datastore(join(dir, "datastore"), "test");
      const writer = checkoutWriter(dir);
      const bytes = new TextEncoder().encode("artifact\n");
      try {
        await writer.kept(() =>
          writer.data.save(MODEL_TYPE, MODEL_ID, dataNamed("artifact"), bytes)
        );
        await writer.dropped(async () => {
          await writer.data.save(
            MODEL_TYPE,
            MODEL_ID,
            dataNamed("artifact"),
            bytes,
          );
          if (old) {
            const longAgo = new Date("2020-01-01T00:00:00.000Z");
            const versionDir = join(
              writer.data.getDataNameDir(MODEL_TYPE, MODEL_ID, "artifact"),
              "2",
            );
            for await (const entry of Deno.readDir(versionDir)) {
              await Deno.utime(join(versionDir, entry.name), longAgo, longAgo);
            }
          }
        });
        assertEquals(await writer.handle.recoverDroppedWork(), "recovered");
        assertEquals(await writer.listed("artifact"), ["1", "latest"]);
      } finally {
        await writer.handle.close();
      }
    });
  });
}

Deno.test("unreachableAsCatchUpError: a catch-up the storage cut off fails with the catch-up code, whichever catch-up it is, and any other failure as it is (swamp-club#3802, swamp-club#3803)", async () => {
  const cutOff = new ReadModelApplyError("", "p", 1, "error reading a body", {
    cause: new Deno.errors.ConnectionReset("reset by peer"),
  });
  await assertRejects(
    () => unreachableAsCatchUpError(() => Promise.reject(cutOff)),
    ReadModelCatchUpUnreachableError,
  );
  const other = new ReadModelApplyError("", "p", 1, "a refused key");
  const thrown = await assertRejects(() =>
    unreachableAsCatchUpError(() => Promise.reject(other))
  );
  assertEquals(thrown, other);
  assertEquals(await unreachableAsCatchUpError(() => Promise.resolve(3)), 3);
});

Deno.test("offlineSubjectOf: names a definition by its kind and name, never by its partition key (swamp-club#4195)", () => {
  assertEquals(
    offlineSubjectOf(
      partitionOf({ kind: "config", definitionKind: "model", name: "delta" }),
    ),
    'the behavior definition "delta"',
  );
  assertEquals(
    offlineSubjectOf(
      partitionOf({ kind: "config", definitionKind: "workflow", name: "w" }),
    ),
    'the workflow definition "w"',
  );
  assertEquals(
    offlineSubjectOf(partitionOf({ kind: "lockfile" })),
    "the extension lockfile",
  );
});

Deno.test("initializeV3Datastore: two creators of a copy that adopts the winner's marker both finish setting it up (swamp-club#4253)", async () => {
  await withTempDir(async (root) => {
    // Several fresh copies, so the marker race is met on every run.
    for (let i = 0; i < 20; i++) {
      const dir = join(root, `copy-${i}`, "serve-x");
      const create = async () => {
        const markerSeen = await v3MarkerState(dir);
        if (markerSeen === "v3") return;
        await initializeV3Datastore(dir, "test", {
          adoptConcurrentMarker: { markerSeen },
        });
      };
      const results = await Promise.allSettled([create(), create()]);
      assertEquals(
        results.map((result) => result.status),
        ["fulfilled", "fulfilled"],
        `copy ${i}`,
      );
      assertEquals(await v3MarkerState(dir), "v3");
      assert((await Deno.lstat(join(dir, COMMITS_DB_FILE))).isFile);
      assert((await Deno.lstat(join(dir, "_blobs"))).isDirectory);
      assert(await isFreshV3Skeleton(dir));
    }
  });
});

Deno.test("initializeV3Datastore: a copy uses a v3 marker that appeared while it wrote its own; setup still refuses it, and an unreadable one is a retryable refusal (swamp-club#4253)", async () => {
  await withTempDir(async (root) => {
    const raced = (marker: string) => async (_from: string, to: string) => {
      await Deno.writeTextFile(to, marker);
      throw new Deno.errors.AlreadyExists("lost the race");
    };
    const winner = '{"format":3,"minReaderFormat":3,"writtenBy":"winner"}';

    const adopted = join(root, "adopted");
    await initializeV3Datastore(adopted, "test", {
      adoptConcurrentMarker: { markerSeen: "absent" },
      link: raced(winner),
    });
    assertEquals(
      JSON.parse(await Deno.readTextFile(join(adopted, MARKER))).writtenBy,
      "winner",
    );
    assert((await Deno.lstat(join(adopted, COMMITS_DB_FILE))).isFile);
    assert((await Deno.lstat(join(adopted, "_blobs"))).isDirectory);

    const setup = join(root, "setup");
    await assertRejects(
      () => initializeV3Datastore(setup, "test", { link: raced(winner) }),
      UserError,
      "already exists",
    );

    for (const partial of ["", '{"format":']) {
      const dir = join(root, `partial-${partial.length}`);
      const error = await assertRejects(
        () =>
          initializeV3Datastore(dir, "test", {
            adoptConcurrentMarker: { markerSeen: "absent" },
            link: raced(partial),
          }),
        V3CopySetupRacedError,
      );
      assertEquals(error.code, V3_COPY_SETUP_RACED_CODE);
    }

    // A marker the caller saw before deciding to create the copy is no
    // creator's race: it is refused as before, without the retryable code.
    const foreign = join(root, "foreign");
    await Deno.mkdir(foreign);
    await Deno.writeTextFile(join(foreign, MARKER), '{"format":2}');
    await Deno.writeTextFile(join(foreign, "unrelated.txt"), "x");
    const markerSeen = await v3MarkerState(foreign);
    assertEquals(markerSeen, "other");
    const refused = await assertRejects(
      () =>
        initializeV3Datastore(foreign, "test", {
          adoptConcurrentMarker: { markerSeen: "other" },
        }),
      UserError,
      "already exists",
    );
    assertEquals(refused.code, undefined);
  });
});

Deno.test("initializeV3Datastore: a copy that saw no marker adopts the winner's, however far the winner has got: marked, its temp file not yet removed, or fully bound (swamp-club#4253)", async () => {
  await withTempDir(async (root) => {
    const winner = { format: 3, minReaderFormat: 3, writtenBy: "winner" };
    const stages: Record<string, (dir: string) => Promise<void>> = {
      marked: async () => {},
      "temp file left": async (dir) => {
        await Deno.writeTextFile(join(dir, `.${crypto.randomUUID()}.tmp`), "");
      },
      bound: async (dir) => {
        await initializeV3Datastore(dir, "winner");
        await Deno.writeTextFile(join(dir, "serve_upstream.db"), "");
      },
    };
    for (const [name, stage] of Object.entries(stages)) {
      const dir = join(root, name.replaceAll(" ", "-"));
      await Deno.mkdir(dir);
      await writeDatastoreFormatMarker(dir, winner);
      await stage(dir);
      await initializeV3Datastore(dir, "test", {
        adoptConcurrentMarker: { markerSeen: "absent" },
      });
      assertEquals(
        JSON.parse(await Deno.readTextFile(join(dir, MARKER))).writtenBy,
        "winner",
        name,
      );
      assert((await Deno.lstat(join(dir, COMMITS_DB_FILE))).isFile, name);
      assert((await Deno.lstat(join(dir, "_blobs"))).isDirectory, name);
    }

    const setup = join(root, "setup");
    await Deno.mkdir(setup);
    await writeDatastoreFormatMarker(setup, winner);
    await stages["temp file left"](setup);
    await assertRejects(
      () => initializeV3Datastore(setup, "test"),
      UserError,
      "already exists",
    );
  });
});

function stepStartChange(): TypedChange {
  const workflowId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  return new RunStartChanges(workflowId, runId).write(
    recordKeyOf([
      "workflow-runs",
      workflowId,
      "starts",
      runId,
      `${"d".repeat(64)}.yaml`,
    ]),
    new TextEncoder().encode("startedAt: 1\n"),
  );
}

async function appendWithSinkFaults(
  fail: (attempt: number) => Error | undefined,
  run: (
    engine: ReturnType<V3Datastore["engineFor"]>,
  ) => Promise<void>,
): Promise<number> {
  let attempts = 0;
  setV3DatastoreFaultsForTesting({
    wrapSink: (sink) => ({
      ...sink,
      append: (commit) => {
        const starts = commit.ops.some((op) =>
          "intent" in op && op.intent.kind === "run-start.save"
        );
        if (!starts) return sink.append(commit);
        const error = fail(++attempts);
        return error === undefined
          ? sink.append(commit)
          : Promise.reject(error);
      },
    }),
  });
  try {
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
        await engine.runRoot({}, async () => {
          const unit = engine.openUnit() as unknown as CommitLogUnitOfWork;
          await runInUnitOfWork(unit, () => run(engine));
          await unit.commit();
        });
      } finally {
        await handle.close();
      }
    });
  } finally {
    setV3DatastoreFaultsForTesting(undefined);
  }
  return attempts;
}

function connectionRefused(): Error {
  return Object.assign(new Error("connect ECONNREFUSED"), {
    code: "ECONNREFUSED",
  });
}

Deno.test("openV3Datastore: a step start the network fails once is appended again and commits (swamp-club#4319)", async () => {
  const attempts = await appendWithSinkFaults(
    (attempt) => attempt === 1 ? connectionRefused() : undefined,
    async (engine) => {
      assertEquals(
        await engine.appendToOpenUnit!([stepStartChange()]),
        "committed",
      );
    },
  );
  assertEquals(attempts, 2);
});

Deno.test("openV3Datastore: a step start the network keeps failing gives up within the bounded retry as unrecorded (swamp-club#4319)", async () => {
  const attempts = await appendWithSinkFaults(
    () => connectionRefused(),
    async (engine) => {
      const error = await assertRejects(
        () => engine.appendToOpenUnit!([stepStartChange()]),
        AppendUnrecordedError,
      );
      assertEquals(error.refused, false);
    },
  );
  assertEquals(attempts, 3);
});

Deno.test("openV3Datastore: a step start the datastore refuses is not retried (swamp-club#4319)", async () => {
  const attempts = await appendWithSinkFaults(
    () => new CommitRejectedError("expect-failed", "refused"),
    async (engine) => {
      const error = await assertRejects(
        () => engine.appendToOpenUnit!([stepStartChange()]),
        AppendUnrecordedError,
      );
      assertEquals(error.refused, true);
    },
  );
  assertEquals(attempts, 1);
});

Deno.test("openV3Datastore: a step start serve refuses is unrecorded as refused and not retried (swamp-club#4368)", async () => {
  const attempts = await appendWithSinkFaults(
    () =>
      new ServeCommitRefusedError(
        "forbidden",
        "content-refused",
        0,
        "it records an approval decision serve does not hold",
      ),
    async (engine) => {
      const error = await assertRejects(
        () => engine.appendToOpenUnit!([stepStartChange()]),
        AppendUnrecordedError,
      );
      assertEquals(error.refused, true);
    },
  );
  assertEquals(attempts, 1);
});

Deno.test("openV3Datastore: a run's paced checkpoint is timed from its own unit's flushes, so another run flushing on the same engine never pushes it back (swamp-club#4574)", async () => {
  await withTempDir(async (root) => {
    const dir = join(root, "datastore");
    await Deno.mkdir(dir);
    await initializeV3Datastore(dir, "test");
    const handle = openV3Datastore({
      repoDir: join(root, "repo"),
      datastorePath: dir,
    });
    try {
      const markDirty = () => Promise.resolve();
      const engine = handle.engineFor(markDirty, () => {
        throw new Error("no run repository needed");
      });
      const stage = async (unit: CommitLogUnitOfWork, name: string) =>
        await unit.stageOps([
          new AutoDefinitionChanges(crypto.randomUUID()).write(
            recordKeyOf(["auto-definitions", `${name}.yaml`]),
            new TextEncoder().encode(crypto.randomUUID()),
          ),
        ]);
      let xCheckpoints = 0;
      let yFlushing = true;
      const checkpointer = new WorkflowRunCheckpointer({
        markDirty,
        commitLog: {
          ...engine,
          checkpointOpenUnit: (options) => {
            xCheckpoints++;
            return engine.checkpointOpenUnit(options);
          },
        },
      }, { intervalMs: 50 });
      const run = WorkflowRun.create(Workflow.create({
        name: "x",
        jobs: [Job.create({
          name: "main",
          steps: [Step.create({ name: "a", task: StepTask.model("w", "m") })],
        })],
      }));
      const runX = engine.runRoot({}, async () => {
        const unit = engine.openUnit() as unknown as CommitLogUnitOfWork;
        await runInUnitOfWork(unit, async () => {
          await stage(unit, "x");
          await checkpointer.checkpoint(run);
          // inside the interval: one trailing checkpoint is due 50 ms on
          await stage(unit, "x");
          await checkpointer.checkpoint(run);
          await waitFor(
            () => xCheckpoints >= 2,
            "run X's trailing checkpoint",
            {
              timeoutMs: 3_000,
            },
          ).finally(() => {
            yFlushing = false;
          });
        });
        await checkpointer.close();
        await unit.commit();
      });
      const runY = engine.runRoot({}, async () => {
        const unit = engine.openUnit() as unknown as CommitLogUnitOfWork;
        await runInUnitOfWork(unit, async () => {
          while (yFlushing) {
            await stage(unit, "y");
            await engine.checkpointOpenUnit();
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        });
        await unit.commit();
      });
      await Promise.all([runX, runY]);
      assertEquals(xCheckpoints, 2);
    } finally {
      await handle.close();
    }
  });
});

Deno.test("openV3Datastore: a flush made from a nested unit, as a step's batch is, counts for its run's root (swamp-club#4574)", async () => {
  await withTempDir(async (root) => {
    const dir = join(root, "datastore");
    await Deno.mkdir(dir);
    await initializeV3Datastore(dir, "test");
    const handle = openV3Datastore({
      repoDir: join(root, "repo"),
      datastorePath: dir,
    });
    try {
      const markDirty = () => Promise.resolve();
      const engine = handle.engineFor(markDirty, () => {
        throw new Error("no run repository needed");
      });
      await engine.runRoot({}, async () => {
        const run = engine.openUnit() as unknown as CommitLogUnitOfWork;
        await runInUnitOfWork(run, async () => {
          assertEquals(engine.lastCheckpointAt?.(), undefined);
          const step = engine.openUnit() as unknown as CommitLogUnitOfWork;
          await runInUnitOfWork(step, async () => {
            await step.stageOps([
              new AutoDefinitionChanges(crypto.randomUUID()).write(
                recordKeyOf(["auto-definitions", "step.yaml"]),
                new TextEncoder().encode("step"),
              ),
            ]);
            assertEquals(await engine.checkpointOpenUnit(), "committed");
          });
          await step.commit();
          assert(engine.lastCheckpointAt?.() !== undefined);
        });
        await run.commit();
      });
    } finally {
      await handle.close();
    }
  });
});
