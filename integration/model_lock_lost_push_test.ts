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

// On an extension datastore (S3, GCS) each clone allocates the next data
// version from its own cache, and the model lock is what keeps two clones
// from allocating the same one. After `swamp datastore lock release --force`
// the old holder used to push anyway, over the version the new holder wrote
// under the same key: both runs exited 0 and one write was lost
// (swamp-club#3373). The old holder now refuses its push and fails.

import "../src/domain/models/models.ts";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { configure, type LogRecord } from "@logtape/logtape";
import { basename, dirname, join, relative, SEPARATOR } from "@std/path";
import {
  createInMemoryRemote,
  type InMemoryRemote,
} from "@swamp-club/swamp-testing";
import { Data } from "../src/domain/data/data.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import type {
  DistributedLock,
  LockInfo,
  LockOptions,
} from "../src/domain/datastore/distributed_lock.ts";
import {
  ModelLockLostError,
  type WrittenVersion,
} from "../src/domain/datastore/datastore_sync_service.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { flushDatastoreSync } from "../src/infrastructure/persistence/datastore_sync_coordinator.ts";
import {
  configureTestDatastore,
  registerTestDatastoreType,
} from "../src/infrastructure/testing/test_datastore_type.ts";
import {
  acquireModelLocks,
  requireInitializedRepoUnlocked,
} from "../src/cli/repo_context.ts";
import { VERSION } from "../src/cli/commands/version.ts";
import type { AtomicWriteSync } from "../src/infrastructure/persistence/atomic_write.ts";

await initializeLogging({});

const modelType = ModelType.create("test/model-lock-lost");

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-model-lock-lost-" });
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

/** Clone A's process; clone B's is pid + 1 on the same host. */
const PROCESS_A = { holder: "sam@host", hostname: "host", pid: 4100 };

/**
 * One bucket's lock objects: every clone's locks read and write it, as
 * S3Lock and GcsLock do the bucket. Both clones run in this test's process;
 * each stamps its lock bodies with the pid of the process it stands for.
 * `blind` locks read nothing, as a backend that cannot report its holder.
 */
class LockTable {
  readonly entries = new Map<string, LockInfo>();

  lockFor(pid: number, blind = false) {
    return (options?: LockOptions): DistributedLock => {
      const key = `${options?.namespace ?? ""}/${
        options?.lockKey ?? ".datastore.lock"
      }`;
      let nonce: string | undefined;
      const release = () => {
        if (
          nonce !== undefined && this.entries.get(key)?.nonce === nonce
        ) {
          this.entries.delete(key);
        }
        nonce = undefined;
        return Promise.resolve();
      };
      const acquire = () => {
        const current = this.entries.get(key);
        if (current) {
          return Promise.reject(
            new Error(`${key} is held by pid ${current.pid}`),
          );
        }
        nonce = crypto.randomUUID();
        this.entries.set(key, {
          ...PROCESS_A,
          pid,
          acquiredAt: new Date().toISOString(),
          ttlMs: 30_000,
          nonce,
        });
        return Promise.resolve();
      };
      return {
        acquire,
        release,
        withLock: async <T>(fn: () => Promise<T>) => {
          await acquire();
          try {
            return await fn();
          } finally {
            await release();
          }
        },
        inspect: () =>
          Promise.resolve(blind ? null : this.entries.get(key) ?? null),
        forceRelease: (expected: string) => {
          if (this.entries.get(key)?.nonce !== expected) {
            return Promise.resolve(false);
          }
          this.entries.delete(key);
          return Promise.resolve(true);
        },
      };
    };
  }

  /** `swamp datastore lock release --force --model …`. */
  breakglass(modelId: string): void {
    const keys = [...this.entries.keys()].filter((k) => k.includes(modelId));
    assertEquals(keys.length, 1, "the model lock should be held");
    this.entries.delete(keys[0]);
  }
}

async function initRepo(
  repoDir: string,
  typeName: string,
  durable = false,
): Promise<void> {
  await Deno.mkdir(repoDir, { recursive: true });
  const homeDir = join(repoDir, "test-home");
  await new RepoService(VERSION, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  }).init(RepoPath.create(repoDir), { tools: [] });
  await configureTestDatastore(repoDir, typeName);
  if (durable) {
    const markerPath = join(repoDir, ".swamp.yaml");
    const marker = await Deno.readTextFile(markerPath);
    await Deno.writeTextFile(markerPath, marker + "  durable: true\n");
  }
}

type Unlocked = Awaited<ReturnType<typeof requireInitializedRepoUnlocked>>;

/**
 * Takes the model lock in `repoDir` (pulling) and saves `body` as a new
 * version of data "x", leaving the push to the caller: `flush` publishes
 * the version and releases the lock, `close` closes the catalog after.
 * `options.more` are saved as further versions in the same run.
 */
async function lockAndSave(
  repoDir: string,
  modelId: string,
  body: string,
  options: { more?: string[]; restoreWriteHooks?: AtomicWriteSync } = {},
) {
  const ctx: Unlocked = await requireInitializedRepoUnlocked({
    repoDir,
    outputMode: "json",
  });
  const lock = await acquireModelLocks(
    ctx.datastoreConfig,
    [{ modelType: modelType.normalized, modelId }],
    repoDir,
    ctx.syncService,
    ctx.repoContext.catalogStore,
    undefined,
    {
      repoContext: ctx.repoContext,
      restoreWriteHooks: options.restoreWriteHooks,
    },
  );
  if (lock.synced) ctx.repoContext.catalogStore.invalidate();
  const written: WrittenVersion[] = [];
  for (const b of [body, ...options.more ?? []]) {
    const saved = await ctx.repoContext.unifiedDataRepo.save(
      modelType,
      modelId,
      item(),
      new TextEncoder().encode(b),
    );
    written.push({
      modelType: modelType.normalized,
      modelId,
      dataName: "x",
      version: saved.version,
    });
  }
  return {
    version: written[0].version,
    flush: () => lock.flush(written),
    /** An unlocked push of everything dirty, as `workflow run` ends with. */
    pushUnlocked: async () => {
      await ctx.syncService!.pushChanged();
    },
    /** A pull, then a push, as a bare `swamp datastore sync` runs. */
    syncUnlocked: async () => {
      await ctx.syncService!.pullChanged();
      await ctx.syncService!.pushChanged();
    },
    /** The versions of data "x" in this clone's cache. */
    localVersions: () =>
      ctx.repoContext.unifiedDataRepo.listVersions(modelType, modelId, "x"),
    /** Data "x"'s directory in this clone's cache. */
    nameDir: () =>
      ctx.repoContext.unifiedDataRepo.getDataNameDir(modelType, modelId, "x"),
    /** The content of `version` of data "x" in this clone's cache. */
    content: async (version: number) => {
      ctx.repoContext.catalogStore.invalidate();
      const bytes = await ctx.repoContext.unifiedDataRepo.getContent(
        modelType,
        modelId,
        "x",
        version,
      );
      return bytes === null ? null : new TextDecoder().decode(bytes);
    },
    close: async () => {
      await flushDatastoreSync();
      ctx.repoContext.catalogStore.close();
    },
  };
}

async function saveAndPush(repoDir: string, modelId: string, body: string) {
  const run = await lockAndSave(repoDir, modelId, body);
  try {
    await run.flush();
  } finally {
    await run.close();
  }
  return run.version;
}

function item(): Data {
  return Data.create({
    name: "x",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 100,
    tags: { type: "resource", modelName: "m1" },
    ownerDefinition: { ownerType: "manual", ownerRef: "test-user" },
  });
}

/** The bodies of the remote's committed objects under the model. */
function remoteBodies(remote: InMemoryRemote, modelId: string): string[] {
  const decoder = new TextDecoder();
  return [...remote.files()]
    .filter(([key]) => key.includes(modelId))
    .map(([, bytes]) => decoder.decode(bytes))
    .filter((body) => body.startsWith("{"));
}

interface Clones {
  remote: InMemoryRemote;
  locks: LockTable;
  repoA: string;
  repoB: string;
  modelId: string;
}

/** Two clones of one repo on one remote and one lock table. */
async function withClones(
  twoPhaseSync: boolean,
  fn: (clones: Clones) => Promise<void>,
  options: {
    blindA?: boolean;
    bSameProcess?: boolean;
    /** Clone A's sync service has no `fetchContent`. */
    noFetchA?: boolean;
    /** Clone A's sync service has no `clearDirty`. */
    noClearA?: boolean;
    /** Clone A's datastore block sets `durable: true`. */
    durableA?: boolean;
  } = {},
): Promise<void> {
  const remote = createInMemoryRemote({
    capabilities: twoPhaseSync ? { twoPhaseSync: true } : {},
  });
  const locks = new LockTable();
  const typeA = registerTestDatastoreType(remote, {
    createLock: locks.lockFor(PROCESS_A.pid, options.blindA),
    connect: {
      ...(options.noFetchA ? { fetchContent: false } : {}),
      ...(options.noClearA ? { clearDirty: false } : {}),
    },
  });
  const typeB = registerTestDatastoreType(remote, {
    createLock: locks.lockFor(
      options.bSameProcess ? PROCESS_A.pid : PROCESS_A.pid + 1,
    ),
  });
  try {
    await withTempDir(async (dir) => {
      const repoA = join(dir, "a");
      const repoB = join(dir, "b");
      await initRepo(repoA, typeA.typeName, options.durableA);
      await initRepo(repoB, typeB.typeName);
      await fn({
        remote,
        locks,
        repoA,
        repoB,
        modelId: crypto.randomUUID(),
      });
    });
  } finally {
    typeA.dispose();
    typeB.dispose();
  }
}

for (const twoPhaseSync of [true, false]) {
  Deno.test(`acquireModelLocks: a holder whose lock was force-released and taken refuses to push and keeps the other run's version (twoPhaseSync=${twoPhaseSync})`, async () => {
    await withClones(twoPhaseSync, async (c) => {
      const a = await lockAndSave(c.repoA, c.modelId, '{"by":"a"}');
      try {
        c.locks.breakglass(c.modelId);
        const bVersion = await saveAndPush(c.repoB, c.modelId, '{"by":"b"}');
        assertEquals(bVersion, a.version, "both clones allocate one version");

        const error = await assertRejects(() => a.flush(), ModelLockLostError);
        assertEquals(error.code, "model_lock_lost");
        assertEquals(error.lost[0].heldBy, undefined);
        // The refusal pulled B's version over A's, so a later unlocked push
        // from A (a workflow's end-of-run push) does not overwrite it.
        await a.pushUnlocked();
      } finally {
        await a.close();
      }
      assertEquals(remoteBodies(c.remote, c.modelId), ['{"by":"b"}']);
      assertEquals(c.locks.entries.size, 0, "B's push released its lock");

      // A's next run pulls B's version over its own and publishes a new one.
      const next = await saveAndPush(c.repoA, c.modelId, '{"by":"a2"}');
      assertEquals(next, a.version + 1);
      assertEquals(
        remoteBodies(c.remote, c.modelId).sort(),
        ['{"by":"a2"}', '{"by":"b"}'],
      );
    });
  });

  Deno.test(`acquireModelLocks: a holder whose lock another process holds names it and pushes nothing (twoPhaseSync=${twoPhaseSync})`, async () => {
    await withClones(twoPhaseSync, async (c) => {
      const a = await lockAndSave(c.repoA, c.modelId, '{"by":"a"}');
      const b = await (async () => {
        c.locks.breakglass(c.modelId);
        return await lockAndSave(c.repoB, c.modelId, '{"by":"b"}');
      })();
      try {
        const error = await assertRejects(() => a.flush(), ModelLockLostError);
        assertEquals(error.lost[0].heldBy?.pid, PROCESS_A.pid + 1);
        assert(error.message.includes("Nothing was pushed"));
        assertEquals(remoteBodies(c.remote, c.modelId), []);
        assertEquals(c.locks.entries.size, 1, "A left B's lock in place");
        await b.flush();
      } finally {
        await a.close();
        await b.close();
      }
      assertEquals(remoteBodies(c.remote, c.modelId), ['{"by":"b"}']);
    });
  });

  Deno.test(`acquireModelLocks: a holder whose lock was force-released and not retaken pushes nothing (twoPhaseSync=${twoPhaseSync})`, async () => {
    await withClones(twoPhaseSync, async (c) => {
      const a = await lockAndSave(c.repoA, c.modelId, '{"by":"a"}');
      try {
        c.locks.breakglass(c.modelId);
        await assertRejects(() => a.flush(), ModelLockLostError);
      } finally {
        await a.close();
      }
      assertEquals(remoteBodies(c.remote, c.modelId), []);
    });
  });

  Deno.test(`acquireModelLocks: a holder whose lock is still its own pushes (twoPhaseSync=${twoPhaseSync})`, async () => {
    await withClones(twoPhaseSync, async (c) => {
      await saveAndPush(c.repoA, c.modelId, '{"by":"a"}');
      assertEquals(remoteBodies(c.remote, c.modelId), ['{"by":"a"}']);
      assertEquals(c.locks.entries.size, 0);
    });
  });

  Deno.test(`acquireModelLocks: a holder whose lock another run of the same process took refuses to push (twoPhaseSync=${twoPhaseSync})`, async () => {
    await withClones(twoPhaseSync, async (c) => {
      const a = await lockAndSave(c.repoA, c.modelId, '{"by":"a"}');
      const b = await (async () => {
        c.locks.breakglass(c.modelId);
        return await lockAndSave(c.repoB, c.modelId, '{"by":"b"}');
      })();
      try {
        const error = await assertRejects(() => a.flush(), ModelLockLostError);
        assertEquals(error.lost[0].heldBy?.pid, PROCESS_A.pid);
        assertEquals(remoteBodies(c.remote, c.modelId), []);
        await b.flush();
      } finally {
        await a.close();
        await b.close();
      }
      assertEquals(remoteBodies(c.remote, c.modelId), ['{"by":"b"}']);
    }, { bSameProcess: true });
  });

  Deno.test(`acquireModelLocks: a lock that cannot report its holder is not checked, as before (twoPhaseSync=${twoPhaseSync})`, async () => {
    await withClones(twoPhaseSync, async (c) => {
      const a = await lockAndSave(c.repoA, c.modelId, '{"by":"a"}');
      try {
        c.locks.breakglass(c.modelId);
        await a.flush();
      } finally {
        await a.close();
      }
      assertEquals(remoteBodies(c.remote, c.modelId), ['{"by":"a"}']);
    }, { blindA: true });
  });
}

/** The remote's latest marker of data "x" under the model. */
function remoteLatest(remote: InMemoryRemote, modelId: string): string[] {
  const decoder = new TextDecoder();
  return [...remote.files()]
    .filter(([key]) => key.includes(modelId) && key.endsWith("/x/latest"))
    .map(([, bytes]) => decoder.decode(bytes).trim());
}

// A refusal used to rely on its refresh pull to replace the refused versions
// in the cache. When the pull could not run, they stayed dirty and a later
// push uploaded them (swamp-club#3485). The refusal now discards them, and
// puts back the datastore's copy of each file, so a later push neither
// uploads the refused write nor deletes another holder's same version.
for (const twoPhaseSync of [true, false]) {
  for (const later of ["push", "pull then push"] as const) {
    const sync = (
      a: { pushUnlocked(): Promise<void>; syncUnlocked(): Promise<void> },
    ) => later === "push" ? a.pushUnlocked() : a.syncUnlocked();

    Deno.test(`acquireModelLocks: a refusal while the datastore is unreachable discards the run's version, and a later ${later} sends none of it (twoPhaseSync=${twoPhaseSync})`, async () => {
      await withClones(twoPhaseSync, async (c) => {
        const a = await lockAndSave(c.repoA, c.modelId, '{"by":"a"}');
        try {
          // An unreachable bucket that GcsLock.inspect() reads as no lock.
          c.locks.breakglass(c.modelId);
          c.remote.offline(true);
          const error = await assertRejects(
            () => a.flush(),
            ModelLockLostError,
          );
          assertEquals(error.code, "model_lock_lost");
          assertEquals(await a.localVersions(), []);
          c.remote.offline(false);
          await sync(a);
        } finally {
          await a.close();
        }
        assertEquals(remoteBodies(c.remote, c.modelId), []);
        // B's next run finds no version of A's to build on.
        const bVersion = await saveAndPush(c.repoB, c.modelId, '{"by":"b"}');
        assertEquals(bVersion, 1);
        assertEquals(remoteBodies(c.remote, c.modelId), ['{"by":"b"}']);
      });
    });

    Deno.test(`acquireModelLocks: a refusal after a breakglass whose refresh pull fails keeps the other run's version through a later ${later} (twoPhaseSync=${twoPhaseSync})`, async () => {
      await withClones(twoPhaseSync, async (c) => {
        const a = await lockAndSave(c.repoA, c.modelId, '{"by":"a"}');
        try {
          c.locks.breakglass(c.modelId);
          const bVersion = await saveAndPush(c.repoB, c.modelId, '{"by":"b"}');
          assertEquals(bVersion, a.version, "both clones allocate one version");
          c.remote.failNext("pull");
          await assertRejects(() => a.flush(), ModelLockLostError);
          await sync(a);
        } finally {
          await a.close();
        }
        assertEquals(remoteBodies(c.remote, c.modelId), ['{"by":"b"}']);
        assertEquals(remoteLatest(c.remote, c.modelId), [String(a.version)]);

        const next = await saveAndPush(c.repoA, c.modelId, '{"by":"a2"}');
        assertEquals(next, a.version + 1);
        assertEquals(
          remoteBodies(c.remote, c.modelId).sort(),
          ['{"by":"a2"}', '{"by":"b"}'],
        );
      });
    });
  }

  Deno.test(`acquireModelLocks: without fetchContent, a refusal after a breakglass whose refresh pull fails still keeps the other run's version through a later pull then push (twoPhaseSync=${twoPhaseSync})`, async () => {
    await withClones(twoPhaseSync, async (c) => {
      const a = await lockAndSave(c.repoA, c.modelId, '{"by":"a"}');
      try {
        c.locks.breakglass(c.modelId);
        await saveAndPush(c.repoB, c.modelId, '{"by":"b"}');
        c.remote.failNext("pull");
        await assertRejects(() => a.flush(), ModelLockLostError);
        assertEquals(await a.localVersions(), []);
        await a.syncUnlocked();
      } finally {
        await a.close();
      }
      assertEquals(remoteBodies(c.remote, c.modelId), ['{"by":"b"}']);
      assertEquals(remoteLatest(c.remote, c.modelId), ["1"]);
    }, { noFetchA: true });
  });
}

/** The local latest marker of data "x" in `nameDir`, or undefined. */
async function localLatest(nameDir: string): Promise<string | undefined> {
  try {
    return (await Deno.readTextFile(join(nameDir, "latest"))).trim();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

/**
 * Restore hooks that log each file a refusal's restore syncs (`file:`) and
 * each directory (`dir:`), in order. `failFile` and `failDir` make a sync
 * throw.
 */
function restoreSyncLog(
  options: {
    failFile?: (target: string) => boolean;
    failDir?: boolean;
  } = {},
) {
  const log: string[] = [];
  const hooks: AtomicWriteSync = {
    syncFile: (file, paths) => {
      log.push(`file:${paths.target}`);
      if (options.failFile?.(paths.target)) {
        return Promise.reject(new Error(`sync of ${paths.target} failed`));
      }
      return file.sync();
    },
    syncDirectory: (dir) => {
      log.push(`dir:${dir}`);
      return options.failDir
        ? Promise.reject(new Error(`sync of ${dir} failed`))
        : Promise.resolve();
    },
  };
  return { log, hooks };
}

/** The directories from `dir` up to the cache's `data` directory. */
function dirsUpToDataRoot(dir: string): string[] {
  const dirs = [dir];
  while (basename(dir) !== "data" && dirname(dir) !== dir) {
    dir = dirname(dir);
    dirs.push(dir);
  }
  return dirs;
}

// A refusal's restore wrote each file unsynced and in the order it was
// removed, so a latest marker could reach the disk before the content it
// names, and a marker naming a version the cache never held was restored
// (swamp-club#4033). With durable writes, content now comes first, then its
// directories, then the markers; a marker's version is restored with it.
for (const twoPhaseSync of [true, false]) {
  Deno.test(`acquireModelLocks: a durable refusal restores content, then syncs each directory once, then the latest marker (twoPhaseSync=${twoPhaseSync})`, async () => {
    await withClones(twoPhaseSync, async (c) => {
      const sync = restoreSyncLog();
      const a = await lockAndSave(c.repoA, c.modelId, '{"by":"a1"}', {
        more: ['{"by":"a2"}'],
        restoreWriteHooks: sync.hooks,
      });
      let nameDir: string;
      try {
        c.locks.breakglass(c.modelId);
        await saveAndPush(c.repoB, c.modelId, '{"by":"b1"}');
        await saveAndPush(c.repoB, c.modelId, '{"by":"b2"}');
        c.remote.failNext("pull");
        await assertRejects(() => a.flush(), ModelLockLostError);
        nameDir = a.nameDir();
        assertEquals(await localLatest(nameDir), "2");
        assertEquals(await a.content(2), '{"by":"b2"}');
      } finally {
        await a.close();
      }
      const latest = `file:${join(nameDir, "latest")}`;
      const markerAt = sync.log.indexOf(latest);
      assertEquals(sync.log.lastIndexOf(latest), markerAt);
      const content = sync.log.slice(0, markerAt).filter((e) =>
        e.startsWith("file:")
      );
      assertEquals(
        content.sort(),
        ["1/metadata.yaml", "1/raw", "2/metadata.yaml", "2/raw"]
          .map((f) => `file:${join(nameDir, ...f.split("/"))}`),
      );
      const firstDir = sync.log.findIndex((e) => e.startsWith("dir:"));
      assert(
        sync.log.slice(firstDir, markerAt).every((e) => e.startsWith("dir:")),
        `content synced after a directory: ${sync.log.join(", ")}`,
      );
      const dirs = sync.log.slice(firstDir, markerAt);
      assertEquals(
        [...dirs].sort(),
        [
          join(nameDir, "1"),
          join(nameDir, "2"),
          ...dirsUpToDataRoot(nameDir),
        ].map((d) => `dir:${d}`).sort(),
        "each directory up to the data root is synced once",
      );
      // The marker's own write syncs its directory.
      assertEquals(sync.log.slice(markerAt + 1), [`dir:${nameDir}`]);
    }, { durableA: true });
  });

  for (const durable of [true, false]) {
    for (const later of ["push", "pull then push"] as const) {
      Deno.test(`acquireModelLocks: a refusal restores the version the datastore's latest marker names before the marker, and a later ${later} keeps it (durable=${durable}, twoPhaseSync=${twoPhaseSync})`, async () => {
        await withClones(twoPhaseSync, async (c) => {
          const sync = restoreSyncLog();
          const a = await lockAndSave(c.repoA, c.modelId, '{"by":"a1"}', {
            restoreWriteHooks: sync.hooks,
          });
          try {
            c.locks.breakglass(c.modelId);
            await saveAndPush(c.repoB, c.modelId, '{"by":"b1"}');
            await saveAndPush(c.repoB, c.modelId, '{"by":"b2"}');
            c.remote.failNext("pull");
            await assertRejects(() => a.flush(), ModelLockLostError);
            const nameDir = a.nameDir();
            assertEquals(await localLatest(nameDir), "2");
            assertEquals(await a.content(2), '{"by":"b2"}');
            if (durable) {
              const markerAt = sync.log.indexOf(
                `file:${join(nameDir, "latest")}`,
              );
              for (const f of ["metadata.yaml", "raw"]) {
                const at = sync.log.indexOf(`file:${join(nameDir, "2", f)}`);
                assert(at >= 0 && at < markerAt, `2/${f} before the marker`);
              }
            } else {
              assertEquals(sync.log, [], "durable off syncs nothing");
            }
            await (later === "push" ? a.pushUnlocked() : a.syncUnlocked());
          } finally {
            await a.close();
          }
          assertEquals(remoteLatest(c.remote, c.modelId), ["2"]);
          assertEquals(
            remoteBodies(c.remote, c.modelId).sort(),
            ['{"by":"b1"}', '{"by":"b2"}'],
          );
        }, { durableA: durable });
      });
    }
  }

  Deno.test(`acquireModelLocks: a refusal restores a latest marker naming a version the datastore lacks, so a later push keeps the datastore's marker (twoPhaseSync=${twoPhaseSync})`, async () => {
    await withClones(twoPhaseSync, async (c) => {
      const a = await lockAndSave(c.repoA, c.modelId, '{"by":"a1"}');
      try {
        c.locks.breakglass(c.modelId);
        await saveAndPush(c.repoB, c.modelId, '{"by":"b1"}');
        // B publishes a marker naming version 3, which it never wrote.
        const b: Unlocked = await requireInitializedRepoUnlocked({
          repoDir: c.repoB,
          outputMode: "json",
        });
        try {
          await Deno.writeTextFile(
            join(
              b.repoContext.unifiedDataRepo.getDataNameDir(
                modelType,
                c.modelId,
                "x",
              ),
              "latest",
            ),
            "3",
          );
          await b.syncService!.markDirty();
          await b.syncService!.pushChanged();
        } finally {
          b.repoContext.catalogStore.close();
        }
        assertEquals(remoteLatest(c.remote, c.modelId), ["3"]);
        c.remote.failNext("pull");
        await assertRejects(() => a.flush(), ModelLockLostError);
        assertEquals(await localLatest(a.nameDir()), "3");
        assertEquals(await a.content(1), '{"by":"b1"}');
        await a.pushUnlocked();
      } finally {
        await a.close();
      }
      assertEquals(remoteLatest(c.remote, c.modelId), ["3"]);
    }, { durableA: true });
  });

  Deno.test(`acquireModelLocks: a refusal whose directory sync fails still restores the latest marker (twoPhaseSync=${twoPhaseSync})`, async () => {
    await withClones(twoPhaseSync, async (c) => {
      const sync = restoreSyncLog({ failDir: true });
      const a = await lockAndSave(c.repoA, c.modelId, '{"by":"a1"}', {
        more: ['{"by":"a2"}'],
        restoreWriteHooks: sync.hooks,
      });
      try {
        c.locks.breakglass(c.modelId);
        await saveAndPush(c.repoB, c.modelId, '{"by":"b1"}');
        await saveAndPush(c.repoB, c.modelId, '{"by":"b2"}');
        c.remote.failNext("pull");
        await assertRejects(() => a.flush(), ModelLockLostError);
        assertEquals(await localLatest(a.nameDir()), "2");
        await a.pushUnlocked();
      } finally {
        await a.close();
      }
      assertEquals(remoteLatest(c.remote, c.modelId), ["2"]);
    }, { durableA: true });
  });

  Deno.test(`acquireModelLocks: a refusal whose content restore fails fetches nothing more and still restores the latest marker (twoPhaseSync=${twoPhaseSync})`, async () => {
    await withClones(twoPhaseSync, async (c) => {
      let nameDir = "";
      const sync = restoreSyncLog({
        failFile: (target) => dirname(target) === join(nameDir, "2"),
      });
      const a = await lockAndSave(c.repoA, c.modelId, '{"by":"a1"}', {
        more: ['{"by":"a2"}'],
        restoreWriteHooks: sync.hooks,
      });
      nameDir = a.nameDir();
      try {
        c.locks.breakglass(c.modelId);
        await saveAndPush(c.repoB, c.modelId, '{"by":"b1"}');
        await saveAndPush(c.repoB, c.modelId, '{"by":"b2"}');
        const before = c.remote.ops().length;
        c.remote.failNext("pull");
        await assertRejects(() => a.flush(), ModelLockLostError);
        const fetched = c.remote.ops().slice(before)
          .filter((op) => op.op === "fetch")
          .flatMap((op) => op.paths)
          .filter((path) => path.includes(c.modelId));
        assert(
          fetched.at(-1)?.includes("/x/2/"),
          `the failed x/2 file is the last fetched: ${fetched.join(", ")}`,
        );
        assertEquals(
          sync.log.filter((e) => e.startsWith(`file:${join(nameDir, "2")}`))
            .length,
          1,
          "only one x/2 file was written",
        );
        assertEquals(await localLatest(nameDir), "2");
        await a.pushUnlocked();
      } finally {
        await a.close();
      }
      assertEquals(remoteLatest(c.remote, c.modelId), ["2"]);
    }, { durableA: true });
  });

  Deno.test(`acquireModelLocks: a refusal whose latest marker cannot be read still restores the refused version's content (twoPhaseSync=${twoPhaseSync})`, async () => {
    await withClones(twoPhaseSync, async (c) => {
      const a = await lockAndSave(c.repoA, c.modelId, '{"by":"a1"}');
      try {
        c.locks.breakglass(c.modelId);
        await saveAndPush(c.repoB, c.modelId, '{"by":"b1"}');
        await saveAndPush(c.repoB, c.modelId, '{"by":"b2"}');
        const before = c.remote.ops().length;
        c.remote.failNext("pull");
        // The restore reads the markers first: this fails the read of x/latest.
        c.remote.failNext("fetch");
        await assertRejects(() => a.flush(), ModelLockLostError);
        const fetched = c.remote.ops().slice(before)
          .filter((op) => op.op === "fetch")
          .flatMap((op) => op.paths)
          .filter((path) => path.includes(c.modelId));
        assert(
          fetched.some((path) => path.endsWith("/x/1/raw")),
          `the content restore ran: ${fetched.join(", ")}`,
        );
        assertEquals(await a.content(1), '{"by":"b1"}');
        await a.pushUnlocked();
      } finally {
        await a.close();
      }
      assert(
        remoteBodies(c.remote, c.modelId).includes('{"by":"b1"}'),
        "the datastore keeps the new holder's version 1",
      );
    }, { durableA: true });
  });
}

/** The versions of data "x" the remote holds under the model, sorted. */
function remoteVersions(remote: InMemoryRemote, modelId: string): number[] {
  return [...remote.files().keys()]
    .filter((key) =>
      key.includes(modelId) && /\/x\/\d+\/metadata\.yaml$/.test(key)
    )
    .map((key) => Number(key.split("/").at(-2)))
    .sort((p, q) => p - q);
}

/**
 * The warnings logged while `fn` runs, as text. LogTape's configuration is
 * process-global, so the normal setup is restored afterwards.
 */
async function warningsDuring(fn: () => Promise<void>): Promise<string[]> {
  const captured: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => captured.push(record) },
    loggers: [
      { category: [], lowestLevel: "warning", sinks: ["capture"] },
      { category: ["logtape", "meta"], lowestLevel: "fatal", sinks: [] },
    ],
    reset: true,
  });
  try {
    await fn();
  } finally {
    await initializeLogging({ _reset: true });
  }
  return captured.map((record) =>
    record.message.map((part) => typeof part === "string" ? part : String(part))
      .join("")
  );
}

/** The marks clone `repoDir` holds under data "x"'s directory. */
async function marksUnderName(
  remote: InMemoryRemote,
  repoDir: string,
  nameDir: string,
): Promise<string[]> {
  const cache = join(repoDir, ".test-cache");
  const nameRel = relative(cache, nameDir).split(SEPARATOR).join("/");
  const { marked } = await remote.pendingPush(cache);
  return marked.filter((rel) =>
    rel === nameRel || rel.startsWith(`${nameRel}/`)
  );
}

// A refused push left its paths marked, the data-name directory among them
// (a save marks it before allocating a version). A later push walked the
// marked directory and deleted every version of the new holder's that the
// cache lacked, and uploaded the stale latest marker over the holder's
// (swamp-club#4091). The discard now clears those marks once its restore
// matched the datastore. These pin the in-memory remote's scoped push,
// which models swamp-extensions s3_cache_sync.ts collectPushWork: a marked
// directory's remote entries the cache lacks are deleted, and a marked file
// that differs is uploaded.
for (const twoPhaseSync of [true, false]) {
  for (const later of ["push", "pull then push"] as const) {
    const sync = (
      a: { pushUnlocked(): Promise<void>; syncUnlocked(): Promise<void> },
    ) => later === "push" ? a.pushUnlocked() : a.syncUnlocked();

    Deno.test(`acquireModelLocks: a refusal whose refresh pull fails keeps every version the other run wrote, and its latest marker, through a later ${later} (swamp-club#4091, twoPhaseSync=${twoPhaseSync})`, async () => {
      await withClones(twoPhaseSync, async (c) => {
        const a = await lockAndSave(c.repoA, c.modelId, '{"by":"a"}');
        try {
          c.locks.breakglass(c.modelId);
          const b = await lockAndSave(c.repoB, c.modelId, '{"by":"b1"}', {
            more: ['{"by":"b2"}', '{"by":"b3"}'],
          });
          try {
            await b.flush();
          } finally {
            await b.close();
          }
          c.remote.failNext("pull");
          await assertRejects(() => a.flush(), ModelLockLostError);
          assertEquals(
            await marksUnderName(c.remote, c.repoA, await a.nameDir()),
            [],
          );
          await sync(a);
        } finally {
          await a.close();
        }
        assertEquals(remoteVersions(c.remote, c.modelId), [1, 2, 3]);
        assertEquals(remoteLatest(c.remote, c.modelId), ["3"]);
      });
    });

    Deno.test(`acquireModelLocks: a version the other run pushes after the refusal survives a later ${later}, and the refused clone's next write is still pushed (swamp-club#4091, twoPhaseSync=${twoPhaseSync})`, async () => {
      await withClones(twoPhaseSync, async (c) => {
        const a = await lockAndSave(c.repoA, c.modelId, '{"by":"a"}');
        try {
          c.locks.breakglass(c.modelId);
          await saveAndPush(c.repoB, c.modelId, '{"by":"b1"}');
          await assertRejects(() => a.flush(), ModelLockLostError);
          assertEquals(await saveAndPush(c.repoB, c.modelId, '{"by":"b2"}'), 2);
          await sync(a);
        } finally {
          await a.close();
        }
        assertEquals(remoteVersions(c.remote, c.modelId), [1, 2]);
        assertEquals(remoteLatest(c.remote, c.modelId), ["2"]);

        assertEquals(await saveAndPush(c.repoA, c.modelId, '{"by":"a2"}'), 3);
        assertEquals(remoteVersions(c.remote, c.modelId), [1, 2, 3]);
        assertEquals(remoteLatest(c.remote, c.modelId), ["3"]);
        assertEquals(
          remoteBodies(c.remote, c.modelId).sort(),
          ['{"by":"a2"}', '{"by":"b1"}', '{"by":"b2"}'],
        );
      });
    });
  }

  Deno.test(`acquireModelLocks: with clearDirty, a refusal gives no warning about marks it could not clear (swamp-club#4091, twoPhaseSync=${twoPhaseSync})`, async () => {
    await withClones(twoPhaseSync, async (c) => {
      const a = await lockAndSave(c.repoA, c.modelId, '{"by":"a"}');
      try {
        c.locks.breakglass(c.modelId);
        await saveAndPush(c.repoB, c.modelId, '{"by":"b"}');
        const warnings = await warningsDuring(async () => {
          await assertRejects(() => a.flush(), ModelLockLostError);
        });
        assertEquals(
          warnings.filter((text) => text.includes("clear the dirty marks")),
          [],
        );
      } finally {
        await a.close();
      }
    });
  });

  Deno.test(`acquireModelLocks: a refusal whose restore cannot read the datastore keeps the marks its writes left (swamp-club#4091, twoPhaseSync=${twoPhaseSync})`, async () => {
    await withClones(twoPhaseSync, async (c) => {
      const a = await lockAndSave(c.repoA, c.modelId, '{"by":"a"}');
      try {
        c.locks.breakglass(c.modelId);
        await saveAndPush(c.repoB, c.modelId, '{"by":"b"}');
        c.remote.failNext("fetch");
        await assertRejects(() => a.flush(), ModelLockLostError);
        const nameDir = await a.nameDir();
        assert(
          (await marksUnderName(c.remote, c.repoA, nameDir)).length > 0,
          "the marks stay when the restore did not match the datastore",
        );
        assertEquals(
          c.remote.ops().filter((op) => op.op === "clearDirty"),
          [],
        );
      } finally {
        await a.close();
      }
    });
  });

  Deno.test(`acquireModelLocks: without clearDirty, a refusal leaves its marks as before and warns once, naming the data name, that a later push can delete the other run's versions (swamp-club#4091, twoPhaseSync=${twoPhaseSync})`, async () => {
    await withClones(twoPhaseSync, async (c) => {
      const a = await lockAndSave(c.repoA, c.modelId, '{"by":"a"}');
      try {
        c.locks.breakglass(c.modelId);
        await saveAndPush(c.repoB, c.modelId, '{"by":"b"}');
        const warnings = (await warningsDuring(async () => {
          await assertRejects(() => a.flush(), ModelLockLostError);
        })).filter((text) => text.includes("clear the dirty marks"));
        assertEquals(warnings.length, 1, warnings.join("\n"));
        assertStringIncludes(warnings[0], `${c.modelId}/x`);
        assertStringIncludes(
          warnings[0],
          "a later push from this checkout can delete or overwrite the versions the other run wrote there",
        );
        assertStringIncludes(warnings[0], "Updating the datastore extension");
        assertEquals(await a.localVersions(), [1]);
        assert(
          (await marksUnderName(c.remote, c.repoA, await a.nameDir())).length >
            0,
        );
      } finally {
        await a.close();
      }
      assertEquals(remoteBodies(c.remote, c.modelId), ['{"by":"b"}']);
    }, { noClearA: true });
  });
}
