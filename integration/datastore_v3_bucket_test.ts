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
 * v3 on a bucket (swamp-club#3534, Phase 4E), in-process on the in-memory
 * remote registered as a datastore type with every v3 capability: setup and
 * its refusals, the format guard, the namespaced records under `ns/`, the
 * lock commands, lineage path collection through the binding, and the v2
 * paths a v3 bucket datastore never takes.
 *
 * The writers' cases run a real Litestream sidecar, as D1 and D2's do, so
 * they are skipped without `SWAMP_LITESTREAM_PATH`; they replicate to a file
 * replica through the internal setting, which wins in tests. The provider's
 * own target is exercised where no Litestream runs.
 */

import "../src/domain/models/models.ts";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { dirname, join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import {
  createInMemoryRemote,
  type InMemoryRemote,
} from "../packages/testing/in_memory_remote.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { VERSION } from "../src/cli/commands/version.ts";
import {
  requireInitializedRepo,
  requireInitializedRepoReadOnly,
  requireInitializedRepoUnlocked,
  resolveDatastoreForRepo,
} from "../src/cli/repo_context.ts";
import { resolveConfigTierPath } from "../src/cli/resolve_datastore.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { flushDatastoreSync } from "../src/infrastructure/persistence/datastore_sync_coordinator.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import {
  DatastoreFormatMismatchError,
  UnreachableDatastoreFormatMarkerError,
} from "../src/domain/datastore/datastore_format.ts";
import { datastoreTypeRegistry } from "../src/domain/datastore/datastore_type_registry.ts";
import type { DatastoreProvider } from "../src/domain/datastore/datastore_provider.ts";
import type { V3ReplicaTarget } from "../src/domain/datastore/replica_target.ts";
import { V3_BUCKET_MIN_EXTENSION_VERSION } from "../src/domain/datastore/v3_hosting.ts";
import { WriterFencedError } from "../src/domain/datastore_v3/writer_lease.ts";
import {
  AutoDefinitionChanges,
  recordKeyOf,
} from "../src/domain/datastore_v3/repository_changes.ts";
import type { CommitLogUnitOfWork } from "../src/domain/datastore_v3/commit_log_unit_of_work.ts";
import { V3ReplicationError } from "../src/domain/datastore_v3/litestream_replication.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  createDatastoreSetupDeps,
  type DatastoreSetupEvent,
  datastoreSetupExtension,
  type DatastoreSetupExtensionInput,
} from "../src/libswamp/datastores/setup.ts";
import { createDatastoreSyncDeps } from "../src/libswamp/datastores/sync.ts";
import { createMigrateIndexDeps } from "../src/libswamp/datastores/migrate_index.ts";
import { collect } from "../src/libswamp/testing.ts";
import { registerTestDatastoreType } from "../src/infrastructure/testing/test_datastore_type.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { RepoMarkerRepository } from "../src/infrastructure/persistence/repo_marker_repository.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { datastoreWriterLeaseStore } from "../src/infrastructure/datastore_v3/datastore_writer_lease_store.ts";
import {
  resetV3BucketBindingsForTesting,
  v3BucketBindingAt,
} from "../src/infrastructure/datastore_v3/v3_datastore_binding.ts";
import {
  closeV3Datastores,
  holdV3Writer,
  v3DatastoreConfigOf,
  v3DatastoreFor,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import {
  v3WriterLease,
  v3WriterLockHandle,
} from "../src/infrastructure/datastore_v3/v3_writer_lock.ts";
import { v3CommitsDbPath } from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import {
  collectV3Lineages,
  lineageRegistryFor,
  prepareV3WriterLineage,
  publishV3Head,
} from "../src/infrastructure/datastore_v3/litestream/v3_copy.ts";
import { V3_REPLICA_ENV } from "../src/infrastructure/datastore_v3/litestream/replica_setting.ts";
import { setV3ReplicationForTesting } from "../src/infrastructure/datastore_v3/litestream/v3_replication.ts";
import { hostLitestreamProcesses } from "../src/infrastructure/datastore_v3/litestream/litestream_processes.ts";
import { hourStartOf } from "../src/infrastructure/persistence/control_plane_retention_watermark_repository.ts";
import {
  commitCount,
  SIDECAR_TESTS_IGNORED,
  TEST_TIMINGS,
} from "./datastore_v3_litestream_helpers.ts";

await initializeLogging({});

const encode = (text: string) => new TextEncoder().encode(text);

/** The marker a v3 setup writes, as a control-plane record. */
const MARKER_RECORD = "_control/datastore-format";

/** A bucket the in-memory remote stands in for, registered as a type. */
interface Bucket {
  readonly remote: InMemoryRemote;
  readonly typeName: string;
  provider(): DatastoreProvider;
}

function createBucket(
  options: {
    readonly replicaPaths?: boolean;
    readonly namespaces?: () => string[];
    readonly replicaTarget?: V3ReplicaTarget;
  } = {},
): Bucket & { dispose(): void } {
  const remote = createInMemoryRemote({
    controlPlane: true,
    storage: true,
    replicaTarget: options.replicaTarget ??
      { type: "s3", bucket: "team-bucket", prefix: "" },
    replicaPaths: options.replicaPaths ?? true,
  });
  const type = registerTestDatastoreType(remote, {
    datastoreWideLease: true,
    listNamespaces: () => Promise.resolve(options.namespaces?.() ?? []),
  });
  return {
    remote,
    typeName: type.typeName,
    provider: () =>
      datastoreTypeRegistry.get(type.typeName)!.createProvider!({}),
    dispose: () => type.dispose(),
  };
}

async function initRepo(repoDir: string): Promise<string> {
  await Deno.mkdir(repoDir, { recursive: true });
  const homeDir = join(repoDir, "test-home");
  await new RepoService(VERSION, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  }).init(RepoPath.create(repoDir), { tools: [] });
  const marker = await new RepoMarkerRepository().read(
    RepoPath.create(repoDir),
  );
  return marker!.repoId!;
}

/** A temp root under /tmp: a sidecar's socket path must stay short. */
async function withRoot(
  fn: (root: string, bucket: Bucket) => Promise<void>,
  options: Parameters<typeof createBucket>[0] = {},
): Promise<void> {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ dir: "/tmp", prefix: "swamp-v3-bucket-" }),
  );
  const bucket = createBucket(options);
  try {
    await fn(root, bucket);
    // Whatever the case did, no v2 sync method was called on the bucket
    // (swamp-club#3549).
    assertEquals(v2SyncOps(bucket), [], "a v2 sync method was called");
  } finally {
    await closeV3Datastores().catch(() => {});
    resetV3BucketBindingsForTesting();
    bucket.dispose();
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

function setupBucket(
  repoDir: string,
  bucket: Bucket,
  input: Partial<DatastoreSetupExtensionInput> = {},
): Promise<DatastoreSetupEvent[]> {
  return collect<DatastoreSetupEvent>(
    datastoreSetupExtension(
      createLibSwampContext(),
      createDatastoreSetupDeps(repoDir, resolveConfigTierPath, {
        swampVersion: "test-version",
      }),
      {
        type: bucket.typeName,
        config: {},
        repoDir,
        skipMigration: false,
        format: 3,
        ...input,
      },
    ),
  );
}

/**
 * The v2 sync operations the bucket's sync services were asked for:
 * markDirty, push (pushChanged), pull (pullChanged), prepare (preparePush)
 * and commit (commitPush). A v3 bucket datastore never calls one, which the
 * extensions' refusal of a format-3 bucket relies on (swamp-club#3549).
 */
function v2SyncOps(bucket: Bucket): string[] {
  return bucket.remote.ops()
    .filter((op) =>
      ["markDirty", "push", "pull", "prepare", "commit"].includes(op.op)
    )
    .map((op) => `${op.instance}:${op.op}`);
}

function errorOf(events: DatastoreSetupEvent[]): string | undefined {
  const error = events.find((e) => e.kind === "error");
  return error?.kind === "error" ? error.error.message : undefined;
}

async function swampYaml(repoDir: string): Promise<Record<string, unknown>> {
  return parseYaml(
    await Deno.readTextFile(join(repoDir, ".swamp.yaml")),
  ) as Record<string, unknown>;
}

/** A checkout of the same datastore: `.swamp.yaml` copied into a new repo. */
async function cloneRepo(
  from: string,
  to: string,
  edit: (datastore: Record<string, unknown>) => void = () => {},
): Promise<void> {
  await initRepo(to);
  const marker = await swampYaml(from);
  const datastore = { ...(marker.datastore as Record<string, unknown>) };
  edit(datastore);
  const current = await swampYaml(to);
  await Deno.writeTextFile(
    join(to, ".swamp.yaml"),
    JSON.stringify({ ...current, datastore }),
  );
}

Deno.test({
  name:
    "v3 bucket: setup writes only the marker, records format 3, and the repo opens as v3 (swamp-club#3534)",
  // A bucket datastore needs Litestream, which setup refuses on Windows,
  // and the temp root lives under /tmp.
  ignore: Deno.build.os === "windows",
  async fn() {
    await withRoot(async (root, bucket) => {
      const repoDir = join(root, "repo");
      await initRepo(repoDir);
      const events = await setupBucket(repoDir, bucket);
      assertEquals(errorOf(events), undefined);
      const completed = events.at(-1);
      assertEquals(completed?.kind, "completed");
      if (completed?.kind === "completed") {
        assertEquals(completed.data.format, 3);
      }

      assertEquals([...bucket.remote.controlPlaneRecords().keys()], [
        MARKER_RECORD,
      ]);
      assertEquals(
        JSON.parse(
          new TextDecoder().decode(
            bucket.remote.controlPlaneRecords().get(MARKER_RECORD),
          ),
        ),
        { format: 3, minReaderFormat: 3, writtenBy: "test-version" },
      );
      assertEquals(
        bucket.remote.files().size,
        0,
        "nothing is synced the v2 way",
      );
      const datastore = (await swampYaml(repoDir)).datastore as Record<
        string,
        unknown
      >;
      assertEquals(datastore.type, bucket.typeName);
      assertEquals(datastore.format, 3);

      const { engine } = await resolveDatastoreForRepo(repoDir);
      assertEquals(engine, "v3");
      const { repoContext } = await requireInitializedRepoReadOnly({
        repoDir,
        outputMode: "json",
      });
      assert(repoContext.commitLog !== undefined, "the context commits on v3");
    });
  },
});

Deno.test({
  name:
    "v3 bucket: setup refuses an extension without the v3 capabilities, naming the minimum version, and writes nothing (swamp-club#3534)",
  ignore: Deno.build.os === "windows",
  async fn() {
    await withRoot(async (root, bucket) => {
      const repoDir = join(root, "repo");
      await initRepo(repoDir);
      const before = await Deno.readTextFile(join(repoDir, ".swamp.yaml"));
      const message = errorOf(await setupBucket(repoDir, bucket)) ?? "";
      assertStringIncludes(message, "replicaPaths()");
      assertStringIncludes(message, V3_BUCKET_MIN_EXTENSION_VERSION);
      assertEquals(bucket.remote.controlPlaneRecords().size, 0);
      assertEquals(
        await Deno.readTextFile(join(repoDir, ".swamp.yaml")),
        before,
      );
    }, { replicaPaths: false });
  },
});

Deno.test({
  name:
    "v3 bucket: setup refuses a bucket that is not new and empty, and a repo that holds records, writing nothing (swamp-club#3534)",
  ignore: Deno.build.os === "windows",
  async fn() {
    const cases: Array<
      [
        string,
        (bucket: Bucket, repoDir: string) => Promise<void>,
        string,
        { namespaces?: () => string[] }?,
      ]
    > = [
      [
        "a control-plane record",
        async (bucket) => {
          await bucket.remote.datastoreControlPlaneStore!().put(
            "heartbeats/serve-1",
            encode("{}"),
          );
        },
        "control plane already holds records",
      ],
      [
        "a content chunk",
        async (bucket) => {
          const sha = "a".repeat(64);
          await bucket.remote.storage!().put(
            "_default",
            sha,
            encode("x"),
            AbortSignal.timeout(5_000),
          );
        },
        "content chunks",
      ],
      [
        "a v2 namespace",
        () => Promise.resolve(),
        "v2 namespaces (old-team)",
        { namespaces: () => ["old-team"] },
      ],
      [
        "a format 2 marker",
        async (bucket) => {
          await bucket.remote.datastoreControlPlaneStore!().put(
            "datastore-format",
            encode('{"format":2}'),
          );
        },
        "format 2 datastore marker",
      ],
      [
        "records in the repo",
        async (_bucket, repoDir) => {
          const record = swampPath(repoDir, "data", "some", "record.yaml");
          await Deno.mkdir(dirname(record), { recursive: true });
          await Deno.writeTextFile(record, "x: 1\n");
        },
        "holds records",
      ],
    ];
    for (const [name, seed, message, options] of cases) {
      await withRoot(async (root, bucket) => {
        const repoDir = join(root, "repo");
        await initRepo(repoDir);
        await seed(bucket, repoDir);
        const records = [...bucket.remote.controlPlaneRecords().keys()];
        const before = await Deno.readTextFile(join(repoDir, ".swamp.yaml"));
        assertStringIncludes(
          errorOf(await setupBucket(repoDir, bucket)) ?? "",
          message,
          name,
        );
        assertEquals(
          [...bucket.remote.controlPlaneRecords().keys()],
          records,
          `${name}: setup wrote to the bucket`,
        );
        assertEquals(
          await Deno.readTextFile(join(repoDir, ".swamp.yaml")),
          before,
          `${name}: setup changed .swamp.yaml`,
        );
      }, options);
    }
  },
});

Deno.test({
  name:
    "v3 bucket: a setup that stopped after its marker resumes, and a marker another setup wrote is accepted (swamp-club#3534)",
  ignore: Deno.build.os === "windows",
  async fn() {
    await withRoot(async (root, bucket) => {
      const repoDir = join(root, "repo");
      await initRepo(repoDir);
      await bucket.remote.datastoreControlPlaneStore!().put(
        "datastore-format",
        encode('{"format":3,"minReaderFormat":3,"writtenBy":"earlier"}'),
      );
      assertEquals(errorOf(await setupBucket(repoDir, bucket)), undefined);
      // The first setup's marker stays.
      assertStringIncludes(
        new TextDecoder().decode(
          bucket.remote.controlPlaneRecords().get(MARKER_RECORD),
        ),
        "earlier",
      );
      assertEquals(
        ((await swampYaml(repoDir)).datastore as Record<string, unknown>)
          .format,
        3,
      );
    });
  },
});

Deno.test({
  name: "v3 bucket: a v2 setup of a v3 bucket is refused (swamp-club#3534)",
  ignore: Deno.build.os === "windows",
  async fn() {
    await withRoot(async (root, bucket) => {
      const repoDir = join(root, "repo");
      await initRepo(repoDir);
      await bucket.remote.datastoreControlPlaneStore!().put(
        "datastore-format",
        encode('{"format":3,"minReaderFormat":3}'),
      );
      assertStringIncludes(
        errorOf(await setupBucket(repoDir, bucket, { format: 2 })) ?? "",
        "is a v3 datastore",
      );
    });
  },
});

Deno.test({
  name:
    "v3 bucket: format 3 hand-written over a v2 bucket is refused before anything is written (swamp-club#3534)",
  ignore: Deno.build.os === "windows",
  async fn() {
    await withRoot(async (root, bucket) => {
      const repoDir = join(root, "repo");
      await initRepo(repoDir);
      const marker = await swampYaml(repoDir);
      await Deno.writeTextFile(
        join(repoDir, ".swamp.yaml"),
        JSON.stringify({
          ...marker,
          datastore: { type: bucket.typeName, config: {}, format: 3 },
        }),
      );
      await assertRejects(
        () => resolveDatastoreForRepo(repoDir),
        DatastoreFormatMismatchError,
      );
      // An unreadable marker opens provisionally; the lease confirms it first.
      bucket.remote.failNext("controlPlane", new Error("slow first request"), {
        instance: "datastore",
      });
      await assertRejects(
        () => requireInitializedRepoUnlocked({ repoDir, outputMode: "json" }),
        DatastoreFormatMismatchError,
      );
      assertEquals(
        [...bucket.remote.controlPlaneRecords().keys()],
        [],
        "no lease, lineage or marker was written",
      );
      assertEquals(bucket.remote.files().size, 0);
    });
  },
});

Deno.test({
  name:
    "v3 bucket: a v2 repo on a v3-capable extension keeps reading offline, while an override of the same bucket is refused (swamp-club#3534)",
  ignore: Deno.build.os === "windows",
  async fn() {
    await withRoot(async (root, bucket) => {
      const repoDir = join(root, "repo");
      await initRepo(repoDir);
      // A v2 setup persists no format key.
      const marker = await swampYaml(repoDir);
      await Deno.writeTextFile(
        join(repoDir, ".swamp.yaml"),
        JSON.stringify({
          ...marker,
          datastore: { type: bucket.typeName, config: {} },
        }),
      );
      const markerReads = () =>
        bucket.remote.controlPlaneReads().filter((read) =>
          read.key === MARKER_RECORD
        ).length;
      bucket.remote.failNext("controlPlane", new Error("offline"), {
        instance: "datastore",
      });
      const persisted = await resolveDatastoreForRepo(repoDir);
      assertEquals(persisted.engine, "v2");
      assertEquals(markerReads(), 1, "one capped read, then the v2 skip");

      // The same bucket named by SWAMP_DATASTORE carries no format: it may be
      // v3, so a marker that cannot be read refuses it rather than open v2.
      await withMockedEnv(
        { SWAMP_DATASTORE: `${bucket.typeName}:{}` },
        async () => {
          bucket.remote.offline(true);
          try {
            await assertRejects(
              () => resolveDatastoreForRepo(repoDir),
              UnreachableDatastoreFormatMarkerError,
            );
          } finally {
            bucket.remote.offline(false);
          }
        },
      );
    });
  },
});

Deno.test({
  name:
    "v3 bucket: datastore sync and index migration are refused, as on a filesystem v3 datastore (swamp-club#3534)",
  ignore: Deno.build.os === "windows",
  async fn() {
    await withRoot(async (root, bucket) => {
      const repoDir = join(root, "repo");
      await initRepo(repoDir);
      assertEquals(errorOf(await setupBucket(repoDir, bucket)), undefined);
      const { datastoreResolver } = await requireInitializedRepoReadOnly({
        repoDir,
        outputMode: "json",
      });
      const sync = await createDatastoreSyncDeps(repoDir, datastoreResolver);
      assertEquals(await sync.validateSyncSupport(), {
        supported: false,
        type: bucket.typeName,
        errorMessage:
          "Datastore sync is only for format 2 datastores. This is " +
          "a format 3 (v3) datastore, which replicates to its bucket as it " +
          "commits, so there is nothing to sync.",
      });
      const migrate = await createMigrateIndexDeps(repoDir, datastoreResolver);
      const migration = await migrate.validateMigrationSupport();
      assertEquals(migration.supported, false);
      assertStringIncludes(
        migration.errorMessage ?? "",
        "only for format 2 datastores",
      );
    });
  },
});

Deno.test({
  name:
    "v3 bucket: namespaced records live under ns/ in the bucket's control plane, beside nothing of the lease (swamp-club#3534)",
  ignore: Deno.build.os === "windows",
  async fn() {
    await withRoot(async (root, bucket) => {
      const solo = join(root, "solo");
      await initRepo(solo);
      assertEquals(errorOf(await setupBucket(solo, bucket)), undefined);
      // Two more checkouts on the same prefix, in namespaces named like the
      // lease's and the lineages' own records.
      const writer = join(root, "writer");
      const lineage = join(root, "lineage");
      await cloneRepo(solo, writer, (ds) => ds.namespace = "writer");
      await cloneRepo(solo, lineage, (ds) => ds.namespace = "lineage");
      const hour = hourStartOf(new Date());
      for (const repoDir of [solo, writer, lineage]) {
        const { repoContext } = await requireInitializedRepoReadOnly({
          repoDir,
          outputMode: "json",
        });
        assertEquals(repoContext.signalWaits?.supported, true);
        if (repoContext.signalWaits?.supported) {
          assertEquals(
            await repoContext.signalWaits.store.listRegistrations(),
            [],
          );
        }
        assert(
          await repoContext.retentionWatermarks!.claimHourlyPass(
            hour,
            `test:${repoDir}`,
            "cli",
          ),
        );
      }
      const keys = [...bucket.remote.controlPlaneRecords().keys()].filter((
        key,
      ) => key !== MARKER_RECORD);
      assertEquals(keys.length, 3);
      for (const key of keys) {
        assert(key.startsWith("_control/ns/"), key);
      }
      assertEquals(
        keys.map((key) => key.split("/")[2]).sort(),
        ["_", "lineage", "writer"],
      );
      const store = datastoreWriterLeaseStore(
        bucket.provider(),
        bucket.typeName,
      );
      assertEquals(await store.list("writer/"), []);
      assertEquals(await store.list("lineage/"), []);
    });
  },
});

Deno.test({
  name:
    "v3 bucket: lock status and release act on the bucket's v3 writer lease (swamp-club#3534)",
  ignore: Deno.build.os === "windows",
  async fn() {
    await withRoot(async (root, bucket) => {
      const repoDir = join(root, "repo");
      await initRepo(repoDir);
      assertEquals(errorOf(await setupBucket(repoDir, bucket)), undefined);
      const { datastoreConfig } = await resolveDatastoreForRepo(repoDir);
      const location = await v3DatastoreConfigOf(repoDir, datastoreConfig);
      const handle = v3WriterLockHandle(location.path);
      assertEquals(await handle.inspect(), null);
      // Another machine holds the lease.
      const hold = await (await v3WriterLease(
        datastoreWriterLeaseStore(bucket.provider(), bucket.typeName),
        60_000,
      )).acquire({ maxWaitMs: 0 });
      const held = await handle.inspect();
      assertEquals(held?.pid, Deno.pid);
      assertEquals(held?.fence, hold.fence);
      assert(await handle.forceRelease(held!.nonce!));
      assertEquals(await handle.inspect(), null);
    });
  },
});

Deno.test({
  name:
    "v3 bucket: a takeover's old lineage path is collected through the provider's replica paths (swamp-club#3534)",
  ignore: Deno.build.os === "windows",
  async fn() {
    await withRoot(async (root, bucket) => {
      const repoDir = join(root, "repo");
      await initRepo(repoDir);
      assertEquals(errorOf(await setupBucket(repoDir, bucket)), undefined);
      const { datastoreConfig } = await resolveDatastoreForRepo(repoDir);
      const location = await v3DatastoreConfigOf(repoDir, datastoreConfig);
      const binding = v3BucketBindingAt(location.path)!;
      // The provider's own target: no internal setting is set here.
      assertEquals(binding.replica.type, "s3");
      assertEquals(binding.replicaPaths?.root, "s3::team-bucket:");
      const copy = {
        datastorePath: location.path,
        repoDir,
        commitsDb: v3CommitsDbPath(location.path, repoDir),
      };
      for (const [fence, restored] of [[1, false], [2, true]] as const) {
        await prepareV3WriterLineage(copy, fence, { restored });
        await publishV3Head(copy, {
          lineageFence: fence,
          writerFence: fence,
          txid: `000000000000000${fence}`,
          mark: { cursor: fence },
        });
        bucket.remote.putReplicaObject!(
          `_litestream/00000000000${fence}/snapshot`,
          encode("x"),
        );
      }
      await collectV3Lineages(copy, 2, { replicaPaths: binding.replicaPaths! });
      assertEquals(
        await bucket.remote.objectExists("_litestream/000000000001/snapshot"),
        false,
      );
      assertEquals(
        await bucket.remote.objectExists("_litestream/000000000002/snapshot"),
        true,
      );
      assertEquals([...await lineageRegistryFor(location.path).fences()], [2]);
    });
  },
});

// --- Writers, with a real Litestream sidecar --------------------------------

/**
 * Runs `fn` with test timings, replicating to a file replica through the
 * internal setting, or with `providerReplica` to the provider's own target.
 */
async function withSidecar(
  root: string,
  fn: () => Promise<void>,
  options: { readonly providerReplica?: boolean } = {},
): Promise<void> {
  const started = new Set<number>();
  setV3ReplicationForTesting({
    processes: {
      ...hostLitestreamProcesses,
      launch: (launch) => {
        const pid = hostLitestreamProcesses.launch(launch);
        started.add(pid);
        return pid;
      },
    },
    privateRoot: join(root, "priv"),
    timings: TEST_TIMINGS,
  }, { syncDeadlineMs: 10_000 });
  try {
    await withMockedEnv(
      {
        [V3_REPLICA_ENV]: options.providerReplica === true
          ? undefined
          : JSON.stringify({ type: "file", path: join(root, "replica") }),
      },
      fn,
    );
  } finally {
    await closeV3Datastores().catch(() => {});
    setV3ReplicationForTesting(undefined);
    for (const pid of started) {
      hostLitestreamProcesses.signal(pid, "SIGCONT");
      hostLitestreamProcesses.signalGroup(pid, "SIGKILL");
    }
  }
}

/** One write command in `repoDir`: `commits` commits, then teardown. */
async function writeIn(repoDir: string, commits: number): Promise<void> {
  // Opened as a write command opens it: the writer lease and the context.
  await requireInitializedRepo({ repoDir, outputMode: "json" });
  const { datastoreConfig } = await resolveDatastoreForRepo(repoDir);
  const location = await v3DatastoreConfigOf(repoDir, datastoreConfig);
  await commitThrough(repoDir, location, commits);
  await flushDatastoreSync();
  await closeV3Datastores();
}

async function commitThrough(
  repoDir: string,
  location: { readonly path: string },
  commits: number,
): Promise<void> {
  const engine = v3DatastoreFor(repoDir, location).engineFor(
    () => Promise.resolve(),
    () => {
      throw new Error("no run repository needed");
    },
  );
  for (let i = 0; i < commits; i++) {
    await engine.runRoot({}, async () => {
      const unit = engine.openUnit() as unknown as CommitLogUnitOfWork;
      // Large enough to be stored as a chunk, not inline.
      const content = new Uint8Array(256 * 1024);
      crypto.getRandomValues(content.subarray(0, 65536));
      await unit.stageOps([
        new AutoDefinitionChanges(crypto.randomUUID()).write(
          recordKeyOf(["auto-definitions", `${crypto.randomUUID()}.yaml`]),
          content,
        ),
      ]);
      await unit.commit();
    });
  }
}

/** The record files under a checkout's `.swamp/<subdir>`, sorted. */
async function recordsIn(repoDir: string, subdir: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(swampPath(repoDir, subdir))) {
      names.push(entry.name);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return names.sort();
}

/** Opens `repoDir` read-only, which restores its copy, and counts its commits. */
async function restoredCommits(repoDir: string): Promise<number> {
  await requireInitializedRepoReadOnly({ repoDir, outputMode: "json" });
  const { datastoreConfig } = await resolveDatastoreForRepo(repoDir);
  const location = await v3DatastoreConfigOf(repoDir, datastoreConfig);
  const count = commitCount(v3CommitsDbPath(location.path, repoDir));
  await closeV3Datastores();
  return count;
}

Deno.test({
  name:
    "v3 bucket: a second checkout clones through .swamp.yaml, restores, takes over, and the first restores its commits (swamp-club#3534)",
  ignore: SIDECAR_TESTS_IGNORED,
  async fn() {
    await withRoot(async (root, bucket) => {
      const first = join(root, "first");
      await initRepo(first);
      assertEquals(errorOf(await setupBucket(first, bucket)), undefined);
      const second = join(root, "second");
      await cloneRepo(first, second);
      await withSidecar(root, async () => {
        await writeIn(first, 2);
        // The first command on the clone restores the published lineage.
        assertEquals(await restoredCommits(second), 2);
        // The clone takes over writing.
        await writeIn(second, 1);
        assertEquals(await restoredCommits(first), 3);
        // Its chunks went through the provider's storage.
        const chunks = [];
        for await (
          const chunk of bucket.remote.storage!().list(
            "_default",
            AbortSignal.timeout(5_000),
          )
        ) {
          chunks.push(chunk);
        }
        assert(chunks.length > 0, "the commits' chunks are in the bucket");
        // Lease and lineage records sit at the datastore root.
        const keys = [...bucket.remote.controlPlaneRecords().keys()];
        assert(keys.some((key) => key.startsWith("_control/writer/")));
        assert(keys.some((key) => key.startsWith("_control/lineage/")));
      });
    });
  },
});

Deno.test({
  name:
    "v3 bucket: a writer whose lease another checkout took is fenced, and its late commits never reach the published state (swamp-club#3534)",
  ignore: SIDECAR_TESTS_IGNORED,
  async fn() {
    await withRoot(async (root, bucket) => {
      const zombie = join(root, "zombie");
      await initRepo(zombie);
      assertEquals(errorOf(await setupBucket(zombie, bucket)), undefined);
      const taker = join(root, "taker");
      await cloneRepo(zombie, taker);
      const reader = join(root, "reader");
      await cloneRepo(zombie, reader);
      await withSidecar(root, async () => {
        await writeIn(zombie, 1);
        const zombieLocation = await v3DatastoreConfigOf(
          zombie,
          (await resolveDatastoreForRepo(zombie)).datastoreConfig,
        );
        await holdV3Writer(zombieLocation, zombie);
        // The taker clears the zombie's lease, as `datastore lock release
        // --force` does, and writes.
        const takerLocation = await v3DatastoreConfigOf(
          taker,
          (await resolveDatastoreForRepo(taker)).datastoreConfig,
        );
        const lease = v3WriterLockHandle(takerLocation.path);
        const held = await lease.inspect();
        assert(await lease.forceRelease(held!.nonce!));
        await holdV3Writer(takerLocation, taker);
        await commitThrough(taker, takerLocation, 1);
        // The zombie commits on, then closes: its lease check fails.
        await commitThrough(zombie, zombieLocation, 2);
        const error = await assertRejects(() => closeV3Datastores());
        assert(
          error instanceof WriterFencedError ||
            error instanceof V3ReplicationError,
          `fenced, not ${error}`,
        );
        // The published state is the taker's: 1 + 1, none of the zombie's 2.
        assertEquals(await restoredCommits(reader), 2);
        // The zombie's next command restores the published state and drops
        // its late records from its checkout (swamp-club#3553): it lists only
        // what the datastore holds.
        assertEquals(await restoredCommits(zombie), 2);
        assertEquals(
          await recordsIn(zombie, "auto-definitions"),
          await recordsIn(reader, "auto-definitions"),
        );
      });
    });
  },
});

const S3_ENDPOINT = Deno.env.get("SWAMP_TEST_LITESTREAM_S3_ENDPOINT");

Deno.test({
  name:
    "v3 bucket: an S3 datastore replicates to its provider's own target: write, clone, restore, take over (opt-in, swamp-club#3534)",
  // Needs the emulator's credentials in the environment Litestream inherits.
  ignore: SIDECAR_TESTS_IGNORED || S3_ENDPOINT === undefined,
  async fn() {
    const prefix = `v3-bucket-${crypto.randomUUID()}`;
    await withRoot(async (root, bucket) => {
      const first = join(root, "first");
      await initRepo(first);
      assertEquals(errorOf(await setupBucket(first, bucket)), undefined);
      const second = join(root, "second");
      await cloneRepo(first, second);
      await withSidecar(root, async () => {
        await writeIn(first, 1);
        assertEquals(await restoredCommits(second), 1);
        await writeIn(second, 1);
        assertEquals(await restoredCommits(first), 2);
      }, { providerReplica: true });
      const listing = await fetch(
        `${S3_ENDPOINT}/${
          Deno.env.get("SWAMP_TEST_LITESTREAM_S3_BUCKET") ?? "swamp-test"
        }?list-type=2&prefix=${prefix}/_litestream/`,
      );
      assertStringIncludes(await listing.text(), `${prefix}/_litestream/`);
    }, {
      replicaTarget: {
        type: "s3",
        bucket: Deno.env.get("SWAMP_TEST_LITESTREAM_S3_BUCKET") ?? "swamp-test",
        prefix,
        region: "us-east-1",
        endpoint: S3_ENDPOINT!,
        forcePathStyle: true,
      },
    });
  },
});

const GCS_EMULATOR = Deno.env.get("STORAGE_EMULATOR_HOST");
const GCS_BUCKET = Deno.env.get("SWAMP_TEST_LITESTREAM_GCS_BUCKET");

Deno.test({
  name:
    "v3 bucket: a GCS datastore replicates to its provider's own target through STORAGE_EMULATOR_HOST: write, clone, restore, take over (opt-in, swamp-club#3534)",
  // Litestream reaches fake-gcs-server only through STORAGE_EMULATOR_HOST,
  // which litestreamChildEnv passes to a gcs replica (rendered as type gs).
  ignore: SIDECAR_TESTS_IGNORED || GCS_EMULATOR === undefined ||
    GCS_BUCKET === undefined,
  async fn() {
    const prefix = `v3-bucket-${crypto.randomUUID()}`;
    await withRoot(async (root, bucket) => {
      const first = join(root, "first");
      await initRepo(first);
      assertEquals(errorOf(await setupBucket(first, bucket)), undefined);
      const second = join(root, "second");
      await cloneRepo(first, second);
      await withSidecar(root, async () => {
        await writeIn(first, 1);
        assertEquals(await restoredCommits(second), 1);
        await writeIn(second, 1);
        assertEquals(await restoredCommits(first), 2);
      }, { providerReplica: true });
      const listing = await fetch(
        `${GCS_EMULATOR}/storage/v1/b/${GCS_BUCKET}/o?prefix=${prefix}/_litestream/`,
      );
      assertStringIncludes(await listing.text(), `${prefix}/_litestream/`);
    }, {
      replicaTarget: { type: "gcs", bucket: GCS_BUCKET!, prefix },
    });
  },
});
