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
 * The v3 gate for the data and output repositories (swamp-club#3250). The
 * real repositories run on v3: inside a commit-log root over a v3 context
 * hook, so every write stages typed changes, and the unit commits them to a
 * real `commits.db` and filesystem `storage/1`. A read model then catches
 * up into a second directory, and its files (bytes) and `_catalog_v3.db`
 * rows must equal what the repositories wrote in the first. A missed key,
 * a wrong intent or a missing version fails here.
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { Data } from "../src/domain/data/data.ts";
import {
  type Namespace,
  restoreNamespace,
  SOLO_NAMESPACE,
} from "../src/domain/data/namespace.ts";
import { MAX_COMMIT_OPS } from "../src/domain/datastore_v3/commit.ts";
import { DefaultDataLifecycleService } from "../src/domain/data/data_lifecycle_service.ts";
import { CommitRejectedError } from "../src/domain/datastore_v3/partition.ts";
import { partitionOf } from "../src/domain/datastore_v3/partition_key.ts";
import {
  MODEL_ID,
  MODEL_TYPE,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import { ModelOutput } from "../src/domain/models/model_output.ts";
import type { DefinitionId } from "../src/domain/definitions/definition.ts";
import {
  type CommitLogRoot,
  runInCommitLogRoot,
} from "../src/infrastructure/datastore_v3/commit_log_root.ts";
import {
  contextHook,
  unitOptions,
} from "../src/infrastructure/datastore_v3/commit_log_test_helpers.ts";
import type { CommitSink } from "../src/infrastructure/datastore_v3/commit_log_unit_of_work.ts";
import type { Commit } from "../src/domain/datastore_v3/commit.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { SqliteCommitStore } from "../src/infrastructure/datastore_v3/sqlite_commit_store.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { YamlOutputRepository } from "../src/infrastructure/persistence/yaml_output_repository.ts";
import { UnscopedWriteRefusedError } from "../src/infrastructure/persistence/unit_of_work_scope.ts";
import { StagedContentChangedError } from "../src/infrastructure/persistence/verified_content_stream.ts";
import { processHostIdentity } from "../src/infrastructure/runtime/process.ts";
import {
  catalogV3Path,
  readCatalog,
  readTree,
  type V3Env,
  withV3Env,
} from "./datastore_v3_read_model_helpers.ts";

await initializeLogging({});

const PARTITION = partitionOf({
  kind: "model",
  type: MODEL_TYPE,
  id: MODEL_ID,
});

const PROVENANCE = {
  definitionHash: "abc123",
  modelVersion: "2026.02.09.1",
  triggeredBy: "manual",
} as const;

/** A pid no process holds, so a pending row naming it is an orphan. */
const DEAD_PID = 2147483647;

/** The repositories of one v3 repository context, in their own directory. */
class V3Writer {
  readonly dir: string;
  readonly root: string;
  readonly catalogPath: string;
  readonly catalog: CatalogStore;
  readonly hook = contextHook();
  readonly data: FileSystemUnifiedDataRepository;
  readonly outputs: YamlOutputRepository;
  readonly namespace: Namespace;

  constructor(
    readonly env: V3Env,
    readonly namespaceName: string,
    checkout = "writer",
  ) {
    this.dir = join(env.dir, checkout);
    this.namespace = namespaceName === ""
      ? SOLO_NAMESPACE
      : restoreNamespace(namespaceName);
    this.root = namespaceName === ""
      ? swampPath(this.dir)
      : swampPath(this.dir, namespaceName);
    this.catalogPath = join(this.dir, "_catalog.db");
    this.catalog = new CatalogStore(this.catalogPath);
    this.data = new FileSystemUnifiedDataRepository(
      this.dir,
      join(this.root, "data"),
      this.catalog,
      this.hook,
      undefined,
      this.namespace,
      true,
    );
    this.outputs = new YamlOutputRepository(
      this.dir,
      join(this.root, "outputs"),
      this.hook,
    );
  }

  /**
   * Runs `fn` in a commit-log root over this context, which commits after,
   * to the commit store or to `sink` in front of it.
   */
  run<T>(
    fn: (root: CommitLogRoot) => Promise<T>,
    sink: CommitSink = this.env.store,
  ): Promise<T> {
    return runInCommitLogRoot(
      { markDirty: this.hook },
      unitOptions(sink, this.env.storage, {
        namespace: this.namespace,
        signal: AbortSignal.timeout(60_000),
      }),
      fn,
    );
  }

  /** The commits that landed on the model's partition, oldest first. */
  async commitSizes(): Promise<number[]> {
    const commits = await this.env.store.readPartition(
      this.namespaceName,
      PARTITION,
      1,
      1_000,
    );
    return commits.map((change) => change.commit.ops.length);
  }
}

/** Catches a read model up and checks it holds what the writer wrote. */
async function assertMatches(writer: V3Writer): Promise<void> {
  const readModel = writer.env.openReadModel();
  try {
    await readModel.catchUp(AbortSignal.timeout(60_000));
  } finally {
    await readModel.close();
  }
  assertEquals(
    await readTree(writer.env.cacheRoot(writer.namespaceName)),
    await readTree(writer.root),
  );
  assertEquals(
    readCatalog(catalogV3Path(writer.env)),
    readCatalog(writer.catalogPath),
  );
}

function data(
  name: string,
  options: { garbageCollection?: number; streaming?: boolean } = {},
): Data {
  return Data.create({
    name,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: options.garbageCollection ?? 10,
    streaming: options.streaming,
    tags: { type: "resource", modelName: "vpc", specName: "main" },
    ownerDefinition: { ownerType: "manual", ownerRef: "test" },
  });
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** Content above the inline limit, so it is stored as several chunks. */
function large(seed: string): Uint8Array {
  const bytes = new Uint8Array(20 * 1024);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = (seed.charCodeAt(i % seed.length) + i) % 256;
  }
  return bytes;
}

/** Rewrites a pending row's writer so GC treats it as orphaned. */
function orphan(writer: V3Writer, name: string, version: number): void {
  const row = [...writer.catalog.iterate()].find((r) =>
    r.data_name === name && r.version === version
  );
  if (row === undefined) throw new Error(`no row for ${name}@${version}`);
  writer.catalog.upsert({
    ...row,
    pending_pid: DEAD_PID,
    pending_host: processHostIdentity(),
  });
}

for (const namespace of ["", "infra"]) {
  const label = namespace === "" ? "an unnamespaced" : "a namespaced";

  Deno.test(`v3 staging: every data write path matches the read model for ${label} datastore`, async () => {
    await withV3Env(async (env) => {
      const writer = new V3Writer(env, namespace);
      const repo = writer.data;
      const type = MODEL_TYPE;
      const save = (name: string, content: Uint8Array, gc?: number) =>
        repo.save(
          type,
          MODEL_ID,
          data(name, { garbageCollection: gc }),
          content,
        );

      // Saves, one large enough to be stored as chunks from its file; a
      // name capped at one version, so each save prunes the one before.
      await writer.run(() => save("a", text("a1")));
      await writer.run(() => save("a", text("a2")));
      await writer.run(() => save("a", large("a3")));
      await writer.run(() => save("b", text("b1")));
      for (const n of [1, 2, 3]) {
        await writer.run(() => save("c", text(`c${n}`), 1));
      }
      await assertMatches(writer);

      // A large save and the prune of it in one unit: the staged stream put
      // is superseded, so its file is never read after the prune removed it.
      await writer.run(async () => {
        await save("d", large("d1"), 1);
        await save("d", large("d2"), 1);
      });
      await assertMatches(writer);

      // A versioned delete below the top, then of the top, and a save that
      // reuses the deleted top's number, as v2 allocates it.
      await writer.run(() => repo.delete(type, MODEL_ID, "a", 1));
      await writer.run(() => repo.delete(type, MODEL_ID, "a", 3));
      await assertMatches(writer);
      await writer.run(() => save("a", text("a3 again")));
      await assertMatches(writer);

      // A rename, a save to the renamed-away name, and deletes that expose
      // the rename marker and then the version below it.
      await writer.run(() => repo.rename(type, MODEL_ID, "b", "e"));
      await assertMatches(writer);
      await writer.run(() => save("b", text("b3")));
      await writer.run(() => repo.delete(type, MODEL_ID, "b", 3));
      await assertMatches(writer);
      // A rename whose marker reuses the number just deleted.
      await writer.run(() => repo.rename(type, MODEL_ID, "a", "f"));
      await assertMatches(writer);

      // An append after a top delete: it extends the version the marker
      // names, below the name's greatest version ever recorded.
      const stream = data("s", { streaming: true });
      await writer.run(() => repo.save(type, MODEL_ID, stream, text("s1")));
      await writer.run(() => repo.save(type, MODEL_ID, stream, text("s2")));
      await writer.run(() => repo.delete(type, MODEL_ID, "s", 2));
      await writer.run(() => repo.append(type, MODEL_ID, "s", text(" more")));
      await assertMatches(writer);

      // Content streamed in by a writer outside the repository.
      await writer.run(async () => {
        const allocated = await repo.allocateVersion(
          type,
          MODEL_ID,
          data("w"),
        );
        await Deno.writeFile(allocated.contentPath, large("w1"));
        await repo.finalizeVersion(
          type,
          MODEL_ID,
          data("w"),
          allocated.version,
          allocated.priorVersions,
        );
      });
      await assertMatches(writer);

      // Garbage collection, a whole-name delete and a save that starts the
      // name again at version 1, and expiry.
      await writer.run(async () => {
        for (const n of [1, 2, 3]) await save("g", text(`g${n}`), 3);
      });
      await writer.run(async () => {
        await repo.collectGarbage(type, MODEL_ID);
      });
      await assertMatches(writer);
      await writer.run(() => repo.delete(type, MODEL_ID, "d"));
      await assertMatches(writer);
      await writer.run(() => save("d", text("d again")));
      await writer.run(() => repo.removeLatestMarker(type, MODEL_ID, "e"));
      await assertMatches(writer);

      // A save inside a use case's child unit rolls up into the root.
      await writer.run(() =>
        runInCommitLogRoot(
          { markDirty: writer.hook },
          unitOptions(env.store, env.storage, { namespace: writer.namespace }),
          () => save("h", large("h1")),
        )
      );
      await assertMatches(writer);
    });
  });

  Deno.test(`v3 staging: deferred writes commit when promoted, out of order and through reclaim, for ${label} datastore`, async () => {
    await withV3Env(async (env) => {
      const writer = new V3Writer(env, namespace);
      const repo = writer.data;
      const type = MODEL_TYPE;

      // Promoted, and rolled back.
      await writer.run(async () => {
        const first = await repo.saveDeferred(
          type,
          MODEL_ID,
          data("p"),
          text("p1"),
        );
        const second = await repo.saveDeferred(
          type,
          MODEL_ID,
          data("p"),
          large("p2"),
        );
        await repo.advanceLatestMarkers([first]);
        await repo.rollbackVersions([second]);
      });
      await assertMatches(writer);

      // A deferred version promoted after a higher version committed: the
      // marker does not move to it, but the version is recorded.
      let late = await writer.run(() =>
        repo.saveDeferred(type, MODEL_ID, data("q"), text("q1"))
      );
      await writer.run(() => repo.save(type, MODEL_ID, data("q"), text("q2")));
      await writer.run(() => repo.advanceLatestMarkers([late]));
      await assertMatches(writer);

      // A deferred version promoted after a rename put a marker above it:
      // the version is recorded below the marker, which stays latest.
      await writer.run(() => repo.save(type, MODEL_ID, data("m"), text("m1")));
      late = await writer.run(() =>
        repo.saveDeferred(type, MODEL_ID, data("m"), text("m2"))
      );
      await writer.run(() => repo.rename(type, MODEL_ID, "m", "n"));
      await writer.run(() => repo.advanceLatestMarkers([late]));
      await assertMatches(writer);

      // Two writers of one name finishing out of order in one unit.
      await writer.run(async () => {
        const one = await repo.allocateVersion(type, MODEL_ID, data("r"));
        const two = await repo.allocateVersion(type, MODEL_ID, data("r"));
        await Deno.writeFile(two.contentPath, text("r2"));
        await repo.finalizeVersion(type, MODEL_ID, data("r"), two.version);
        await Deno.writeFile(one.contentPath, text("r1"));
        await repo.finalizeVersion(type, MODEL_ID, data("r"), one.version);
      });
      await assertMatches(writer);

      // An orphaned deferred write GC reclaims, and one a dead process had
      // promoted (its marker moved, its row still pending).
      late = await writer.run(() =>
        repo.saveDeferred(type, MODEL_ID, data("t"), text("t1"))
      );
      orphan(writer, "t", late.version);
      const promoted = await writer.run(() =>
        repo.saveDeferred(type, MODEL_ID, data("u"), text("u1"))
      );
      await Deno.writeTextFile(
        join(
          repo.getDataNameDir(type, MODEL_ID, "u"),
          "latest",
        ),
        String(promoted.version),
      );
      orphan(writer, "u", promoted.version);
      await writer.run(async () => {
        await repo.collectGarbage(type, MODEL_ID);
      });
      await assertMatches(writer);
    });
  });

  Deno.test(`v3 staging: a staging error stops no promotion and is thrown after every receipt, for ${label} datastore`, async () => {
    await withV3Env(async (env) => {
      const writer = new V3Writer(env, namespace);
      const repo = writer.data;
      const receipts = await writer.run(async () => [
        await repo.saveDeferred(MODEL_TYPE, MODEL_ID, data("x"), text("x1")),
        await repo.saveDeferred(MODEL_TYPE, MODEL_ID, data("y"), text("y1")),
      ]);
      // Outside every unit bound to the v3 context, staging is refused.
      const error = await assertRejects(
        () => repo.advanceLatestMarkers(receipts),
        AggregateError,
      );
      assertEquals(error.errors.length, 2);
      assert(
        error.errors.every((e) => e instanceof UnscopedWriteRefusedError),
      );
      for (const name of ["x", "y"]) {
        assertEquals(
          await Deno.readTextFile(
            join(repo.getDataNameDir(MODEL_TYPE, MODEL_ID, name), "latest"),
          ),
          "1",
        );
      }
    });
  });

  Deno.test(`v3 staging: an append to a version v3 holds with other metadata is refused, for ${label} datastore`, async () => {
    await withV3Env(async (env) => {
      const writer = new V3Writer(env, namespace);
      const repo = writer.data;
      const stream = data("s", { streaming: true });
      await writer.run(() =>
        repo.save(MODEL_TYPE, MODEL_ID, stream, text("s1"))
      );
      // Locally the version's metadata now differs from what v3 recorded,
      // as when another writer recorded this version number.
      const metadataPath = repo.getMetadataPath(MODEL_TYPE, MODEL_ID, "s", 1);
      await Deno.writeTextFile(
        metadataPath,
        (await Deno.readTextFile(metadataPath)) + "# local\n",
      );
      const error = await assertRejects(
        () =>
          writer.run(() =>
            repo.append(MODEL_TYPE, MODEL_ID, "s", text(" more"))
          ),
        CommitRejectedError,
      );
      assertEquals(error.reason, "expect-failed");
    });
  });

  Deno.test(`v3 staging: output records match the read model for ${label} datastore`, async () => {
    await withV3Env(async (env) => {
      const writer = new V3Writer(env, namespace);
      const old = ModelOutput.create({
        definitionId: MODEL_ID as DefinitionId,
        provenance: PROVENANCE,
        methodName: "create",
        status: "succeeded",
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
      });
      const kept = ModelOutput.create({
        definitionId: MODEL_ID as DefinitionId,
        provenance: PROVENANCE,
        methodName: "create",
        status: "succeeded",
        startedAt: new Date(),
      });
      const deleted = ModelOutput.create({
        definitionId: MODEL_ID as DefinitionId,
        provenance: PROVENANCE,
        methodName: "update",
        status: "failed",
        startedAt: new Date(),
      });
      await writer.run(async () => {
        for (const output of [old, kept, deleted]) {
          await writer.outputs.save(MODEL_TYPE, output.methodName, output);
        }
      });
      await assertMatches(writer);
      await writer.run(() =>
        writer.outputs.delete(MODEL_TYPE, "update", deleted.id)
      );
      // Expiry, with a run log beside the record: logs have no typed
      // change, and removing one is not refused.
      const logPath = join(writer.root, "outputs", "run.log");
      await ensureDir(join(writer.root, "outputs"));
      await Deno.writeTextFile(logPath, "log");
      await Deno.remove(logPath);
      await writer.run(async () => {
        await writer.outputs.deleteOlderThan(new Date("2026-06-01"));
      });
      await assertMatches(writer);
    });
  });
}

/**
 * Writes `count` promoted versions of `name` straight to the writer's files,
 * so a large removal has something to remove without saving thousands of
 * versions one by one. They are not committed to v3: a tombstone of a key
 * v3 never held is accepted, and the split is what these tests check.
 */
async function seedVersions(
  writer: V3Writer,
  name: string,
  count: number,
): Promise<void> {
  const nameDir = writer.data.getDataNameDir(MODEL_TYPE, MODEL_ID, name);
  const base = data(name, { garbageCollection: 1 });
  for (let version = 1; version <= count; version++) {
    const raw = text(`${name}${version}`);
    const metadata = JSON.parse(JSON.stringify(
      base.withNewVersion({ version, size: raw.length }).toData(),
    ));
    const dir = join(nameDir, String(version));
    await ensureDir(dir);
    await Deno.writeFile(join(dir, "raw"), raw);
    await Deno.writeFile(
      join(dir, "metadata.yaml"),
      text(stringifyYaml(metadata)),
    );
  }
  await Deno.writeFile(join(nameDir, "latest"), text(String(count)));
}

/** The commits of the model's partition after the first `skip`. */
async function commitsAfter(writer: V3Writer, skip: number) {
  const commits = await writer.env.store.readPartition(
    writer.namespaceName,
    PARTITION,
    1,
    1_000,
  );
  return commits.slice(skip).map((change) => change.commit);
}

/** Each version's two tombstones are in the commits, with their version. */
function assertVersionsTombstoned(
  commits: readonly { ops: readonly unknown[] }[],
  kind: "data.gc" | "data.delete",
  name: string,
  versions: readonly number[],
): void {
  const tombstoned = new Map<number, number>();
  for (const commit of commits) {
    for (
      const op of commit.ops as {
        kind: string;
        intent?: { kind: string; name?: string; version?: number };
      }[]
    ) {
      if (
        op.kind === "tombstone" && op.intent?.kind === kind &&
        op.intent.name === name && op.intent.version !== undefined
      ) {
        tombstoned.set(
          op.intent.version,
          (tombstoned.get(op.intent.version) ?? 0) + 1,
        );
      }
    }
  }
  assertEquals(
    [...tombstoned].sort(([a], [b]) => a - b),
    versions.map((version) => [version, 2]),
  );
}

/**
 * The commit store, with `before` run ahead of each append: where a chunk
 * sweep deletes chunks after the unit stored them (swamp-club#3249).
 */
function sinkWith(
  env: V3Env,
  before: (commit: Commit) => Promise<void>,
): CommitSink {
  return {
    head: (namespace, partition) => env.store.head(namespace, partition),
    append: async (commit) => {
      await before(commit);
      return await env.store.append(commit);
    },
  };
}

/** Deletes every chunk a commit's puts name, as a racing sweep would. */
async function deleteChunksOf(env: V3Env, commit: Commit): Promise<number> {
  let deleted = 0;
  for (const op of commit.ops) {
    if (op.kind !== "put" || !("blob" in op.content)) continue;
    for (const sha256 of op.content.blob.chunkHashes()) {
      await env.storage.delete("_default", sha256, AbortSignal.timeout(10_000));
      deleted++;
    }
  }
  return deleted;
}

Deno.test("v3 staging: a saved version's chunks a sweep deleted before the commit landed are restored from its file", async () => {
  await withV3Env(async (env) => {
    const writer = new V3Writer(env, "");
    let deleted = 0;
    await writer.run(
      () => writer.data.save(MODEL_TYPE, MODEL_ID, data("big"), large("b1")),
      sinkWith(env, async (commit) => {
        deleted += await deleteChunksOf(env, commit);
      }),
    );
    assert(deleted > 1);
    // The read model reads every chunk back, so a missing one fails here.
    await assertMatches(writer);
  });
});

Deno.test("v3 staging: a changed file cannot restore a deleted chunk; the landed commit stands, with a warning (swamp-club#3586)", async () => {
  await withV3Env(async (env) => {
    const writer = new V3Writer(env, "");
    const contentPath = join(
      writer.data.getDataNameDir(MODEL_TYPE, MODEL_ID, "big"),
      "1",
      "raw",
    );
    let landed = 0;
    // The repair reads the file again, which no longer holds what was staged
    // (swamp-club#3564); the commit has landed, so failing the unit would
    // report a committed change as failed.
    await writer.run(
      () => writer.data.save(MODEL_TYPE, MODEL_ID, data("big"), large("b1")),
      sinkWith(env, async (commit) => {
        landed++;
        await deleteChunksOf(env, commit);
        await Deno.writeFile(contentPath, large("changed"));
      }),
    );
    assert(landed > 0);
  });
});

for (
  const [what, changed] of [
    ["changed in place", () => large("changed")],
    ["shrunk below the inline limit", () => text("small now")],
    ["grown", () => new Uint8Array([...large("b1"), ...text("more")])],
  ] as const
) {
  Deno.test(`v3 staging: a saved version's file ${what} before its unit commits is refused, and nothing lands (swamp-club#3564)`, async () => {
    await withV3Env(async (env) => {
      const writer = new V3Writer(env, "");
      const contentPath = join(
        writer.data.getDataNameDir(MODEL_TYPE, MODEL_ID, "big"),
        "1",
        "raw",
      );
      await assertRejects(
        () =>
          writer.run(async () => {
            await writer.data.save(
              MODEL_TYPE,
              MODEL_ID,
              data("big"),
              large("b1"),
            );
            // A reader catching up over this checkout rewinds the file.
            await Deno.writeFile(contentPath, changed());
          }),
        StagedContentChangedError,
      );
      assertEquals(await writer.commitSizes(), []);
    });
  });
}

/** A catalog whose pending-row writes fail, so a deferred save fails. */
class FailingPendingCatalog extends CatalogStore {
  override upsert(row: Parameters<CatalogStore["upsert"]>[0]): void {
    if (row.is_pending === 1) throw new Error("pending row failed");
    super.upsert(row);
  }
}

/** A repository whose rollback fails too. */
class FailingRollbackRepository extends FileSystemUnifiedDataRepository {
  override rollbackVersions(): Promise<void> {
    return Promise.reject(new Error("rollback failed"));
  }
}

Deno.test("v3 staging: a failed write's rollback error reaches the caller on v2, and the write's own error on v3", async () => {
  await withV3Env(async (env) => {
    const writer = new V3Writer(env, "");
    const build = (hook: typeof writer.hook | undefined) =>
      new FailingRollbackRepository(
        writer.dir,
        join(writer.root, "data"),
        new FailingPendingCatalog(join(writer.dir, "_failing.db")),
        hook,
      );
    // v2: no hook that requires a unit, so the rollback runs as before.
    await assertRejects(
      () =>
        build(undefined).saveDeferred(
          MODEL_TYPE,
          MODEL_ID,
          data("v2"),
          text("x"),
        ),
      Error,
      "rollback failed",
    );
    // v3: the rollback's error is logged, the write's is thrown.
    await assertRejects(
      () =>
        writer.run(() =>
          build(writer.hook).saveDeferred(
            MODEL_TYPE,
            MODEL_ID,
            data("v3"),
            text("x"),
          )
        ),
      Error,
      "pending row failed",
    );
  });
});

for (const where of ["root", "child"] as const) {
  Deno.test(`v3 staging: collectGarbage and delete above MAX_COMMIT_OPS split across commits, in a ${where} unit`, async () => {
    await withV3Env(async (env) => {
      const writer = new V3Writer(env, "");
      // Two tombstones per version: more than MAX_COMMIT_OPS changes.
      const count = MAX_COMMIT_OPS / 2 + 2;
      const versions = Array.from({ length: count }, (_, i) => i + 1);
      const inUnit = (fn: () => Promise<unknown>) =>
        writer.run(() =>
          where === "root" ? fn() : runInCommitLogRoot(
            { markDirty: writer.hook },
            unitOptions(env.store, env.storage),
            fn,
          )
        );

      // GC keeps one version: count - 1 versions removed, then the marker.
      await seedVersions(writer, "big", count);
      await inUnit(() => writer.data.collectGarbage(MODEL_TYPE, MODEL_ID));
      const gc = await commitsAfter(writer, 0);
      assertEquals(gc.map((c) => c.ops.length), [MAX_COMMIT_OPS, 3]);
      assertVersionsTombstoned(gc, "data.gc", "big", versions.slice(0, -1));
      assertEquals(gc[1].ops.at(-1)?.kind, "put");

      // A whole-name delete: every version, then the marker.
      await seedVersions(writer, "wide", count);
      await inUnit(() => writer.data.delete(MODEL_TYPE, MODEL_ID, "wide"));
      const deleted = await commitsAfter(writer, gc.length);
      assertEquals(deleted.map((c) => c.ops.length), [MAX_COMMIT_OPS, 5]);
      assertVersionsTombstoned(deleted, "data.delete", "wide", versions);
      assertEquals(deleted[1].ops.at(-1)?.kind, "tombstone");
    });
  });
}

// swamp-club#3532: a version number never names two contents, so a name
// emptied of every version continues above its old high-water mark.

Deno.test("v3 staging: a name emptied by data delete continues above its old high-water mark", async () => {
  await withV3Env(async (env) => {
    const writer = new V3Writer(env, "");
    const repo = writer.data;
    const save = (content: string) =>
      repo.save(MODEL_TYPE, MODEL_ID, data("r"), text(content));
    for (const n of [1, 2, 3]) await writer.run(() => save(`r${n}`));
    await writer.run(() => repo.delete(MODEL_TYPE, MODEL_ID, "r"));
    assertEquals(await repo.listVersions(MODEL_TYPE, MODEL_ID, "r"), []);
    await writer.run(() => save("after"));
    assertEquals(await repo.listVersions(MODEL_TYPE, MODEL_ID, "r"), [4]);
    await assertMatches(writer);
  });
});

Deno.test("v3 staging: a deleted top version is not given to the next save", async () => {
  await withV3Env(async (env) => {
    const writer = new V3Writer(env, "");
    const repo = writer.data;
    const save = (content: string) =>
      repo.save(MODEL_TYPE, MODEL_ID, data("t"), text(content));
    for (const n of [1, 2]) await writer.run(() => save(`t${n}`));
    await writer.run(() => repo.delete(MODEL_TYPE, MODEL_ID, "t", 2));
    await writer.run(() => save("after"));
    assertEquals(await repo.listVersions(MODEL_TYPE, MODEL_ID, "t"), [1, 3]);
    await assertMatches(writer);
  });
});

Deno.test("v3 staging: a save, a delete of the name and a save again inside one unit", async () => {
  await withV3Env(async (env) => {
    const writer = new V3Writer(env, "");
    const repo = writer.data;
    const save = (content: string) =>
      repo.save(MODEL_TYPE, MODEL_ID, data("u"), text(content));
    await writer.run(() => save("u1"));
    // Version 2 is staged, not committed, when the name is emptied: the
    // commit store cannot see it, so the process's own mark must.
    await writer.run(async () => {
      await save("u2");
      await repo.delete(MODEL_TYPE, MODEL_ID, "u");
      await save("u3");
    });
    assertEquals(await repo.listVersions(MODEL_TYPE, MODEL_ID, "u"), [3]);
    await assertMatches(writer);
  });
});

Deno.test("v3 staging: retention emptying a name leaves its next write above the old versions", async () => {
  await withV3Env(async (env) => {
    const writer = new V3Writer(env, "");
    const repo = writer.data;
    const save = (content: string) =>
      repo.save(MODEL_TYPE, MODEL_ID, data("aged"), text(content));
    await writer.run(() => save("a1"));
    await writer.run(() => save("a2"));
    const newest = await repo.findByName(MODEL_TYPE, MODEL_ID, "aged", 2);
    const cutoff = newest!.createdAt.getTime() + 1;
    while (Date.now() < cutoff) {
      // poll the clock until it passes the newest version
    }
    const result = await writer.run(() =>
      new DefaultDataLifecycleService(repo, {} as never).deleteDataOlderThan(
        new Date(cutoff),
        { dryRun: false, isExempt: () => false },
      )
    );
    assertEquals(result.entriesDeleted, 1);
    assertEquals(await repo.listVersions(MODEL_TYPE, MODEL_ID, "aged"), []);
    await writer.run(() => save("a3"));
    assertEquals(await repo.listVersions(MODEL_TYPE, MODEL_ID, "aged"), [3]);
    await assertMatches(writer);
  });
});

for (const emptied of [false, true]) {
  Deno.test(
    `v3 staging: a second checkout whose files are behind writes above the first's versions${
      emptied ? " after it emptied the name" : ""
    }`,
    async () => {
      await withV3Env(async (env) => {
        const first = new V3Writer(env, "");
        const save = (writer: V3Writer, content: string) =>
          writer.data.save(MODEL_TYPE, MODEL_ID, data("shared"), text(content));
        for (const n of [1, 2, 3]) {
          await first.run(() => save(first, `first ${n}`));
        }
        if (emptied) {
          await first.run(() =>
            first.data.delete(MODEL_TYPE, MODEL_ID, "shared")
          );
        }

        // Another process: its own connection to commits.db, and a checkout
        // whose files have not caught up with the first's commits.
        const second = new V3Writer(env, "", "second");
        const store = SqliteCommitStore.open(join(env.dir, "commits.db"));
        try {
          assertEquals(
            await second.data.listVersions(MODEL_TYPE, MODEL_ID, "shared"),
            [],
          );
          await second.run(() => save(second, "second"), store);
        } finally {
          await store.close();
        }
        assertEquals(
          await second.data.listVersions(MODEL_TYPE, MODEL_ID, "shared"),
          [4],
        );
      });
    },
  );
}
