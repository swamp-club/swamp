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

// The v3 commit-log unit of work against the real SQLite commit store and
// the filesystem `storage/1` on a temp directory (swamp-club#3240).

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { ensureDir, walk } from "@std/fs";
import { join } from "@std/path";
import type { MarkDirtyHook } from "../src/domain/datastore/datastore_sync_service.ts";
import type { DatastoreSyncService } from "../src/domain/datastore/datastore_sync_service.ts";
import { SOLO_NAMESPACE } from "../src/domain/data/namespace.ts";
import { ChunkStore } from "../src/domain/datastore_v3/chunk_store.ts";
import type { Commit } from "../src/domain/datastore_v3/commit.ts";
import { MAX_INLINE_BYTES, type PutOp } from "../src/domain/datastore_v3/op.ts";
import { CommitRejectedError } from "../src/domain/datastore_v3/partition.ts";
import {
  dataKey,
  modelIntent,
  modelPartition,
  readAll,
  savePut,
  streamOf,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import { VaultConfig } from "../src/domain/vaults/vault_config.ts";
import { buildManagedLockfileTransaction } from "../src/cli/managed_config_sync.ts";
import {
  type CommitLogRootOptions,
  RUN_COMMIT_STATUSES,
  runInCommitLogRoot,
  runOutcomeDisposition,
} from "../src/infrastructure/datastore_v3/commit_log_root.ts";
import type { CommitSink } from "../src/infrastructure/datastore_v3/commit_log_unit_of_work.ts";
import {
  runPartition,
  runPut,
  WRITER,
} from "../src/infrastructure/datastore_v3/commit_log_test_helpers.ts";
import { SqliteCommitStore } from "../src/infrastructure/datastore_v3/sqlite_commit_store.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { DefaultDatastorePathResolver } from "../src/infrastructure/persistence/default_datastore_path_resolver.ts";
import { FileSystemStorage } from "../src/infrastructure/persistence/fs_datastore_storage.ts";
import {
  createRepositoryContext,
  type RepositoryContext,
} from "../src/infrastructure/persistence/repository_factory.ts";
import { unitOfWorkBinding } from "../src/infrastructure/persistence/unit_of_work_binding.ts";
import {
  signalChange,
  UnscopedWriteRefusedError,
} from "../src/infrastructure/persistence/unit_of_work_scope.ts";

await initializeLogging({});

const MODEL = modelPartition();

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

interface V3 {
  dir: string;
  store: SqliteCommitStore;
  storage: FileSystemStorage;
  chunkStore: ChunkStore;
  /** A hook standing for one v3 repository context. */
  hook: MarkDirtyHook;
  options(sink?: CommitSink): CommitLogRootOptions<unknown>;
  /** Every commit in a partition, in seq order. */
  commits(partition: typeof MODEL): Promise<readonly Commit[]>;
}

async function withV3(fn: (v3: V3) => Promise<void>): Promise<void> {
  await withTempDir(async (dir) => {
    const store = SqliteCommitStore.open(join(dir, "commits.db"));
    const storage = new FileSystemStorage(join(dir, "datastore"));
    const chunkStore = new ChunkStore(storage);
    try {
      await fn({
        dir,
        store,
        storage,
        chunkStore,
        hook: () => Promise.resolve(),
        options: (sink = store) => ({
          sink,
          chunkStore,
          namespace: SOLO_NAMESPACE,
          writer: WRITER,
          fence: 1,
          signal: AbortSignal.timeout(30_000),
        }),
        commits: async (partition) =>
          (await store.readPartition("", partition, 1, 1000)).map((change) =>
            change.commit
          ),
      });
    } finally {
      await store.close();
    }
  });
}

/** A sink over the store whose next append lands, then reports a failure. */
function lossySink(store: SqliteCommitStore): CommitSink & { calls: number } {
  let fail = true;
  const sink = {
    calls: 0,
    head: store.head.bind(store),
    async append(commit: Commit) {
      sink.calls++;
      const result = await store.append(commit);
      if (fail) {
        fail = false;
        throw new Error("connection lost after the commit landed");
      }
      return result;
    },
  };
  return sink;
}

function bytesOf(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 131 + 17) % 256;
  return bytes;
}

function pendingPut(
  name: string,
  content: Uint8Array | (() => ReadableStream<Uint8Array>),
) {
  return {
    partition: MODEL,
    put: {
      intent: modelIntent({ kind: "data.save", name, version: 1 }),
      key: dataKey(name, 1),
      content,
    },
  };
}

Deno.test("commit-log unit: staged typed changes land as one commit per partition", async () => {
  await withV3(async (v3) => {
    await runInCommitLogRoot(
      { markDirty: v3.hook },
      v3.options(),
      async (root) => {
        await root.stageOp({ partition: MODEL, op: await savePut("a", 1) });
        await root.stageOp({ partition: MODEL, op: await savePut("b", 1) });
        await root.stageOp({
          partition: runPartition(),
          op: await runPut("r"),
        });
      },
    );
    const model = await v3.commits(MODEL);
    assertEquals(model.length, 1);
    assertEquals(model[0].seq, 1);
    assertEquals(model[0].fence, 1);
    assertEquals(model[0].writer, WRITER);
    assertEquals(model[0].ops.length, 2);
    assertEquals((await v3.commits(runPartition())).length, 1);
  });
});

Deno.test("commit-log unit: data partitions land before the run record", async () => {
  await withV3(async (v3) => {
    await runInCommitLogRoot(
      { markDirty: v3.hook },
      v3.options(),
      async (root) => {
        await root.stageOp({
          partition: runPartition(),
          op: await runPut("r"),
        });
        await root.stageOp({ partition: MODEL, op: await savePut("a", 1) });
      },
    );
    const changes = await v3.store.changesSince(0, 10);
    assertEquals(
      changes.map((change) => change.commit.partition.kind),
      ["model", "run"],
    );
  });
});

Deno.test("commit-log unit: multi-chunk content is stored before the commit that names it", async () => {
  await withV3(async (v3) => {
    const content = bytesOf(v3.chunkStore.chunkBytes + 1024);
    const sink: CommitSink = {
      head: v3.store.head.bind(v3.store),
      async append(commit) {
        for (const op of commit.ops) {
          if (op.kind === "put" && "blob" in op.content) {
            const parts = op.content.blob.parts ?? [];
            assertEquals(
              parts.length,
              Math.ceil(content.length / v3.chunkStore.chunkBytes),
            );
            assert(parts.length > 1);
            const present = await v3.storage.has(
              "_default",
              parts.map((part) => part.sha256),
              AbortSignal.timeout(10_000),
            );
            assertEquals(present.size, parts.length);
          }
        }
        return await v3.store.append(commit);
      },
    };
    await runInCommitLogRoot(
      { markDirty: v3.hook },
      v3.options(sink),
      async (root) => {
        await root.stageOp(pendingPut("big", () => streamOf(content, [4096])));
        await root.stageOp(pendingPut("small", bytesOf(MAX_INLINE_BYTES)));
      },
    );
    const [commit] = await v3.commits(MODEL);
    const [big, small] = commit.ops as PutOp[];
    assert("blob" in big.content);
    assert("inline" in small.content);
    assertEquals(
      await readAll(
        v3.chunkStore.read(
          SOLO_NAMESPACE,
          big.content.blob,
          AbortSignal.timeout(10_000),
        ),
      ),
      content,
    );
  });
});

Deno.test("commit-log unit: a retry after an append that landed but reported failure lands once", async () => {
  await withV3(async (v3) => {
    const sink = lossySink(v3.store);
    await runInCommitLogRoot(
      { markDirty: v3.hook },
      v3.options(sink),
      async (root) => {
        await root.stageOp({ partition: MODEL, op: await savePut("a", 1) });
        await assertRejects(() => root.checkpoint(), Error, "connection lost");
      },
    );
    assertEquals(sink.calls, 2);
    assertEquals((await v3.commits(MODEL)).length, 1);
  });
});

Deno.test("commit-log unit: a refusal from the store surfaces unchanged", async () => {
  await withV3(async (v3) => {
    await runInCommitLogRoot(
      { markDirty: v3.hook },
      { ...v3.options(), fence: 5 },
      async (root) => {
        await root.stageOp({ partition: MODEL, op: await savePut("a", 1) });
      },
    );
    const error = await assertRejects(
      () =>
        runInCommitLogRoot(
          { markDirty: v3.hook },
          { ...v3.options(), fence: 4 },
          async (root) => {
            await root.stageOp({ partition: MODEL, op: await savePut("b", 1) });
          },
        ),
      CommitRejectedError,
    );
    assertEquals(error.reason, "stale-fence");
    assertEquals((await v3.commits(MODEL)).length, 1);
  });
});

Deno.test("commit-log unit: abandon discards, and stores no chunk", async () => {
  await withV3(async (v3) => {
    await assertRejects(() =>
      runInCommitLogRoot(
        { markDirty: v3.hook },
        v3.options(),
        async (root) => {
          await root.stageOp(pendingPut("big", bytesOf(MAX_INLINE_BYTES * 3)));
          throw new Error("operation failed");
        },
      )
    );
    assertEquals(await v3.store.changesSince(0, 10), []);
    // Nothing was written under the storage root (it may not even exist).
    await ensureDir(join(v3.dir, "datastore"));
    const chunks = [];
    for await (
      const entry of walk(join(v3.dir, "datastore"), { includeDirs: false })
    ) chunks.push(entry.path);
    assertEquals(chunks, []);
  });
});

Deno.test("commit-log unit: checkpoint commits and the unit keeps staging", async () => {
  await withV3(async (v3) => {
    await runInCommitLogRoot(
      { markDirty: v3.hook },
      v3.options(),
      async (root) => {
        await root.stageOp({ partition: MODEL, op: await savePut("a", 1) });
        await root.checkpoint();
        assertEquals((await v3.commits(MODEL)).length, 1);
        await root.stageOp({ partition: MODEL, op: await savePut("b", 1) });
      },
    );
    assertEquals((await v3.commits(MODEL)).map((commit) => commit.seq), [1, 2]);
  });
});

Deno.test("commit-log unit: a nested root over the same hook is a child that rolls up", async () => {
  await withV3(async (v3) => {
    await runInCommitLogRoot({ markDirty: v3.hook }, v3.options(), async () => {
      await runInCommitLogRoot(
        { markDirty: v3.hook },
        v3.options(),
        async (child) => {
          await child.stageOp({ partition: MODEL, op: await savePut("a", 1) });
        },
      );
      await assertRejects(() =>
        runInCommitLogRoot(
          { markDirty: v3.hook },
          v3.options(),
          async (child) => {
            await child.stageOp({
              partition: MODEL,
              op: await savePut("b", 1),
            });
            throw new Error("child failed");
          },
        )
      );
      assertEquals(await v3.store.changesSince(0, 10), []);
    });
    const [commit] = await v3.commits(MODEL);
    assertEquals(commit.ops.length, 1);
  });
});

Deno.test("commit-log unit: a run commits on each terminal status of decision 5, and discards when it throws", async () => {
  await withV3(async (v3) => {
    for (const status of RUN_COMMIT_STATUSES) {
      await runInCommitLogRoot(
        { markDirty: v3.hook },
        { ...v3.options(), disposition: runOutcomeDisposition },
        async (root) => {
          await root.stageOp({
            partition: runPartition(),
            op: await runPut(status),
          });
          return { status };
        },
      );
    }
    await assertRejects(() =>
      runInCommitLogRoot(
        { markDirty: v3.hook },
        { ...v3.options(), disposition: runOutcomeDisposition },
        async (root) => {
          await root.stageOp({
            partition: runPartition(),
            op: await runPut("stopped"),
          });
          throw new Error("early stop");
        },
      )
    );
    assertEquals(
      (await v3.commits(runPartition())).length,
      RUN_COMMIT_STATUSES.length,
    );
  });
});

/** A repository context on the temp directory over `hook`. */
async function repositoryContext(
  dir: string,
  hook: MarkDirtyHook,
): Promise<RepositoryContext> {
  const repoDir = join(dir, "repo");
  const cacheRoot = join(dir, "cache");
  await ensureDir(repoDir);
  await ensureDir(cacheRoot);
  const resolver = new DefaultDatastorePathResolver(repoDir, {
    type: "@test/remote",
    config: {},
    datastorePath: join(dir, "remote"),
    cachePath: cacheRoot,
  });
  return createRepositoryContext({
    repoDir,
    enableIndexing: false,
    datastoreResolver: resolver,
    markDirty: hook,
    vaultsDir: join(resolver.resolvePath("config"), "vaults"),
  });
}

function vault(): VaultConfig {
  return VaultConfig.create(
    crypto.randomUUID(),
    `probe-${crypto.randomUUID()}`,
    "local_encryption",
    {},
  );
}

Deno.test("commit-log unit: a repository write outside every unit on a v3 context is refused before it writes", async () => {
  await withV3(async (v3) => {
    const marks: (string | undefined)[] = [];
    const hook: MarkDirtyHook = (path) => {
      marks.push(path);
      return Promise.resolve();
    };
    // The opt-in marks the context when it builds it, before any root opens.
    unitOfWorkBinding.requireUnit(hook);
    const ctx = await repositoryContext(v3.dir, hook);
    try {
      const config = vault();
      await assertRejects(
        () => ctx.vaultConfigRepo.save(config),
        UnscopedWriteRefusedError,
      );
      assertEquals(marks, []);
      assertEquals(await ctx.vaultConfigRepo.findAll(), []);
    } finally {
      ctx.catalogStore.close();
    }
  });
});

Deno.test("commit-log unit: a path-only write inside a commit-log root is refused", async () => {
  await withV3(async (v3) => {
    const ctx = await repositoryContext(v3.dir, v3.hook);
    try {
      // Every repository declares its writes typed (swamp-club#3257), so a
      // write that does not is signalled directly.
      await assertRejects(
        () =>
          runInCommitLogRoot(
            ctx,
            v3.options(),
            () =>
              signalChange(ctx.markDirty, {
                kind: "write",
                path: join(v3.dir, "untyped.yaml"),
              }),
          ),
        Error,
        "commits only typed changes",
      );
      assertEquals(await v3.store.changesSince(0, 10), []);
    } finally {
      ctx.catalogStore.close();
    }
  });
});

Deno.test("commit-log unit: inside the CLI lockfile root (swamp-club#3192) a v3 repository write is refused", async () => {
  await withV3(async (v3) => {
    unitOfWorkBinding.requireUnit(v3.hook);
    const ctx = await repositoryContext(v3.dir, v3.hook);
    const cacheDir = join(v3.dir, "lockfile-cache");
    const repoDir = join(v3.dir, "lockfile-repo");
    await ensureDir(join(repoDir, ".swamp"));
    const service: DatastoreSyncService = {
      markDirty: () => Promise.resolve(),
      pullChanged: () => Promise.resolve(0),
      pushChanged: () => Promise.resolve(1),
    };
    const transaction = buildManagedLockfileTransaction({
      syncService: service,
      datastoreConfig: {
        type: "@swamp/s3-datastore",
        config: { bucket: "test" },
        datastorePath: cacheDir,
        cachePath: cacheDir,
        namespace: "ns1",
      },
      repoDir,
      lockfilePath: join(cacheDir, "ns1", "config", "upstream_extensions.json"),
      lock: {
        acquire: () => Promise.resolve(),
        release: () => Promise.resolve(),
      },
    });
    try {
      await assertRejects(
        () => transaction.run(() => ctx.vaultConfigRepo.save(vault())),
        UnscopedWriteRefusedError,
      );
      assertEquals(await ctx.vaultConfigRepo.findAll(), []);
    } finally {
      ctx.catalogStore.close();
    }
  });
});
