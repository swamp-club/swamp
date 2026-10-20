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
 * Two checkouts of one v3 filesystem datastore (swamp-club#3691): the read
 * model never writes another checkout's commit onto this checkout's local
 * tier, never materialises a reserved namespace, and a checkout whose
 * directories changed since it was first projected is refused at open
 * rather than re-projected.
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join, relative, SEPARATOR } from "@std/path";
import { walk } from "@std/fs";
import { z } from "zod";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { VERSION } from "../src/cli/commands/version.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { Data } from "../src/domain/data/data.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { UserError } from "../src/domain/errors.ts";
import { isReservedNamespaceName } from "../src/domain/data/namespace.ts";
import type { FilesystemDatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import { Commit } from "../src/domain/datastore_v3/commit.ts";
import {
  dataKey,
  modelPartition,
  savePut,
  versionOp,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import { flushDatastoreSync } from "../src/infrastructure/persistence/datastore_sync_coordinator.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { initializeV3Datastore } from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import {
  closeV3Datastores,
  holdV3Writer,
  v3DatastoreFor,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { writerMarkerPath } from "../src/infrastructure/datastore_v3/interrupted_writer_recovery.ts";
import {
  READ_MODEL_STATE_DIR,
  v3CatalogPath,
} from "../src/infrastructure/datastore_v3/record_path_guard.ts";
import { readCatalog, sha256Hex } from "./datastore_v3_read_model_helpers.ts";

await initializeLogging({});

/** A pid no process has. */
const GONE_PID = 99_999_999;

type Ctx = Awaited<ReturnType<typeof requireInitializedRepoUnlocked>>;

/** The `datastore:` lines of a v3 filesystem checkout's `.swamp.yaml`. */
function datastoreLines(datastorePath: string, extra: string[]): string {
  return [
    "datastore:",
    "  type: filesystem",
    `  path: ${JSON.stringify(datastorePath)}`,
    "  format: 3",
    ...extra,
  ].join("\n") + "\n";
}

/** `namespace:` and `directories:` config lines. */
function layout(
  namespace: string | undefined,
  directories?: readonly string[],
): string[] {
  return [
    ...(namespace !== undefined ? [`  namespace: ${namespace}`] : []),
    ...(directories !== undefined
      ? ["  directories:", ...directories.map((d) => `    - ${d}`)]
      : []),
  ];
}

async function initRepo(
  repoDir: string,
  datastorePath: string,
  extra: string[],
): Promise<void> {
  await Deno.mkdir(repoDir, { recursive: true });
  const homeDir = join(repoDir, "test-home");
  await new RepoService(VERSION, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  }).init(RepoPath.create(repoDir), { tools: [] });
  const markerPath = join(repoDir, ".swamp.yaml");
  const marker = await Deno.readTextFile(markerPath);
  await Deno.writeTextFile(
    markerPath,
    marker.trimEnd() + "\n" + datastoreLines(datastorePath, extra),
  );
}

/** Replaces the checkout's `datastore:` block. */
async function reconfigure(
  repoDir: string,
  datastorePath: string,
  extra: string[],
): Promise<void> {
  const markerPath = join(repoDir, ".swamp.yaml");
  const marker = await Deno.readTextFile(markerPath);
  const head = marker.slice(0, marker.indexOf("datastore:"));
  await Deno.writeTextFile(
    markerPath,
    head + datastoreLines(datastorePath, extra),
  );
}

async function open(repoDir: string): Promise<Ctx> {
  return await requireInitializedRepoUnlocked({ repoDir, outputMode: "json" });
}

/** Saves `model`'s `state` holding `who`, and a workflow run with `withRun`. */
async function writeState(
  ctx: Ctx,
  modelType: ModelType,
  model: Definition,
  who: string,
  withRun = false,
): Promise<void> {
  await runInRootUnitOfWork(ctx.repoContext, { flush: undefined }, async () => {
    await ctx.repoContext.definitionRepo.save(modelType, model);
    const data = Data.create({
      name: "state",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", modelName: model.name },
      ownerDefinition: {
        ownerType: "model-method",
        ownerRef: `${modelType.normalized}:${model.id}`,
      },
    });
    await ctx.repoContext.unifiedDataRepo.save(
      modelType,
      model.id,
      data,
      new TextEncoder().encode(JSON.stringify({ who })),
    );
    if (withRun) {
      const wf = Workflow.create({
        name: `wf-${who.toLowerCase()}`,
        jobs: [Job.create({
          name: "main",
          steps: [Step.create({
            name: "noop",
            task: StepTask.modelMethod(model.name, "noop"),
          })],
        })],
      });
      await ctx.repoContext.workflowRepo.save(wf);
      await ctx.repoContext.workflowRunRepo.save(wf.id, WorkflowRun.create(wf));
    }
  });
}

async function deleteState(
  ctx: Ctx,
  modelType: ModelType,
  model: Definition,
): Promise<void> {
  await runInRootUnitOfWork(
    ctx.repoContext,
    { flush: undefined },
    () => ctx.repoContext.unifiedDataRepo.delete(modelType, model.id, "state"),
  );
}

/** Who the checkout's latest `state` of `model` names, if any. */
async function latestWho(
  ctx: Ctx,
  modelType: ModelType,
  model: Definition,
): Promise<string | undefined> {
  const repo = ctx.repoContext.unifiedDataRepo;
  if (await repo.findByName(modelType, model.id, "state") === null) {
    return undefined;
  }
  const bytes = await repo.getContent(modelType, model.id, "state");
  return bytes === null
    ? undefined
    : JSON.parse(new TextDecoder().decode(bytes)).who;
}

/**
 * Every file under `dir` by forward-slash path, with its digest; the read
 * model's own state directory left out, since opening it may touch its
 * SQLite sidecars.
 */
async function snapshot(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  try {
    for await (const entry of walk(dir, { includeDirs: false })) {
      const rel = relative(dir, entry.path).split(SEPARATOR).join("/");
      if (rel.split("/").includes(READ_MODEL_STATE_DIR)) continue;
      files.set(rel, await sha256Hex(await Deno.readFile(entry.path)));
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return new Map([...files].sort(([a], [b]) => (a < b ? -1 : 1)));
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

interface Pair {
  readonly datastorePath: string;
  readonly repoA: string;
  readonly repoB: string;
  readonly modelType: ModelType;
  readonly model: Definition;
}

/**
 * Runs `fn` against a fresh v3 filesystem datastore and two checkouts of it
 * whose `datastore:` blocks add `aExtra` and `bExtra`.
 */
async function withPair(
  aExtra: string[],
  bExtra: string[],
  fn: (pair: Pair) => Promise<void>,
): Promise<void> {
  const modelType = ModelType.create(
    `test/local-tier-${crypto.randomUUID().slice(0, 8)}`,
  );
  modelRegistry.register({
    type: modelType,
    version: "2026.01.01.1",
    methods: {
      noop: {
        description: "does nothing",
        kind: "read",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
  });
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp-v3-local-tier-" }),
  );
  try {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const repoA = join(dir, "a");
    const repoB = join(dir, "b");
    await initRepo(repoA, datastorePath, aExtra);
    await initRepo(repoB, datastorePath, bExtra);
    const model = Definition.create({ name: "m1", globalArguments: {} });
    await fn({ datastorePath, repoA, repoB, modelType, model });
  } finally {
    await closeV3Datastores();
    await flushDatastoreSync();
    modelRegistry.invalidateType(modelType);
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/**
 * B writes local-only data; A, whose commits B's cache root shares with
 * B's local tier, commits the same model's data and a run (and with
 * `compact`, compacts history so B loads the compacted base). B's local
 * files stay byte for byte, it reads its own data, and sees no run of A's.
 */
async function assertLocalTierKept(
  pair: Pair,
  options: { readonly compact?: boolean } = {},
): Promise<void> {
  const { repoA, repoB, modelType, model } = pair;
  const b = await open(repoB);
  await writeState(b, modelType, model, "B-local");
  assertEquals(await latestWho(b, modelType, model), "B-local");
  await closeV3Datastores();
  const rows = readCatalog(v3CatalogPath(repoB));
  const local = await snapshot(join(swampPath(repoB), "data"));
  assert(local.size > 0, "B holds local-only data files");

  const a = await open(repoA);
  await writeState(a, modelType, model, "A-committed", true);
  if (options.compact) {
    const store = v3DatastoreFor(repoA, aConfig(a)).commitStore;
    await store.compactHistory(Number.MAX_SAFE_INTEGER, {
      ...(store.writerFence() !== undefined
        ? { fence: store.writerFence()! }
        : {}),
    });
  }
  await closeV3Datastores();

  const reopened = await open(repoB);
  assertEquals(
    await snapshot(join(swampPath(repoB), "data")),
    local,
    "B's local-only files are untouched",
  );
  assertEquals(await latestWho(reopened, modelType, model), "B-local");
  assertEquals(
    readCatalog(v3CatalogPath(repoB)),
    rows,
    "B's catalog holds its own local rows only, none of the other checkout's",
  );
  assertEquals(
    (await reopened.repoContext.workflowRunRepo.findAllGlobal()).length,
    0,
    "B ran nothing, so it sees no run",
  );
  await closeV3Datastores();
}

function aConfig(ctx: Ctx): FilesystemDatastoreConfig {
  const config = ctx.datastoreConfig;
  if (!("path" in config) || config.type !== "filesystem") {
    throw new Error("a filesystem datastore");
  }
  return config as FilesystemDatastoreConfig;
}

Deno.test("v3 local tier: a namespaced checkout keeps its local-only data beside a solo checkout's commit (swamp-club#3691)", async () => {
  await withPair(
    [],
    layout("alpha", ["config"]),
    (pair) => assertLocalTierKept(pair),
  );
});

Deno.test("v3 local tier: a namespaced checkout keeps its local-only data when it loads a compacted base holding a solo commit (swamp-club#3691)", async () => {
  await withPair(
    [],
    layout("alpha", ["config"]),
    (pair) => assertLocalTierKept(pair, { compact: true }),
  );
});

Deno.test("v3 local tier: two checkouts of one namespace with different directories keep each other's commits off the local tier (swamp-club#3691)", async () => {
  await withPair(
    layout("alpha"),
    layout("alpha", ["config"]),
    (pair) => assertLocalTierKept(pair),
  );
});

Deno.test("v3 local tier: a solo checkout with fewer directories keeps its local-only data and rows, even when the other checkout deletes the name (swamp-club#3691)", async () => {
  await withPair([], layout(undefined, ["config"]), async (pair) => {
    await assertLocalTierKept(pair);
    const { repoA, repoB, modelType, model } = pair;
    const local = await snapshot(join(swampPath(repoB), "data"));
    const a = await open(repoA);
    await deleteState(a, modelType, model);
    assertEquals(await latestWho(a, modelType, model), undefined);
    await closeV3Datastores();
    const b = await open(repoB);
    assertEquals(
      await latestWho(b, modelType, model),
      "B-local",
      "the other checkout's delete leaves B's local row",
    );
    assertEquals(await snapshot(join(swampPath(repoB), "data")), local);
    await closeV3Datastores();
  });
});

/** Reserved names whose commits a checkout must never materialise. */
const RESERVED_UNDER_TEST = ["data", "vault", "datastore-bundles"];

Deno.test("v3 reserved namespaces: a reserved namespace's commits never reach a checkout's .swamp/<name>, and a solo recovery removes nothing (swamp-club#3691)", async () => {
  assert(RESERVED_UNDER_TEST.every(isReservedNamespaceName));
  await withPair(layout("prod"), [], async (pair) => {
    const { datastorePath, repoA, repoB } = pair;
    const prod = await open(repoA);
    const handle = v3DatastoreFor(repoA, aConfig(prod));
    const before = new Map<string, Map<string, string>>();
    for (const name of RESERVED_UNDER_TEST) {
      before.set(name, await snapshot(join(swampPath(repoA), name)));
      // An older swamp, or another checkout, committed under the name.
      const fence = handle.commitStore.writerFence();
      await handle.commitStore.append(Commit.create({
        seq: 1,
        partition: modelPartition(),
        namespace: name,
        txnId: `txn-${crypto.randomUUID()}`,
        writer: { host: "host-old", pid: GONE_PID, instance: "old-swamp" },
        at: new Date().toISOString(),
        ...(fence !== undefined ? { fence } : {}),
        ops: [await savePut("a", 1), versionOp("a", 1)],
      }));
    }
    await handle.catchUp();
    for (const name of RESERVED_UNDER_TEST) {
      assertEquals(
        await snapshot(join(swampPath(repoA), name)),
        before.get(name),
        `.swamp/${name} is untouched in the prod checkout`,
      );
    }
    const rows = readCatalog(v3CatalogPath(repoA)).rows;
    assertEquals(
      rows.filter((row) =>
        RESERVED_UNDER_TEST.includes(row.namespace as string)
      ),
      [],
      "no catalog row of a reserved namespace",
    );
    // The records stay indexed: chunks and history stay whole.
    assertEquals(
      (await handle.readModel.liveRecords("data", modelPartition())).map((
        record,
      ) => record.key.toString()),
      [dataKey("a", 1).toString()],
    );
    await closeV3Datastores();

    // A solo checkout sweeps .swamp/data, which the namespace "data"'s
    // cache root aliases: nothing of it is there to remove.
    const soloConfig: FilesystemDatastoreConfig = {
      type: "filesystem",
      path: datastorePath,
      format: 3,
    };
    const solo = v3DatastoreFor(repoB, soloConfig);
    const since = Date.now() - 60_000;
    await solo.catchUp();
    assertEquals(await solo.recoverInterruptedWriter(since), []);
    assertEquals(await exists(join(swampPath(repoB), "data", "data")), false);
  });
});

Deno.test("v3 changed directories: a checkout whose directories changed since it was projected is refused at open, touching nothing (swamp-club#3691)", async () => {
  await withPair([], layout(undefined, ["config", "data"]), async (pair) => {
    const { datastorePath, repoA, repoB, modelType, model } = pair;
    const projected = ["config", "data"];
    const a = await open(repoA);
    await writeState(a, modelType, model, "A-1");
    await closeV3Datastores();
    const b = await open(repoB);
    assertEquals(await latestWho(b, modelType, model), "A-1");
    await closeV3Datastores();

    // A commits again; B's config now leaves data out.
    const a2 = await open(repoA);
    await writeState(a2, modelType, model, "A-2");
    await closeV3Datastores();
    await reconfigure(repoB, datastorePath, layout(undefined, ["config"]));
    const files = await snapshot(swampPath(repoB));
    const catalog = readCatalog(v3CatalogPath(repoB));
    const narrowed: FilesystemDatastoreConfig = {
      type: "filesystem",
      path: datastorePath,
      format: 3,
      directories: ["config"],
    };
    const assertUntouched = (label: string) =>
      (async () => {
        assertEquals(await snapshot(swampPath(repoB)), files, label);
        assertEquals(readCatalog(v3CatalogPath(repoB)), catalog, label);
      })();

    // Any command.
    await assertRejects(() => open(repoB), UserError, "directories");
    await assertUntouched("a refused command touches nothing");

    // A writer marker present: the recovery would run before catch-up.
    await Deno.writeTextFile(
      writerMarkerPath(repoB),
      JSON.stringify({
        hostname: Deno.hostname(),
        pid: GONE_PID,
        since: Date.now() - 60_000,
      }),
    );
    await assertRejects(
      () => holdV3Writer(narrowed, repoB),
      UserError,
      "directories",
    );
    await assertUntouched("a refused recovery touches nothing");
    await closeV3Datastores();

    // A direct caller (gc, status, serve's maintenance, admin, retention).
    assertThrows(() => v3DatastoreFor(repoB, narrowed), UserError);
    await assertUntouched("a refused direct open touches nothing");
    await Deno.remove(writerMarkerPath(repoB));

    // The previous directories restored, the checkout opens and catches up.
    await reconfigure(repoB, datastorePath, layout(undefined, projected));
    const restored = await open(repoB);
    assertEquals(await latestWho(restored, modelType, model), "A-2");
    await closeV3Datastores();
  });
});
