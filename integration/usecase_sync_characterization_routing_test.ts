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

// Characterization of how signalChange routes a hooked repository write
// (swamp-club#3240), recorded before the unit-of-work binding registry
// replaced legacyUnitOfWorkTarget. Each row runs a real repository on a temp
// directory and records where its change went: staged into which unit, which
// hook it marked, and whether it took route 2 (the hook fallback, reported).
// These expectations must not change when the registry lands.

import "../src/domain/models/models.ts";
import { assertEquals, assertNotEquals } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import type { DatastoreSyncService } from "../src/domain/datastore/datastore_sync_service.ts";
import type { MarkDirtyHook } from "../src/domain/datastore/datastore_sync_service.ts";
import type {
  StagedChange,
  UnitOfWork,
} from "../src/domain/datastore/unit_of_work.ts";
import { VaultConfig } from "../src/domain/vaults/vault_config.ts";
import { buildManagedLockfileTransaction } from "../src/cli/managed_config_sync.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { DefaultDatastorePathResolver } from "../src/infrastructure/persistence/default_datastore_path_resolver.ts";
import { LockfileRepository } from "../src/infrastructure/persistence/lockfile_repository.ts";
import {
  openRepoUnitOfWork,
  runInRootUnitOfWork,
} from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import {
  createRepositoryContext,
  type RepositoryContext,
} from "../src/infrastructure/persistence/repository_factory.ts";
import {
  runInUnitOfWork,
  type UnscopedChange,
  useUnscopedChangeReporterForTesting,
} from "../src/infrastructure/persistence/unit_of_work_scope.ts";

await initializeLogging({});

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

/** A mark hook that records the absolute path of each call. */
function recordingHook(): {
  hook: MarkDirtyHook;
  marks: (string | undefined)[];
} {
  const marks: (string | undefined)[] = [];
  const hook: MarkDirtyHook = (absPath?: string) => {
    marks.push(absPath);
    return Promise.resolve();
  };
  return { hook, marks };
}

interface Harness {
  dir: string;
  /** A repository context over `hook`, on the temp directory's cache. */
  context(hook: MarkDirtyHook): RepositoryContext;
  /** Every route-2 write reported so far, as its change. */
  reported(): readonly StagedChange[];
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  await withTempDir(async (dir) => {
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
    const vaultsDir = join(resolver.resolvePath("config"), "vaults");
    const opened: RepositoryContext[] = [];
    const reports: UnscopedChange[] = [];
    const dispose = useUnscopedChangeReporterForTesting((report) => {
      reports.push(report);
    });
    try {
      await fn({
        dir,
        context(hook) {
          const ctx = createRepositoryContext({
            repoDir,
            enableIndexing: false,
            datastoreResolver: resolver,
            markDirty: hook,
            vaultsDir,
          });
          opened.push(ctx);
          return ctx;
        },
        reported: () => reports.map((report) => report.change),
      });
    } finally {
      dispose();
      for (const ctx of opened) ctx.catalogStore.close();
    }
  });
}

/** Saves a new vault config: a hooked write through a real repository. */
async function saveVault(ctx: RepositoryContext): Promise<void> {
  await ctx.vaultConfigRepo.save(
    VaultConfig.create(
      crypto.randomUUID(),
      `probe-${crypto.randomUUID()}`,
      "local_encryption",
      {},
    ),
  );
}

/** The paths a list of staged changes names, `undefined` for bulk. */
function targets(changes: readonly StagedChange[]): (string | undefined)[] {
  return changes.map((change) =>
    change.kind === "bulk" ? undefined : change.path
  );
}

Deno.test("routing characterization: a write inside a root over its own hook stages into the root", async () => {
  await withHarness(async (h) => {
    const { hook, marks } = recordingHook();
    const ctx = h.context(hook);
    let staged: readonly StagedChange[] = [];
    await runInRootUnitOfWork(ctx, { flush: undefined }, async (root) => {
      await saveVault(ctx);
      staged = root.staged();
    });
    assertNotEquals(staged.length, 0);
    assertEquals(marks, targets(staged));
    assertEquals(h.reported(), []);
  });
});

Deno.test("routing characterization: a write inside a use-case child stages into the child and rolls up into the root", async () => {
  await withHarness(async (h) => {
    const { hook, marks } = recordingHook();
    const ctx = h.context(hook);
    let rootStaged: readonly StagedChange[] = [];
    let child: UnitOfWork | undefined;
    await runInRootUnitOfWork(ctx, { flush: undefined }, async (root) => {
      child = openRepoUnitOfWork(hook);
      await runInUnitOfWork(child, () => saveVault(ctx));
      await child.commit();
      rootStaged = root.staged();
    });
    const childStaged = child!.staged();
    assertNotEquals(childStaged.length, 0);
    assertEquals(rootStaged, childStaged);
    assertEquals(marks, targets(childStaged));
    assertEquals(h.reported(), []);
  });
});

Deno.test("routing characterization: a root over another hook does not take the write, and a root for the write's hook inside it is a root", async () => {
  await withHarness(async (h) => {
    const a = recordingHook();
    const b = recordingHook();
    const ctxA = h.context(a.hook);
    let outerStaged: readonly StagedChange[] = [];
    let innerStaged: readonly StagedChange[] = [];
    let innerFlushes = 0;
    await runInRootUnitOfWork({ markDirty: b.hook }, {
      flush: undefined,
    }, async (outer) => {
      // A write on hook A inside B's root: route 2.
      await saveVault(ctxA);
      const reportedInB = h.reported().length;
      assertNotEquals(reportedInB, 0);
      // A root for A inside B's root is a root: it may flush.
      await runInRootUnitOfWork(ctxA, {
        flush: () => {
          innerFlushes++;
          return Promise.resolve();
        },
      }, async (inner) => {
        await saveVault(ctxA);
        innerStaged = inner.staged();
      });
      assertEquals(h.reported().length, reportedInB);
      outerStaged = outer.staged();
    });
    assertEquals(outerStaged, []);
    assertNotEquals(innerStaged.length, 0);
    assertEquals(innerFlushes, 1);
    assertEquals(b.marks, []);
    assertEquals(a.marks, [...targets(h.reported()), ...targets(innerStaged)]);
  });
});

Deno.test("routing characterization: a root over a wrapper of the hook does not match, so the write takes route 2", async () => {
  await withHarness(async (h) => {
    const { hook, marks } = recordingHook();
    const ctx = h.context(hook);
    const wrapped: MarkDirtyHook = (absPath) => hook(absPath);
    let staged: readonly StagedChange[] = [];
    await runInRootUnitOfWork({ markDirty: wrapped }, {
      flush: undefined,
    }, async (root) => {
      await saveVault(ctx);
      staged = root.staged();
    });
    assertEquals(staged, []);
    assertNotEquals(h.reported().length, 0);
    assertEquals(marks, targets(h.reported()));
  });
});

Deno.test("routing characterization: a unit of work not built by the legacy adapter never takes the write", async () => {
  await withHarness(async (h) => {
    const { hook, marks } = recordingHook();
    const ctx = h.context(hook);
    const stagedIntoForeign: StagedChange[] = [];
    const foreign: UnitOfWork = {
      stage(change) {
        stagedIntoForeign.push(change);
        return Promise.resolve();
      },
      commit: () => Promise.resolve(),
      abandon: () => Promise.resolve(),
      staged: () => [...stagedIntoForeign],
    };
    await runInUnitOfWork(foreign, () => saveVault(ctx));
    assertEquals(stagedIntoForeign, []);
    assertNotEquals(h.reported().length, 0);
    assertEquals(marks, targets(h.reported()));
  });
});

/**
 * A sync service for the CLI lockfile transaction: it records marks and
 * pushes, pulls nothing, and reports one file pushed so the publish
 * succeeds.
 */
function lockfileSyncService(): {
  service: DatastoreSyncService;
  marks: (string | undefined)[];
  pushes: number;
} {
  const state = { marks: [] as (string | undefined)[], pushes: 0 };
  const service: DatastoreSyncService = {
    markDirty(options) {
      state.marks.push(options?.relPath);
      return Promise.resolve();
    },
    pullChanged: () => Promise.resolve(0),
    pushChanged() {
      state.pushes++;
      return Promise.resolve(1);
    },
  };
  return {
    service,
    get marks() {
      return state.marks;
    },
    get pushes() {
      return state.pushes;
    },
  };
}

Deno.test("routing characterization: inside the CLI lockfile root (swamp-club#3192) a command's repository write takes route 2 and the lockfile stages into the root", async () => {
  await withHarness(async (h) => {
    const command = recordingHook();
    const ctx = h.context(command.hook);
    const cacheDir = join(h.dir, "lockfile-cache");
    const repoDir = join(h.dir, "lockfile-repo");
    await ensureDir(join(repoDir, ".swamp"));
    const lockfilePath = join(
      cacheDir,
      "ns1",
      "config",
      "upstream_extensions.json",
    );
    const sync = lockfileSyncService();
    const transaction = buildManagedLockfileTransaction({
      syncService: sync.service,
      datastoreConfig: {
        type: "@swamp/s3-datastore",
        config: { bucket: "test" },
        datastorePath: cacheDir,
        cachePath: cacheDir,
        namespace: "ns1",
      },
      repoDir,
      lockfilePath,
      lock: {
        acquire: () => Promise.resolve(),
        release: () => Promise.resolve(),
      },
    });
    await transaction.run(async () => {
      await saveVault(ctx);
      const lockfile = await LockfileRepository.create(lockfilePath);
      await lockfile.writeEntry("@me/x", "1", []);
    });
    // The command's write is route 2: reported, and marked on its own hook.
    assertNotEquals(h.reported().length, 0);
    assertEquals(command.marks, targets(h.reported()));
    // The lockfile went through the transaction's root and its checkpoint.
    assertEquals(sync.marks, ["ns1/config/upstream_extensions.json"]);
    assertEquals(sync.pushes, 1);
  });
});
