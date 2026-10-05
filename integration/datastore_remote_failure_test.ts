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

// Pins what happens when the remote fails during sync, through each real
// flush path (swamp-club#2859): the local write survives, the path stays
// dirty, and the next successful flush publishes it so a peer repo reads
// it. Phase 1's legacy unit-of-work adapter must keep exactly these
// semantics, including the asymmetry between the flush paths:
//
// - `acquireModelLocks().flush` (single-phase and two-phase) THROWS
//   "<type> push failed: <msg>" and still releases the model locks;
// - the global coordinator `flushDatastoreSync` WARNS on
//   ["datastore", "sync"] and resolves, so a command that did its work
//   does not fail on cleanup (issue #157);
// - `pushManagedConfigChanges` THROWS `ManagedConfigUnpublishedError`.
//
// Dirty state lives inside the sync service, so it is observed through
// the fake's read-only `pendingPush(cacheDir)`: the files and deletes the
// next push from A's cache would send, with no side effects.

import "../src/domain/models/models.ts";
import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
} from "@std/assert";
import { relative, SEPARATOR } from "@std/path";
import { walk } from "@std/fs";
import { configure, type LogRecord } from "@logtape/logtape";
import {
  type InMemoryRemoteOpRecord,
  LEGACY_EXTENSION_SEMANTICS,
} from "@swamp-club/swamp-testing";
import {
  acquireModelLocks,
  type ModelLockResult,
  requireInitializedRepo,
  requireInitializedRepoUnlocked,
} from "../src/cli/repo_context.ts";
import {
  ManagedConfigUnpublishedError,
  pushManagedConfigChanges,
} from "../src/cli/managed_config_sync.ts";
import type { Definition } from "../src/domain/definitions/definition.ts";
import { UserError } from "../src/domain/errors.ts";
import type { RepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  flushDatastoreSync,
  getRegisteredLockKeys,
} from "../src/infrastructure/persistence/datastore_sync_coordinator.ts";
import { createLegacyUnitOfWork } from "../src/infrastructure/persistence/legacy_unit_of_work.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { runInUnitOfWork } from "../src/infrastructure/persistence/unit_of_work_scope.ts";
import { saveData, saveModel } from "./serve_request_harness.ts";
import {
  baseline,
  cacheDir,
  type RowRepoOptions,
  type RowRepos,
  runCli,
  runCliRejecting,
  settle,
  syncOrder,
  UNSET_ENV,
  withRowRepos,
} from "./usecase_sync_fixtures.ts";

await initializeLogging({});

const SINGLE_PHASE: RowRepoOptions = { remote: { capabilities: {} } };
const TWO_PHASE: RowRepoOptions = {
  remote: { capabilities: { twoPhaseSync: true } },
};

/** Runs `fn` against fresh repos A and B, with the developer's env unset. */
function withRepos(
  options: RowRepoOptions,
  fn: (repos: RowRepos) => Promise<void>,
): Promise<void> {
  return withMockedEnv(UNSET_ENV, () => withRowRepos(options, fn));
}

/** Discards lock progress lines; `acquireModelLocks` writes to stderr otherwise. */
const quiet = (_message: string): void => {};

function typeName(repos: RowRepos): string {
  return repos.a.datastoreConfig.type;
}

function modelsOf(repos: RowRepos, model: Definition) {
  return [{ modelType: repos.modelType.normalized, modelId: model.id }];
}

/** Acquires A's per-model lock for `model`; the acquire pulls. */
function lockOnA(
  repos: RowRepos,
  model: Definition,
): Promise<ModelLockResult> {
  return acquireModelLocks(
    repos.a.datastoreConfig,
    modelsOf(repos, model),
    repos.repoA,
    repos.a.syncService,
    undefined,
    quiet,
  );
}

/** Saves a data item through `repoContext` (A's shared one by default). */
function writeData(
  repos: RowRepos,
  model: Definition,
  dataName: string,
  repoContext: RepositoryContext = repos.a.repoContext,
) {
  return saveData({ ...repos.serveRepo, repoContext }, model, dataName);
}

/** The files a push from A's cache would upload now; empty when clean. */
async function dirtyOnA(repos: RowRepos): Promise<string[]> {
  return (await repos.remote.pendingPush(cacheDir(repos.repoA))).uploads;
}

/** Remote keys belonging to `model`'s data, sorted. */
function remoteKeysOf(repos: RowRepos, model: Definition): string[] {
  return [...repos.remote.files().keys()]
    .filter((key) => key.includes(model.id)).sort();
}

/** Every file under `dir`, keyed by forward-slash relative path. */
async function snapshotTree(dir: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for await (const entry of walk(dir, { includeDirs: false })) {
    files.set(
      relative(dir, entry.path).split(SEPARATOR).join("/"),
      await Deno.readFile(entry.path),
    );
  }
  return files;
}

/**
 * A's cache files belonging to `model`, sorted by path, with their bytes:
 * its data (keyed by model id) and, under managedConfig, its definition
 * (`<type dir>/<name>.yaml`).
 */
async function localFilesOf(
  repos: RowRepos,
  model: Definition,
): Promise<Map<string, Uint8Array>> {
  const tree = await snapshotTree(cacheDir(repos.repoA));
  const definition = `${repos.modelType.toDirectoryPath()}/${model.name}.yaml`;
  const keys = [...tree.keys()]
    .filter((rel) => rel.includes(model.id) || rel.endsWith(definition))
    .sort();
  return new Map(keys.map((rel) => [rel, tree.get(rel)!]));
}

/** Instance A's push-side ops (push, prepare, commit) since `from`. */
function pushOpsSince(repos: RowRepos, from: number): string[] {
  return repos.remote.ops().slice(from)
    .filter((op: InMemoryRemoteOpRecord) =>
      op.instance === "A" &&
      (op.op === "push" || op.op === "prepare" || op.op === "commit")
    )
    .map((op) => op.op);
}

/**
 * What repo B reads for `model`'s `dataName` after its own step-start pull:
 * the content of the latest version and every version number.
 */
async function readOnB(
  repos: RowRepos,
  model: Definition,
  dataName: string,
): Promise<{ content: string | null; versions: number[] }> {
  const b = await requireInitializedRepoUnlocked({
    repoDir: repos.repoB,
    outputMode: "json",
  });
  try {
    const locks = await acquireModelLocks(
      b.datastoreConfig,
      modelsOf(repos, model),
      repos.repoB,
      b.syncService,
      undefined,
      quiet,
    );
    try {
      const content = await b.repoContext.unifiedDataRepo.getContent(
        repos.modelType,
        model.id,
        dataName,
      );
      const versions = await b.repoContext.unifiedDataRepo.listVersions(
        repos.modelType,
        model.id,
        dataName,
      );
      return {
        content: content && new TextDecoder().decode(content),
        versions,
      };
    } finally {
      await locks.flush();
    }
  } finally {
    b.repoContext.catalogStore.close();
  }
}

/** The content `saveData` writes for `dataName`. */
function savedContent(dataName: string): string {
  return JSON.stringify({ value: dataName });
}

/** Captures warnings and errors logged under ["datastore"] during `fn`. */
async function captureDatastoreLogs(
  fn: () => Promise<void>,
): Promise<LogRecord[]> {
  const captured: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => captured.push(record) },
    loggers: [
      { category: ["datastore"], lowestLevel: "warning", sinks: ["capture"] },
    ],
    reset: true,
  });
  try {
    await fn();
  } finally {
    await initializeLogging({ _reset: true });
  }
  return captured;
}

function renderRecord(record: LogRecord): string {
  return record.message.map((part) => String(part)).join("");
}

// --- acquireModelLocks().flush: push failure throws ---------------------

for (
  const { label, options, failOp } of [
    {
      label: "single-phase push",
      options: SINGLE_PHASE,
      failOp: "push" as const,
    },
    {
      label: "two-phase prepare",
      options: TWO_PHASE,
      failOp: "prepare" as const,
    },
  ]
) {
  Deno.test(`acquireModelLocks: a ${label} failing on flush throws, keeps the write dirty, and the next flush publishes it`, async () => {
    await withRepos(options, async (repos) => {
      const model = await saveModel(repos.serveRepo, "writer");
      const locks = await lockOnA(repos, model);
      await writeData(repos, model, "item");
      const written = await localFilesOf(repos, model);
      assert(written.size > 0, "the save wrote files into A's cache");

      const injected = new Error(`injected ${failOp} failure`);
      repos.remote.failNext(failOp, injected, { instance: "A" });
      const thrown = await assertRejects(() => locks.flush(), Error);
      // Per-model flush THROWS, unlike the coordinator (see below).
      assertEquals(
        thrown.message,
        `${typeName(repos)} push failed: injected ${failOp} failure`,
      );
      assertEquals(thrown.cause, injected);
      assertEquals(getRegisteredLockKeys(), [], "model locks released");

      // Local write intact, still dirty, nothing published.
      assertEquals(await localFilesOf(repos, model), written);
      assertEquals(await dirtyOnA(repos), [...written.keys()]);
      assertEquals(remoteKeysOf(repos, model), []);

      // One retry flush publishes it.
      const retryFrom = repos.remote.ops().length;
      const retry = await lockOnA(repos, model);
      await retry.flush();
      assertEquals(
        pushOpsSince(repos, retryFrom),
        failOp === "push" ? ["push"] : ["prepare", "commit"],
      );
      assertEquals(remoteKeysOf(repos, model), [...written.keys()]);
      for (const [rel, bytes] of written) {
        assertEquals(repos.remote.files().get(rel), bytes);
      }
      assertEquals(await dirtyOnA(repos), []);
      assertEquals(await readOnB(repos, model, "item"), {
        content: savedContent("item"),
        versions: [1],
      });
    });
  });
}

/**
 * The push-failure-on-flush flow above, reduced to what A, the remote and B
 * observe, with the per-run datastore type, model type and model id
 * replaced. When `scoped`,
 * the write runs inside a legacy unit-of-work scope bound to A's own hook
 * (swamp-club#2971); the flush path is unchanged.
 */
async function failedFlushOutcome(
  options: RowRepoOptions,
  failOp: "push" | "prepare",
  scoped: boolean,
): Promise<unknown> {
  let outcome: unknown;
  await withRepos(options, async (repos) => {
    const model = await saveModel(repos.serveRepo, "writer");
    const anonymise = (text: string) =>
      text.replaceAll(model.id, "<model>")
        .replaceAll(repos.modelType.normalized, "<model type>")
        .replaceAll(typeName(repos), "<type>");
    const locks = await lockOnA(repos, model);
    if (scoped) {
      const hook = repos.a.repoContext.markDirty;
      assert(hook !== undefined, "expected A's composition-built mark hook");
      const uow = createLegacyUnitOfWork(hook, { flush: undefined });
      await runInUnitOfWork(uow, () => writeData(repos, model, "item"));
      assert(uow.staged().length > 0, "expected A's write to stage");
    } else {
      await writeData(repos, model, "item");
    }
    repos.remote.failNext(failOp, new Error(`injected ${failOp} failure`), {
      instance: "A",
    });
    const thrown = await assertRejects(() => locks.flush(), Error);
    const dirty = await dirtyOnA(repos);
    const retryFrom = repos.remote.ops().length;
    const retry = await lockOnA(repos, model);
    await retry.flush();
    outcome = {
      thrown: anonymise(thrown.message),
      dirty: dirty.map(anonymise),
      retryOps: pushOpsSince(repos, retryFrom),
      remote: remoteKeysOf(repos, model).map(anonymise),
      dirtyAfter: await dirtyOnA(repos),
      b: await readOnB(repos, model, "item"),
    };
  });
  return outcome;
}

for (
  const { label, options, failOp } of [
    {
      label: "single-phase push",
      options: SINGLE_PHASE,
      failOp: "push" as const,
    },
    {
      label: "two-phase prepare",
      options: TWO_PHASE,
      failOp: "prepare" as const,
    },
  ]
) {
  Deno.test(`acquireModelLocks: a ${label} failing on flush after a write inside a legacy unit of work scope fails and recovers exactly as without one`, async () => {
    const unscoped = await failedFlushOutcome(options, failOp, false);
    const scoped = await failedFlushOutcome(options, failOp, true);
    assertEquals(scoped, unscoped);
  });
}

Deno.test("acquireModelLocks: a two-phase commit failing on flush releases the locks, keeps the write dirty, and a retry commits it once", async () => {
  await withRepos(TWO_PHASE, async (repos) => {
    const model = await saveModel(repos.serveRepo, "writer");
    const from = repos.remote.ops().length;
    const locks = await lockOnA(repos, model);
    await writeData(repos, model, "item");
    const written = await localFilesOf(repos, model);

    const injected = new Error("injected commit failure");
    repos.remote.failNext("commit", injected, { instance: "A" });
    const thrown = await assertRejects(() => locks.flush(), Error);
    assertEquals(
      thrown.message,
      `${typeName(repos)} push failed: injected commit failure`,
    );
    assertEquals(thrown.cause, injected);
    assertEquals(getRegisteredLockKeys(), [], "model locks released");

    // Prepare uploaded the content, but nothing is published and the
    // paths stay dirty for the retry.
    assertEquals(await localFilesOf(repos, model), written);
    assertEquals(await dirtyOnA(repos), [...written.keys()]);
    assertEquals(remoteKeysOf(repos, model), []);

    const retry = await lockOnA(repos, model);
    await retry.flush();
    // The failed commit is not recorded: prepare (failed attempt), then
    // the retry's prepare and its one commit.
    assertEquals(pushOpsSince(repos, from), ["prepare", "prepare", "commit"]);
    assertEquals(remoteKeysOf(repos, model), [...written.keys()]);
    assertEquals(await dirtyOnA(repos), []);
    // Exactly one version, on the remote and on B.
    assertEquals(
      remoteKeysOf(repos, model).filter((key) => key.endsWith("/raw")).length,
      1,
    );
    assertEquals(await readOnB(repos, model, "item"), {
      content: savedContent("item"),
      versions: [1],
    });
  });
});

// --- flushDatastoreSync: push failure warns and is swallowed ------------

Deno.test("flushDatastoreSync: a failed push warns and resolves, keeps the write dirty, and the next flush publishes it", async () => {
  await withRepos(SINGLE_PHASE, async (repos) => {
    const model = await saveModel(repos.serveRepo, "writer");
    // A command's context: registers the global entry and pulls.
    const ctx = await requireInitializedRepo({
      repoDir: repos.repoA,
      outputMode: "json",
    });
    let written: Map<string, Uint8Array>;
    let logs: LogRecord[];
    try {
      await writeData(repos, model, "item", ctx.repoContext);
      written = await localFilesOf(repos, model);
      assert(written.size > 0, "the save wrote files into A's cache");

      repos.remote.failNext("push", new Error("injected push failure"), {
        instance: "A",
      });
      // The coordinator WARNS and does not throw, where the per-model flush
      // throws: a transient push error must not fail a command that already
      // did its work (issue #157). Phase 1 must keep this asymmetry.
      logs = await captureDatastoreLogs(() => flushDatastoreSync());
    } finally {
      ctx.repoContext.catalogStore.close();
    }
    assertEquals(
      logs.map((record) => [
        record.category.join("."),
        record.level,
        renderRecord(record),
      ]),
      [[
        "datastore.sync",
        "warning",
        `${typeName(repos)} push failed: injected push failure`,
      ]],
    );
    assertEquals(getRegisteredLockKeys(), []);

    assertEquals(await localFilesOf(repos, model), written);
    assertEquals(await dirtyOnA(repos), [...written.keys()]);
    assertEquals(remoteKeysOf(repos, model), []);

    const retryFrom = repos.remote.ops().length;
    const retryCtx = await requireInitializedRepo({
      repoDir: repos.repoA,
      outputMode: "json",
    });
    try {
      await flushDatastoreSync();
    } finally {
      retryCtx.repoContext.catalogStore.close();
    }
    assertEquals(pushOpsSince(repos, retryFrom), ["push"]);
    assertEquals(remoteKeysOf(repos, model), [...written.keys()]);
    assertEquals(await dirtyOnA(repos), []);
    assertEquals(await readOnB(repos, model, "item"), {
      content: savedContent("item"),
      versions: [1],
    });
  });
});

// --- pushManagedConfigChanges: push failure throws ----------------------

Deno.test("pushManagedConfigChanges: a failed push throws ManagedConfigUnpublishedError, keeps the write dirty, and the next push publishes it", async () => {
  await withRepos({ managedConfig: true }, async (repos) => {
    const model = await saveModel(repos.serveRepo, "managed");
    const written = await localFilesOf(repos, model);
    assert(written.size > 0, "the definition was written into A's cache");

    const injected = new Error("injected push failure");
    repos.remote.failNext("push", injected, { instance: "A" });
    // swamp-club#2859 says managed config warns; since swamp-club#2752 it
    // throws ManagedConfigUnpublishedError and keeps the local write.
    const thrown = await assertRejects(
      () =>
        pushManagedConfigChanges(
          repos.a.syncService,
          repos.a.datastoreConfig,
          repos.a.marker,
        ),
      ManagedConfigUnpublishedError,
    );
    assertEquals(thrown.code, "managed_config_unpublished");
    assertEquals(thrown.cause, injected);

    assertEquals(await localFilesOf(repos, model), written);
    assert(
      [...written.keys()].every((rel) =>
        repos.remote.files().get(rel) === undefined
      ),
      "nothing published",
    );
    const dirty = await dirtyOnA(repos);
    for (const rel of written.keys()) {
      assert(dirty.includes(rel), `${rel} still dirty`);
    }

    const retryFrom = repos.remote.ops().length;
    await pushManagedConfigChanges(
      repos.a.syncService,
      repos.a.datastoreConfig,
      repos.a.marker,
    );
    assertEquals(pushOpsSince(repos, retryFrom), ["push"]);
    for (const [rel, bytes] of written) {
      assertEquals(repos.remote.files().get(rel), bytes);
    }
    assertEquals(await dirtyOnA(repos), []);

    const b = await requireInitializedRepoUnlocked({
      repoDir: repos.repoB,
      outputMode: "json",
    });
    try {
      await b.syncService!.pullChanged();
      const onB = await b.repoContext.definitionRepo.findById(
        repos.modelType,
        model.id,
      );
      assertEquals(onB?.name, "managed");
    } finally {
      b.repoContext.catalogStore.close();
    }
  });
});

// --- Pull failure: the command fails and no local state changes ---------

/** Publishes a data item from B, so A's next pull has something to fetch. */
async function publishFromB(repos: RowRepos): Promise<Definition> {
  const b = await requireInitializedRepoUnlocked({
    repoDir: repos.repoB,
    outputMode: "json",
  });
  try {
    const peer = { ...repos.serveRepo, repoContext: b.repoContext };
    const model = await saveModel(peer, "peer");
    await saveData(peer, model, "item");
    await b.syncService!.pushChanged();
    assert(remoteKeysOf(repos, model).length > 0, "B published its write");
    return model;
  } finally {
    b.repoContext.catalogStore.close();
  }
}

Deno.test("acquireModelLocks: a failed pull throws, changes nothing locally, and leaves the model entry registered until flushDatastoreSync", async () => {
  await withRepos(SINGLE_PHASE, async (repos) => {
    const model = await publishFromB(repos);
    const before = await snapshotTree(repos.repoA);
    const from = repos.remote.ops().length;

    const injected = new Error("injected pull failure");
    repos.remote.failNext("pull", injected, { instance: "A" });
    const thrown = await assertRejects(() => lockOnA(repos, model), Error);
    assertEquals(
      thrown.message,
      `Datastore sync failed: could not pull data for ${repos.modelType.normalized}/${model.id}: injected pull failure`,
    );
    assertEquals(await snapshotTree(repos.repoA), before);
    assertEquals(
      repos.remote.ops().slice(from).filter((op) => op.instance === "A"),
      [],
    );

    // Today the coordinator entry registered before the pull is NOT
    // unwound: the model lock stays held until flushDatastoreSync runs.
    // The CLI teardown runs it on error (src/cli/mod.ts), but serve has no
    // such teardown, so there the model lock stays held (swamp-club#2901).
    assertEquals(getRegisteredLockKeys().length, 1);
    await flushDatastoreSync();
    assertEquals(getRegisteredLockKeys(), []);
  });
});

Deno.test("requireInitializedRepo: a failed pull throws, unwinds the global entry, and changes nothing locally", async () => {
  await withRepos(SINGLE_PHASE, async (repos) => {
    await publishFromB(repos);
    const before = await snapshotTree(repos.repoA);
    const from = repos.remote.ops().length;

    const injected = new Error("injected pull failure");
    repos.remote.failNext("pull", injected, { instance: "A" });
    const thrown = await assertRejects(
      () =>
        requireInitializedRepo({ repoDir: repos.repoA, outputMode: "json" }),
      Error,
    );
    assertEquals(
      thrown.message,
      `${typeName(repos)} pull failed: injected pull failure`,
    );
    assertEquals(thrown.cause, injected);
    // Unlike acquireModelLocks, the coordinator unwinds its own entry.
    assertEquals(getRegisteredLockKeys(), []);
    assertEquals(await snapshotTree(repos.repoA), before);
    assertEquals(
      repos.remote.ops().slice(from).filter((op) => op.instance === "A"),
      [],
    );
  });
});

// --- Offline for a sequence of writes ----------------------------------

/**
 * One flush path: `begin` opens a unit of work (online), `write` and
 * `remove` change data through it, `flush` ends it. `failFlush` runs a
 * flush that fails with `message` and checks how the failure surfaced.
 */
interface FlushPath {
  /** The function under test, for the test name. */
  fn: "acquireModelLocks" | "flushDatastoreSync";
  variant: string;
  options: RowRepoOptions;
  begin: (repos: RowRepos, model: Definition) => Promise<{
    write: (dataName: string) => Promise<unknown>;
    remove: (dataName: string) => Promise<void>;
    flush: () => Promise<void>;
  }>;
  /** The push-side ops of one successful flush. */
  pushOps: string[];
  /** The remote op an offline flush fails on. */
  offlineOp: string;
  failFlush: (
    repos: RowRepos,
    flush: () => Promise<void>,
    message: string,
  ) => Promise<void>;
}

const OFFLINE_ERROR = "in-memory remote is offline";

function perModelPath(
  variant: string,
  options: RowRepoOptions,
  offlineOp: string,
  pushOps: string[],
): FlushPath {
  return {
    fn: "acquireModelLocks",
    variant,
    options,
    begin: async (repos, model) => {
      const locks = await lockOnA(repos, model);
      return {
        write: (dataName) => writeData(repos, model, dataName),
        remove: (dataName) =>
          repos.a.repoContext.unifiedDataRepo.delete(
            repos.modelType,
            model.id,
            dataName,
          ),
        flush: locks.flush,
      };
    },
    pushOps,
    offlineOp,
    failFlush: async (repos, flush, message) => {
      const thrown = await assertRejects(flush, Error);
      assertEquals(
        thrown.message,
        `${typeName(repos)} push failed: ${message}`,
      );
      assertEquals(getRegisteredLockKeys(), []);
    },
  };
}

const FLUSH_PATHS: FlushPath[] = [
  perModelPath("single-phase", SINGLE_PHASE, "push", ["push"]),
  perModelPath("two-phase", TWO_PHASE, "prepare", ["prepare", "commit"]),
  {
    fn: "flushDatastoreSync",
    variant: "single-phase",
    options: SINGLE_PHASE,
    begin: async (repos, model) => {
      const ctx = await requireInitializedRepo({
        repoDir: repos.repoA,
        outputMode: "json",
      });
      return {
        write: (dataName) => writeData(repos, model, dataName, ctx.repoContext),
        remove: (dataName) =>
          ctx.repoContext.unifiedDataRepo.delete(
            repos.modelType,
            model.id,
            dataName,
          ),
        // Ends the unit: flushes, then closes the context's catalog.
        flush: async () => {
          try {
            await flushDatastoreSync();
          } finally {
            ctx.repoContext.catalogStore.close();
          }
        },
      };
    },
    pushOps: ["push"],
    offlineOp: "push",
    failFlush: async (repos, flush, message) => {
      const logs = await captureDatastoreLogs(flush);
      assertEquals(logs.map(renderRecord), [
        `${typeName(repos)} push failed: ${message}`,
      ]);
      assertEquals(getRegisteredLockKeys(), []);
    },
  },
];

for (const path of FLUSH_PATHS) {
  Deno.test(`${path.fn}: ${path.variant} writes made while the remote is offline all publish on the first flush back online`, async () => {
    await withRepos(path.options, async (repos) => {
      const model = await saveModel(repos.serveRepo, "writer");
      const names = ["first", "second", "third"];

      const unit = await path.begin(repos, model);
      repos.remote.offline(true);
      for (const dataName of names) await unit.write(dataName);
      await path.failFlush(
        repos,
        unit.flush,
        `${OFFLINE_ERROR} (${path.offlineOp})`,
      );
      repos.remote.offline(false);

      const written = await localFilesOf(repos, model);
      assertEquals(await dirtyOnA(repos), [...written.keys()]);
      assertEquals(remoteKeysOf(repos, model), []);

      const retryFrom = repos.remote.ops().length;
      const retry = await path.begin(repos, model);
      await retry.flush();
      assertEquals(pushOpsSince(repos, retryFrom), path.pushOps);
      assertEquals(remoteKeysOf(repos, model), [...written.keys()]);
      for (const dataName of names) {
        assertEquals(await readOnB(repos, model, dataName), {
          content: savedContent(dataName),
          versions: [1],
        });
      }
    });
  });
}

Deno.test("pushManagedConfigChanges: definitions saved while the remote is offline all publish on the first push back online", async () => {
  await withRepos({ managedConfig: true }, async (repos) => {
    const push = () =>
      pushManagedConfigChanges(
        repos.a.syncService,
        repos.a.datastoreConfig,
        repos.a.marker,
      );
    repos.remote.offline(true);
    const models: Definition[] = [];
    for (const name of ["first", "second", "third"]) {
      models.push(await saveModel(repos.serveRepo, name));
    }
    const thrown = await assertRejects(push, ManagedConfigUnpublishedError);
    assertEquals(thrown.code, "managed_config_unpublished");
    assertInstanceOf(thrown.cause, Error);
    assertEquals(thrown.cause.message, `${OFFLINE_ERROR} (push)`);
    repos.remote.offline(false);

    const dirty = await dirtyOnA(repos);
    for (const model of models) {
      for (const rel of (await localFilesOf(repos, model)).keys()) {
        assert(dirty.includes(rel), `${rel} still dirty`);
        assertEquals(repos.remote.files().get(rel), undefined);
      }
    }

    const retryFrom = repos.remote.ops().length;
    await push();
    assertEquals(pushOpsSince(repos, retryFrom), ["push"]);
    for (const model of models) {
      const local = await localFilesOf(repos, model);
      assert(local.size > 0);
      for (const [rel, bytes] of local) {
        assertEquals(repos.remote.files().get(rel), bytes);
      }
    }
  });
});

// --- A pull after a failed push: data loss up to 2026.09.24.1 ------------
//
// `@swamp/s3-datastore` and `@swamp/gcs-datastore` up to 2026.09.24.1 mark
// the cache clean on an unscoped pull of a moved remote, dropping a pending
// push (S3SYNC:2742, 2759 in
// datastore/s3/extensions/datastores/_lib/s3_cache_sync.ts at
// swamp-extensions 5368cb002; GCS behaves the same). swamp-club#2888
// (swamp-extensions 5e8630189, released in 2026.10.01.1) fixed it: a pull
// never marks the cache clean, so the next push sends the failed push's
// write. The fake models the old behaviour as `pullClearsPendingPush`, still
// on by default; swamp-club#2906 will update the fake's defaults. Each test
// below pins one version.

/**
 * A's write fails to push, then B commits so the remote moves past what A
 * last pulled, then A acquires the lock again (an unscoped pull) and
 * flushes. Returns A's written files and where the op log stood before the
 * retry.
 */
async function failedPushThenPeerCommit(
  repos: RowRepos,
  model: Definition,
): Promise<{ written: Map<string, Uint8Array>; retryFrom: number }> {
  const locks = await lockOnA(repos, model);
  await writeData(repos, model, "item");
  const written = await localFilesOf(repos, model);
  repos.remote.failNext("push", new Error("injected push failure"), {
    instance: "A",
  });
  await assertRejects(() => locks.flush(), Error, "push failed");
  assertEquals(await dirtyOnA(repos), [...written.keys()]);

  await publishFromB(repos);

  const retryFrom = repos.remote.ops().length;
  const retry = await lockOnA(repos, model);
  await retry.flush();
  return { written, retryFrom };
}

/** The paths A's one push since `from` uploaded. */
function retryPushPaths(repos: RowRepos, from: number): string[] | undefined {
  return repos.remote.ops().slice(from).find((op) =>
    op.instance === "A" && op.op === "push"
  )?.paths;
}

Deno.test("acquireModelLocks: with extensions up to 2026.09.24.1, a pull after a peer's commit drops A's pending write from a failed push (pinned data loss)", async () => {
  // The fake's default semantics model extensions <= 2026.09.24.1.
  await withRepos(SINGLE_PHASE, async (repos) => {
    const model = await saveModel(repos.serveRepo, "writer");
    const { written, retryFrom } = await failedPushThenPeerCommit(
      repos,
      model,
    );

    // KNOWN BUG in extensions <= 2026.09.24.1, fixed in 2026.10.01.1 by
    // swamp-club#2888: the retry's lock acquire pulled the moved remote and
    // marked A's cache clean. The write stays on disk but never reaches the
    // remote. swamp-club#2906 will move the fake's defaults to the fixed
    // behaviour, which flips these assertions.
    assertEquals(await localFilesOf(repos, model), written);
    assertEquals(await dirtyOnA(repos), []);
    assertEquals(pushOpsSince(repos, retryFrom), ["push"]);
    assertEquals(
      retryPushPaths(repos, retryFrom),
      [],
      "the retry push took the fast path",
    );
    assertEquals(remoteKeysOf(repos, model), []);
    assertEquals(await readOnB(repos, model, "item"), {
      content: null,
      versions: [],
    });
  });
});

Deno.test("acquireModelLocks: with extensions from 2026.10.01.1 (swamp-club#2888), a pull after a peer's commit keeps A's pending write and the retry publishes it", async () => {
  await withRepos({
    remote: {
      capabilities: {},
      semantics: {
        ...LEGACY_EXTENSION_SEMANTICS,
        pullClearsPendingPush: false,
      },
    },
  }, async (repos) => {
    const model = await saveModel(repos.serveRepo, "writer");
    const { written, retryFrom } = await failedPushThenPeerCommit(
      repos,
      model,
    );

    // The pull left A's cache dirty, so the retry push sent the write.
    assertEquals(await localFilesOf(repos, model), written);
    assertEquals(pushOpsSince(repos, retryFrom), ["push"]);
    assertEquals(retryPushPaths(repos, retryFrom), [...written.keys()]);
    assertEquals(await dirtyOnA(repos), []);
    assertEquals(remoteKeysOf(repos, model), [...written.keys()]);
    for (const [rel, bytes] of written) {
      assertEquals(repos.remote.files().get(rel), bytes);
    }
    assertEquals(await readOnB(repos, model, "item"), {
      content: savedContent("item"),
      versions: [1],
    });
  });
});

// --- A push that fails after its uploads loses the recorded deletes ------

for (const path of FLUSH_PATHS.filter((p) => p.offlineOp === "push")) {
  Deno.test(`${path.fn}: a ${path.variant} push failing after its uploads publishes the write on retry but loses the recorded delete (pinned)`, async () => {
    await withRepos(path.options, async (repos) => {
      const model = await saveModel(repos.serveRepo, "writer");
      const first = await path.begin(repos, model);
      await first.write("gone");
      await first.flush();
      const goneKeys = remoteKeysOf(repos, model);
      assert(goneKeys.length > 0, "the first flush published 'gone'");

      // One cycle: write "kept" and delete the published "gone".
      const unit = await path.begin(repos, model);
      await unit.write("kept");
      await unit.remove("gone");
      const kept = await localFilesOf(repos, model);
      assert(kept.size > 0, "the save wrote files into A's cache");
      assert(
        goneKeys.every((key) => !kept.has(key)),
        "'gone' is gone locally",
      );
      const before = await repos.remote.pendingPush(cacheDir(repos.repoA));
      assertEquals(before.bulk, false);
      assertEquals(before.uploads, [...kept.keys()]);
      assertEquals(before.deletes, goneKeys, "the delete is recorded");

      repos.remote.failNext("push", new Error("injected push failure"), {
        instance: "A",
        afterUploads: true,
      });
      await path.failFlush(repos, unit.flush, "injected push failure");

      // The uploads landed as objects but nothing was committed: the remote
      // still serves "gone" and not "kept". Each upload's bare mark set the
      // bulk flag (S3SYNC:2822), and a bulk push deletes nothing
      // (S3SYNC:3095-3165), so the recorded delete is already lost. Still
      // true in extensions 2026.10.01.1; filed as swamp-club#2907.
      assertEquals(remoteKeysOf(repos, model), goneKeys);
      const after = await repos.remote.pendingPush(cacheDir(repos.repoA));
      assertEquals(after.bulk, true);
      assertEquals(after.uploads, [...kept.keys()]);
      assertEquals(after.deletes, [], "the recorded delete is lost");

      // KNOWN GAP, pinned: the retry's full walk publishes the write but
      // never deletes "gone" remotely.
      const retryFrom = repos.remote.ops().length;
      const retry = await path.begin(repos, model);
      await retry.flush();
      assertEquals(pushOpsSince(repos, retryFrom), path.pushOps);
      assertEquals(await dirtyOnA(repos), []);
      assertEquals(
        remoteKeysOf(repos, model),
        [...goneKeys, ...kept.keys()].sort(),
      );
      for (const [rel, bytes] of kept) {
        assertEquals(repos.remote.files().get(rel), bytes);
      }

      // B reads the write, and still reads the item A deleted.
      assertEquals(await readOnB(repos, model, "kept"), {
        content: savedContent("kept"),
        versions: [1],
      });
      assertEquals(await readOnB(repos, model, "gone"), {
        content: savedContent("gone"),
        versions: [1],
      });
    });
  });
}

// --- CLI token commands: a failed mid-command push ----------------------
//
// Access token mint and worker token create and revoke push mid-command,
// before the read-back (swamp-club#3053 moves that push onto the root's
// checkpoint). Recorded before the move: the injected error reaches the
// caller unchanged, so the command exits as it did, and the root's
// end-of-command lock push and release behave as before. A first mint or
// create holds no model lock (its pull and release are the token's name
// lock), so nothing pushes after the failure and the writes stay dirty.
// Revoke holds the token's model lock, whose push publishes them.

/** A's dirty paths with model ids and timestamps replaced. */
async function dirtyShapeOnA(repos: RowRepos): Promise<string[]> {
  return (await dirtyOnA(repos)).map((path) =>
    path
      .replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
        "<id>",
      )
      .replace(/\d{4}-\d{2}-\d{2}T[\d-]+Z/g, "<time>")
  );
}

/** The dirty shape a first mint of `kind/name` leaves behind. */
function mintedTokenShape(kind: string, name: string): string[] {
  const data = `data/swamp/${kind}/<id>`;
  return [
    `auto-definitions/swamp/${kind}/${name}.yaml`,
    ...[
      "report-swamp-method-summary-json",
      "report-swamp-method-summary",
      "token-main",
    ]
      .flatMap((item) => [
        `${data}/${item}/1/metadata.yaml`,
        `${data}/${item}/1/raw`,
        `${data}/${item}/latest`,
      ]),
    `definitions-evaluated/swamp/${kind}/${name}.yaml`,
    `outputs/swamp/${kind}/mint/<id>-<time>.yaml`,
  ];
}

/** Fails A's next push, runs the command, and returns the error it threw. */
function runWithFailedPush(
  repos: RowRepos,
  args: string[],
): Promise<unknown> {
  repos.remote.failNext("push", new Error("injected push failure"), {
    instance: "A",
  });
  return runCliRejecting({
    args: [...args, "--repo-dir", repos.repoA, "--json"],
  });
}

/** The error a failed push throws: the remote's own, not a UserError. */
function assertInjectedPushError(error: unknown): void {
  assertInstanceOf(error, Error);
  assert(!(error instanceof UserError), "not a UserError");
  assertEquals(error.message, "injected push failure");
}

Deno.test("access token mint: a failed mid-command push throws the push error, pushes nothing more, and keeps the token dirty (swamp-club#3053)", async () => {
  await withRepos(SINGLE_PHASE, async (repos) => {
    const base = baseline(repos);
    const error = await runWithFailedPush(repos, [
      "access",
      "token",
      "mint",
      "tok1",
      "--principal",
      "user:adam",
    ]);
    assertInjectedPushError(error);
    assertEquals(syncOrder(repos, base), ["pull", "release"]);
    assertEquals(getRegisteredLockKeys(), [], "locks released");
    assertEquals(
      await dirtyShapeOnA(repos),
      mintedTokenShape("server-token", "tok1"),
    );
  });
});

Deno.test("worker token create: a failed mid-command push throws the push error, pushes nothing more, and keeps the token dirty (swamp-club#3053)", async () => {
  await withRepos(SINGLE_PHASE, async (repos) => {
    const base = baseline(repos);
    const error = await runWithFailedPush(repos, [
      "worker",
      "token",
      "create",
      "wt1",
      "--duration",
      "1h",
    ]);
    assertInjectedPushError(error);
    assertEquals(syncOrder(repos, base), []);
    assertEquals(getRegisteredLockKeys(), [], "locks released");
    assertEquals(
      await dirtyShapeOnA(repos),
      mintedTokenShape("enrollment-token", "wt1"),
    );
  });
});

Deno.test("worker token revoke: a failed mid-command push throws the push error, then the lock push publishes and the lock is released (swamp-club#3053)", async () => {
  await withRepos(SINGLE_PHASE, async (repos) => {
    await runCli({
      args: [
        "worker",
        "token",
        "create",
        "wt1",
        "--duration",
        "1h",
        "--repo-dir",
        repos.repoA,
        "--json",
      ],
    });
    await settle(repos);
    const base = baseline(repos);
    const error = await runWithFailedPush(repos, [
      "worker",
      "token",
      "revoke",
      "wt1",
    ]);
    assertInjectedPushError(error);
    assertEquals(syncOrder(repos, base), ["pull", "push", "release"]);
    assertEquals(getRegisteredLockKeys(), [], "locks released");
    assertEquals(await dirtyOnA(repos), []);
  });
});
