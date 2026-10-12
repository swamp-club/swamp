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
 * The v3 gate over the use-case sync characterization rows (swamp-club#3279).
 *
 * Each row's CLI and serve composition runs against a checkout of a v3
 * filesystem datastore, through the production entry points
 * (`requireInitializedRepo*`, `runCommandInRootUnit`, serve's handlers). A
 * second checkout of the same datastore then catches up from the commit
 * log, and its datastore records and catalog must equal the writer's.
 * Local-only files (run logs, the run index, the stream directories) are
 * left out by an explicit list.
 */

import { AsyncResource } from "node:async_hooks";
import { join, relative, SEPARATOR } from "@std/path";
import { walk } from "@std/fs";
import { assert, assertEquals } from "@std/assert";
import { z } from "zod";
import { createInMemoryRemote } from "@swamp-club/swamp-testing";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { VERSION } from "../src/cli/commands/version.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { isCustomDatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { flushDatastoreSync } from "../src/infrastructure/persistence/datastore_sync_coordinator.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { RUNS_INDEX_FILENAME } from "../src/infrastructure/persistence/workflow_run_index.ts";
import {
  MATERIALISED_SUBDIRS,
  REPO_LOCAL_STREAM_SUBDIRS,
  v3CatalogPath,
} from "../src/infrastructure/datastore_v3/record_path_guard.ts";
import {
  initializeV3Datastore,
  openV3Datastore,
} from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import {
  closeV3Datastores,
  v3DatastoreFor,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import { readCatalog } from "./datastore_v3_read_model_helpers.ts";
import {
  type AnyRow,
  type Composition,
  type RowRepos,
  runCli,
  runServe,
  serveCtx,
  UNSET_ENV,
  withOutsideSeedRoot,
} from "./usecase_sync_fixtures.ts";

/** Options for {@link withV3RowRepos}. */
export interface V3RowRepoOptions {
  /** Add `managedConfig: true` under the repos' `datastore:` block. */
  managedConfig?: boolean;
  /** The datastore namespace both checkouts use; solo when absent. */
  namespace?: string;
}

async function initV3Repo(
  repoDir: string,
  datastorePath: string,
  options: V3RowRepoOptions,
): Promise<void> {
  await Deno.mkdir(repoDir, { recursive: true });
  const homeDir = join(repoDir, "test-home");
  await new RepoService(VERSION, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  }).init(RepoPath.create(repoDir), { tools: [] });
  const markerPath = join(repoDir, ".swamp.yaml");
  const marker = await Deno.readTextFile(markerPath);
  const lines = [
    "datastore:",
    "  type: filesystem",
    `  path: ${JSON.stringify(datastorePath)}`,
    "  format: 3",
    ...(options.namespace ? [`  namespace: ${options.namespace}`] : []),
    ...(options.managedConfig ? ["  managedConfig: true"] : []),
  ];
  await Deno.writeTextFile(
    markerPath,
    marker.trimEnd() + "\n" + lines.join("\n") + "\n",
  );
}

/**
 * Runs `fn` against a fresh v3 datastore and two checkouts of it, A (the
 * writer, open as serve and the CLI open it) and B. Everything is closed and
 * removed in a `finally`.
 */
export async function withV3RowRepos(
  options: V3RowRepoOptions,
  fn: (repos: RowRepos, datastorePath: string) => Promise<void>,
): Promise<void> {
  const modelType = ModelType.create(
    `test/usecase-${crypto.randomUUID().slice(0, 8)}`,
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
      touch: {
        description: "an update that writes nothing",
        kind: "update",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
  });
  const dir = await Deno.makeTempDir({ prefix: "swamp-usecase-v3-" });
  try {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const repoA = join(dir, "a");
    const repoB = join(dir, "b");
    await initV3Repo(repoA, datastorePath, options);
    await initV3Repo(repoB, datastorePath, options);
    const a = await requireInitializedRepoUnlocked({
      repoDir: repoA,
      outputMode: "json",
    });
    await fn({
      remote: createInMemoryRemote(),
      repoA,
      repoB,
      modelType,
      a,
      serveRepo: {
        repoDir: a.repoDir,
        repoContext: a.repoContext,
        datastoreConfig: a.datastoreConfig,
        datastoreResolver: a
          .datastoreResolver as ConnectionContext["datastoreResolver"],
        modelType,
      },
      releases: [],
    }, datastorePath);
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
 * Whether a checkout file is local to the checkout that wrote it, never a
 * commit: the run index the run repository rebuilds on read, and run logs.
 * The stream directories are outside {@link MATERIALISED_SUBDIRS} already.
 */
export function isCheckoutLocal(rel: string): boolean {
  const name = rel.split("/").at(-1) ?? "";
  return name === RUNS_INDEX_FILENAME || name.endsWith(".log") ||
    /^_catalog\.db(-journal|-wal|-shm)?$/.test(name);
}

/** Every datastore record file a checkout holds, by path, with its digest. */
export async function datastoreRecords(
  repoDir: string,
  namespace = "",
): Promise<Map<string, string>> {
  const root = namespace === ""
    ? swampPath(repoDir)
    : swampPath(repoDir, namespace);
  const files = new Map<string, string>();
  for (const subdir of MATERIALISED_SUBDIRS) {
    try {
      for await (
        const entry of walk(join(root, subdir), { includeDirs: false })
      ) {
        const rel = relative(root, entry.path).split(SEPARATOR).join("/");
        if (isCheckoutLocal(rel)) continue;
        const bytes = await Deno.readFile(entry.path);
        const digest = new Uint8Array(
          await crypto.subtle.digest("SHA-256", bytes),
        );
        files.set(
          rel,
          [...digest].map((b) => b.toString(16).padStart(2, "0")).join(""),
        );
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return new Map([...files].sort(([x], [y]) => (x < y ? -1 : 1)));
}

/**
 * Catches B up from the commit log and asserts it holds the same datastore
 * records and catalog rows as A, the writer, caught up too.
 */
export async function assertCheckoutsAgree(
  repos: RowRepos,
  datastorePath: string,
  label: string,
  namespace = "",
): Promise<number> {
  const config = repos.a.datastoreConfig;
  if (isCustomDatastoreConfig(config)) {
    throw new Error("a v3 row runs on a filesystem datastore");
  }
  const writerHandle = v3DatastoreFor(repos.repoA, config);
  await writerHandle.catchUp();
  // The stream directories stay in the checkout that wrote them: no commit
  // may name one (swamp-club#3278).
  for (
    const change of await writerHandle.commitStore.changesSince(0, 100_000)
  ) {
    for (const op of change.commit.ops) {
      if (!("key" in op)) continue;
      const first = op.key.toString().split("/")[0];
      assert(
        !(REPO_LOCAL_STREAM_SUBDIRS as readonly string[]).includes(first),
        `${label}: a commit names the stream directory file ${op.key}`,
      );
    }
  }
  const b = openV3Datastore({
    repoDir: repos.repoB,
    datastorePath,
    namespace,
  });
  try {
    await b.catchUp();
  } finally {
    await b.close();
  }
  const writer = await datastoreRecords(repos.repoA, namespace);
  assertEquals(
    await datastoreRecords(repos.repoB, namespace),
    writer,
    `${label}: the second checkout's records differ from the writer's`,
  );
  assertEquals(
    readCatalog(v3CatalogPath(repos.repoB)),
    readCatalog(v3CatalogPath(repos.repoA)),
    `${label}: the second checkout's catalog differs from the writer's`,
  );
  return writer.size;
}

/**
 * Runs one row through one composition on v3, then checks the second
 * checkout. The seed runs in a commit-log root of its own, as a v3 write
 * must; a refusing row must still refuse.
 */
export async function runRowOnV3(
  row: AnyRow,
  composition: Composition,
  options: V3RowRepoOptions = {},
): Promise<number> {
  let records = 0;
  await withV3RowRepos({
    ...(row.options?.managedConfig ? { managedConfig: true } : {}),
    ...options,
  }, async (repos, datastorePath) => {
    // The seed's direct writes need a root on v3; its own CLI and serve
    // calls run outside it, as a command or request does in production.
    const outside = AsyncResource.bind(
      <T>(fn: () => Promise<T>): Promise<T> => fn(),
    ) as <T>(fn: () => Promise<T>) => Promise<T>;
    const seed = row.seed
      ? await withOutsideSeedRoot(outside, () =>
        runInRootUnitOfWork(
          repos.a.repoContext,
          { flush: undefined },
          () => row.seed!(repos, composition),
        ))
      : undefined;
    if (composition === "cli") {
      try {
        await runCli(row.cli!(repos, seed));
      } catch (error) {
        if (!row.refuses) throw error;
      }
    } else {
      await runServe(
        serveCtx(repos, row.serveCtx?.(seed)),
        row.serve!(repos, seed),
      );
    }
    await row.verify?.(repos, seed, composition);
    records = await assertCheckoutsAgree(
      repos,
      datastorePath,
      `${row.name} (${composition})`,
      options.namespace ?? "",
    );
  });
  return records;
}

/**
 * Registers one step per row and composition that runs it on v3. Rows in
 * `skip` are left out, each with the reason it cannot run on v3.
 */
export async function checkRowsOnV3(
  t: Deno.TestContext,
  rows: AnyRow[],
  skip: Record<string, string> = {},
  options: V3RowRepoOptions = {},
): Promise<void> {
  let records = 0;
  for (const row of rows) {
    if (row.name in skip) continue;
    for (const composition of ["cli", "serve"] as const) {
      if (row[composition] === null) continue;
      await t.step(`${row.name} (${composition})`, async () => {
        records += await withMockedEnv(
          UNSET_ENV,
          () => runRowOnV3(row, composition, options),
        );
      });
    }
  }
  // The rows write records the second checkout must match: a table that
  // compared empty trees only would prove nothing.
  assert(records > 0, "no row left a datastore record to compare");
}
