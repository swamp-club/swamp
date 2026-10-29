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

// A read or list method run takes no model lock while it runs
// (swamp-club#1992), and on a v2 extension datastore that lock was the only
// path that pulled before a run and published what it wrote: the versions a
// `get` that refreshes its resource wrote stayed on this host
// (swamp-club#3934). The run now pulls unlocked, runs unlocked, and takes the
// lock only to publish, refusing a version another clone wrote meanwhile.
// These tests drive `swamp model method run` in-process against two clones
// of one in-memory remote.

import "../src/domain/models/models.ts";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { Command } from "@cliffy/command";
import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { z } from "zod";
import {
  createInMemoryRemote,
  type InMemoryRemote,
  waitFor,
} from "@swamp-club/swamp-testing";
import { modelMethodCommand } from "../src/cli/commands/model_method_run.ts";
import { registerCompletionTypes } from "../src/cli/completion_types.ts";
import {
  acquireModelLocks,
  requireInitializedRepoUnlocked,
} from "../src/cli/repo_context.ts";
import { VERSION } from "../src/cli/commands/version.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import type {
  DistributedLock,
  LockOptions,
} from "../src/domain/datastore/distributed_lock.ts";
import {
  type DatastoreSyncOptions,
  DataVersionConflictError,
} from "../src/domain/datastore/datastore_sync_service.ts";
import { UserError } from "../src/domain/errors.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { flushDatastoreSync } from "../src/infrastructure/persistence/datastore_sync_coordinator.ts";
import {
  configureTestDatastore,
  registerTestDatastoreType,
} from "../src/infrastructure/testing/test_datastore_type.ts";

await initializeLogging({});

/** Hooks the probe's methods call, set per test. */
interface Hooks {
  /** Awaited before the read method writes. */
  beforeWrite?: () => Promise<void>;
  /** Awaited after the read method wrote. */
  afterWrite?: () => Promise<void>;
}
let hooks: Hooks = {};
/** While set, every clone's read of a `latest` marker fails. */
let failLatestReads = false;
/** Set to connect a sync service without `clearDirty`. */
let hideClearDirty = false;

function registerProbe(): ModelType {
  const type = ModelType.create(`test/read-publish-${crypto.randomUUID()}`);
  modelRegistry.register({
    type,
    version: "2026.10.28.1",
    resources: {
      state: {
        description: "Refreshed state",
        schema: z.object({ value: z.string() }),
        lifetime: "infinite",
        garbageCollection: 10,
      },
    },
    methods: {
      observe: {
        description: "Refresh the state, as a get does",
        kind: "read",
        arguments: z.object({ value: z.string() }),
        execute: async (args, context) => {
          await hooks.beforeWrite?.();
          const handle = await context.writeResource!("state", "main", {
            value: (args as { value: string }).value,
          });
          await hooks.afterWrite?.();
          return { dataHandles: [handle] };
        },
      },
      write: {
        description: "Write the state, as a mutating method does",
        arguments: z.object({ value: z.string() }),
        execute: async (args, context) => {
          const handle = await context.writeResource!("state", "main", {
            value: (args as { value: string }).value,
          });
          return { dataHandles: [handle] };
        },
      },
    },
  });
  return type;
}

/**
 * Per-key locks over one bucket, shared by both clones: `acquire` waits
 * while another holder has the key, as S3Lock does until its timeout.
 */
class LockTable {
  readonly held = new Set<string>();
  #waiters = new Map<string, Array<() => void>>();

  lockFor = (options?: LockOptions): DistributedLock => {
    const key = `${options?.namespace ?? ""}/${
      options?.lockKey ?? ".datastore.lock"
    }`;
    let holding = false;
    const acquire = async () => {
      while (this.held.has(key)) {
        await new Promise<void>((resolve) => {
          const waiting = this.#waiters.get(key) ?? [];
          waiting.push(resolve);
          this.#waiters.set(key, waiting);
        });
      }
      this.held.add(key);
      holding = true;
    };
    const release = () => {
      if (holding) {
        holding = false;
        this.held.delete(key);
        this.#waiters.get(key)?.shift()?.();
      }
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
      inspect: () => Promise.resolve(null),
      forceRelease: () => Promise.resolve(false),
    };
  };
}

interface Clones {
  remote: InMemoryRemote;
  locks: LockTable;
  repoA: string;
  repoB: string;
  type: ModelType;
  definition: Definition;
}

async function initRepo(repoDir: string, typeName: string): Promise<void> {
  await Deno.mkdir(repoDir, { recursive: true });
  const homeDir = join(repoDir, "test-home");
  await new RepoService(VERSION, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  }).init(RepoPath.create(repoDir), { tools: [] });
  await configureTestDatastore(repoDir, typeName);
}

/** Two clones of one repo, holding one probe definition, on one remote. */
async function withClones(fn: (clones: Clones) => Promise<void>) {
  const remote = createInMemoryRemote();
  const locks = new LockTable();
  const datastoreType = registerTestDatastoreType({
    connect: (cacheDir, options) => {
      const service = remote.connect(cacheDir, options);
      return new Proxy(service, {
        get(target, property) {
          if (property === "fetchContent") {
            return (relPath: string, fetchOptions?: DatastoreSyncOptions) =>
              failLatestReads && relPath.endsWith("/latest")
                ? Promise.reject(new Error("injected latest read failure"))
                : target.fetchContent!(relPath, fetchOptions);
          }
          if (property === "clearDirty" && hideClearDirty) return undefined;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  }, { createLock: locks.lockFor });
  const type = registerProbe();
  const dir = await Deno.makeTempDir({ prefix: "swamp-read-publish-" });
  try {
    const definition = Definition.create({
      name: "probe",
      type: type.normalized,
    });
    const repoA = join(dir, "a");
    const repoB = join(dir, "b");
    for (const repoDir of [repoA, repoB]) {
      await initRepo(repoDir, datastoreType.typeName);
      const ctx = await requireInitializedRepoUnlocked({
        repoDir,
        outputMode: "json",
      });
      try {
        await ctx.repoContext.definitionRepo.save(type, definition);
      } finally {
        await flushDatastoreSync();
        ctx.repoContext.catalogStore.close();
      }
    }
    await fn({ remote, locks, repoA, repoB, type, definition });
  } finally {
    hooks = {};
    failLatestReads = false;
    hideClearDirty = false;
    await flushDatastoreSync();
    modelRegistry.invalidateType(type);
    datastoreType.dispose();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/** `swamp model method run probe <method> --input value=<value>`. */
async function runMethod(
  repoDir: string,
  method: string,
  value: string,
): Promise<void> {
  const root = registerCompletionTypes(new Command()).globalOption(
    "--json",
    "JSON output",
  ).command("model", new Command().command("method", modelMethodCommand));
  await root.parse([
    "model",
    "method",
    "run",
    "probe",
    method,
    "--input",
    `value=${value}`,
    "--repo-dir",
    repoDir,
    "--json",
  ]);
}

/** The remote's committed object under the model ending with `suffix`. */
function remoteFile(
  c: Clones,
  suffix: string,
): Uint8Array | undefined {
  for (const [key, bytes] of c.remote.files()) {
    if (key.includes(c.definition.id) && key.endsWith(suffix)) return bytes;
  }
  return undefined;
}

/** The value version `version` of the state holds on the remote. */
function remoteValue(c: Clones, version: number): string | undefined {
  const bytes = remoteFile(c, `/main/${version}/raw`);
  if (bytes === undefined) return undefined;
  return (JSON.parse(new TextDecoder().decode(bytes)) as { value: string })
    .value;
}

function remoteLatest(c: Clones): string | undefined {
  const bytes = remoteFile(c, "/main/latest");
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
}

/** The value version `version` of the state holds in `repoDir`'s cache. */
async function localValue(
  repoDir: string,
  c: Clones,
  version: number,
): Promise<string | undefined> {
  const path = join(
    repoDir,
    ".test-cache",
    "data",
    ...c.type.normalized.split("/"),
    c.definition.id,
    "main",
    String(version),
  );
  try {
    const metadata = parseYaml(
      await Deno.readTextFile(join(path, "metadata.yaml")),
    ) as { id: string };
    assert(metadata.id);
    const raw = await Deno.readTextFile(join(path, "raw"));
    return (JSON.parse(raw) as { value: string }).value;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

Deno.test("model method run: a read method's writes reach the remote with no later run (swamp-club#3934)", async () => {
  await withClones(async (c) => {
    await runMethod(c.repoA, "observe", "from-read");

    assertEquals(remoteValue(c, 1), "from-read");
    assertEquals(remoteLatest(c), "1");
    // The run's method-summary report is published with it.
    assert(
      remoteFile(c, "/report-swamp-method-summary/1/metadata.yaml"),
      "the run's summary report should be on the remote",
    );
    assertEquals(c.locks.held.size, 0, "the publish lock was released");
  });
});

Deno.test("model method run: a read method pulls first and numbers its version past another clone's (swamp-club#3934)", async () => {
  await withClones(async (c) => {
    await runMethod(c.repoB, "write", "from-b");
    assertEquals(remoteValue(c, 1), "from-b");

    await runMethod(c.repoA, "observe", "from-a");

    assertEquals(remoteValue(c, 1), "from-b");
    assertEquals(remoteValue(c, 2), "from-a");
    assertEquals(remoteLatest(c), "2");
  });
});

Deno.test("model method run: a read method refuses to publish over a version another clone wrote during its run (swamp-club#3934)", async () => {
  await withClones(async (c) => {
    // A pulls (nothing yet), then B writes and publishes version 1 while A
    // runs, before A writes its own version 1 from its stale cache.
    let started!: () => void;
    const aStarted = new Promise<void>((resolve) => started = resolve);
    let resume!: () => void;
    const bDone = new Promise<void>((resolve) => resume = resolve);
    hooks = {
      beforeWrite: async () => {
        started();
        await bDone;
      },
    };
    const aRun = runMethod(c.repoA, "observe", "from-a");
    await aStarted;
    await runMethod(c.repoB, "write", "from-b");
    resume();

    const error = await assertRejects(() => aRun, DataVersionConflictError);
    assertEquals(error.code, "datastore_data_version_conflict");
    assertEquals(error.restored, true);
    assertStringIncludes(error.message, "now holds the datastore's copy");
    // B's run also wrote version 1 of its summary reports.
    assertEquals(
      error.versions.map((v) => `${v.dataName}/${v.version}`).sort(),
      [
        "main/1",
        "report-swamp-method-summary-json/1",
        "report-swamp-method-summary/1",
      ],
    );
    assertEquals(remoteValue(c, 1), "from-b", "B's version is kept");
    assertEquals(remoteLatest(c), "1");
    assertEquals(
      await localValue(c.repoA, c, 1),
      "from-b",
      "A's cache holds the datastore's copy, not its refused version",
    );
    assertEquals(c.locks.held.size, 0, "the publish lock was released");
  });
});

Deno.test("model method run: a refusal whose restore is incomplete pushes nothing, so the other clone's data is neither deleted nor rolled back (swamp-club#3934)", async () => {
  await withClones(async (c) => {
    let started!: () => void;
    const aStarted = new Promise<void>((resolve) => started = resolve);
    let resume!: () => void;
    const bDone = new Promise<void>((resolve) => resume = resolve);
    hooks = {
      beforeWrite: async () => {
        started();
        await bDone;
      },
    };
    const aRun = runMethod(c.repoA, "observe", "from-a");
    await aStarted;
    await runMethod(c.repoB, "write", "from-b");
    // The refusal's restore cannot read the latest markers back.
    failLatestReads = true;
    resume();

    const error = await assertRejects(() => aRun, DataVersionConflictError);
    failLatestReads = false;
    assertEquals(error.restored, false);
    assertStringIncludes(error.message, "could not be brought back");
    assertStringIncludes(error.message, "swamp datastore sync --pull");
    assertEquals(remoteValue(c, 1), "from-b", "B's version is kept");
    assertEquals(remoteLatest(c), "1", "B's latest marker is kept");
    assert(
      remoteFile(c, "/main/1/metadata.yaml"),
      "B's metadata is not deleted",
    );
    assertEquals(c.locks.held.size, 0, "the publish lock was released");
  });
});

Deno.test("model method run: a refusal on a sync service that cannot clear its marks pushes nothing and says this host is not back in line (swamp-club#3934)", async () => {
  hideClearDirty = true;
  await withClones(async (c) => {
    let started!: () => void;
    const aStarted = new Promise<void>((resolve) => started = resolve);
    let resume!: () => void;
    const bDone = new Promise<void>((resolve) => resume = resolve);
    hooks = {
      beforeWrite: async () => {
        started();
        await bDone;
      },
    };
    const aRun = runMethod(c.repoA, "observe", "from-a");
    await aStarted;
    await runMethod(c.repoB, "write", "from-b");
    resume();

    const error = await assertRejects(() => aRun, DataVersionConflictError);
    assertEquals(error.restored, false, "the refused names stay marked");
    assertStringIncludes(error.message, "swamp datastore sync --pull");
    assertEquals(remoteValue(c, 1), "from-b", "B's version is kept");
    assertEquals(remoteLatest(c), "1", "B's latest marker is kept");
    assertEquals(c.locks.held.size, 0, "the publish lock was released");
  });
});

Deno.test("model method run: a read method's version already uploaded by another push publishes without a conflict (swamp-club#3934)", async () => {
  await withClones(async (c) => {
    // After A writes, an unchecked namespace-wide push from this host (a
    // workflow's end-of-run push, serve's maintenance pass) uploads A's
    // version before A's own publish checks the remote.
    let wrote!: () => void;
    const aWrote = new Promise<void>((resolve) => wrote = resolve);
    let resume!: () => void;
    const pushed = new Promise<void>((resolve) => resume = resolve);
    hooks = {
      afterWrite: async () => {
        wrote();
        await pushed;
      },
    };
    const aRun = runMethod(c.repoA, "observe", "from-a");
    await aWrote;
    const other = await requireInitializedRepoUnlocked({
      repoDir: c.repoA,
      outputMode: "json",
    });
    try {
      await other.syncService!.pushChanged();
    } finally {
      await flushDatastoreSync();
      other.repoContext.catalogStore.close();
    }
    assertEquals(remoteValue(c, 1), "from-a");
    resume();

    await aRun;
    assertEquals(remoteValue(c, 1), "from-a");
    assertEquals(remoteLatest(c), "1");
  });
});

Deno.test("model method run: a read method whose publish cannot check the remote fails the command, naming the unpublished data (swamp-club#3934)", async () => {
  await withClones(async (c) => {
    hooks = {
      afterWrite: () => {
        c.remote.failNext("fetch", new Error("injected fetch failure"));
        return Promise.resolve();
      },
    };

    const error = await assertRejects(
      () => runMethod(c.repoA, "observe", "from-a"),
      UserError,
    );
    assertEquals(error.code, "datastore_publish_failed");
    assertStringIncludes(error.message, "injected fetch failure");
    assertEquals(remoteValue(c, 1), undefined, "nothing was published");
    assertEquals(c.locks.held.size, 0, "the publish lock was released");
  });
});

Deno.test("model method run: a read method runs while a writer holds the model lock and publishes after it releases (swamp-club#3934)", async () => {
  await withClones(async (c) => {
    const holder = await requireInitializedRepoUnlocked({
      repoDir: c.repoB,
      outputMode: "json",
    });
    let executed = false;
    hooks = {
      afterWrite: () => {
        executed = true;
        return Promise.resolve();
      },
    };
    const writerLock = await acquireModelLocks(
      holder.datastoreConfig,
      [{
        modelType: c.type.normalized,
        modelId: c.definition.id,
      }],
      c.repoB,
      holder.syncService,
      holder.repoContext.catalogStore,
      undefined,
      { repoContext: holder.repoContext },
    );
    let aRun: Promise<void> | undefined;
    try {
      let finished = false;
      aRun = runMethod(c.repoA, "observe", "from-a").finally(() => {
        finished = true;
      });
      // The method runs although the writer holds the lock (swamp-club#1992)
      await waitFor(() => executed, "the read method to run");
      assertEquals(finished, false, "the publish waits for the lock");
      assertEquals(remoteValue(c, 1), undefined);
    } finally {
      // Released on every outcome, so the read run's publish can settle.
      await writerLock.flush();
      await aRun;
      await flushDatastoreSync();
      holder.repoContext.catalogStore.close();
    }
    assertEquals(remoteValue(c, 1), "from-a");
  });
});
