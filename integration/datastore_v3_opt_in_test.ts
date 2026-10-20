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
 * The v3 opt-in (swamp-club#3279): setup, the format guard, the single
 * writer, the refusals and the v2 paths a v3 datastore never takes. The
 * per-use-case gate is in the `usecase_sync_characterization_*_test.ts`
 * files (`usecase_v3_fixtures.ts`).
 */

import "../src/domain/models/models.ts";
import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { walk } from "@std/fs";
import { parse as parseYaml } from "@std/yaml";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { VERSION } from "../src/cli/commands/version.ts";
import {
  requireInitializedRepoReadOnly,
  requireInitializedRepoUnlocked,
  resolveDatastoreForRepo,
} from "../src/cli/repo_context.ts";
import { resolveConfigTierPath } from "../src/cli/resolve_datastore.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import {
  assertSupportedDatastoreFormat,
  UnsupportedDatastoreFormatError,
} from "../src/domain/datastore/datastore_format.ts";
import { readDatastoreFormatKey } from "../src/domain/datastore/datastore_config.ts";
import { UserError } from "../src/domain/errors.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  createDatastoreSetupDeps,
  type DatastoreSetupEvent,
  datastoreSetupFilesystem,
} from "../src/libswamp/datastores/setup.ts";
import { createDatastoreSyncDeps } from "../src/libswamp/datastores/sync.ts";
import { collect } from "../src/libswamp/testing.ts";
import { readDatastoreFormatMarker } from "../src/infrastructure/persistence/datastore_format_marker_reader.ts";
import { plantV3WriterLease } from "../src/infrastructure/datastore_v3/v3_writer_lock_test_helpers.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import {
  initializeV3Datastore,
  openV3Datastore,
  ReadOnlyV3WriteError,
} from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import {
  closeV3Datastores,
  v3DatastoreFor,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import {
  V3WriterBusyError,
} from "../src/infrastructure/datastore_v3/v3_writer_lock.ts";
import {
  createServeCtx,
  saveData,
  saveModel,
  sendRequest,
} from "./serve_request_harness.ts";
import { DatabaseSync } from "node:sqlite";
import { readModelStateDir } from "../src/infrastructure/datastore_v3/record_path_guard.ts";
import { READ_MODEL_STATE_FILE } from "../src/infrastructure/datastore_v3/sqlite_read_model.ts";
import { runCli, runCliRejecting, UNSET_ENV } from "./usecase_sync_fixtures.ts";
import { withV3RowRepos } from "./usecase_v3_fixtures.ts";

await initializeLogging({});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-v3-opt-in-" });
  try {
    await fn(dir);
  } finally {
    await closeV3Datastores();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function initRepo(repoDir: string): Promise<void> {
  await Deno.mkdir(repoDir, { recursive: true });
  const homeDir = join(repoDir, "test-home");
  await new RepoService(VERSION, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  }).init(RepoPath.create(repoDir), { tools: [] });
}

function setupV3(repoDir: string, datastorePath: string) {
  return collect<DatastoreSetupEvent>(
    datastoreSetupFilesystem(
      createLibSwampContext(),
      createDatastoreSetupDeps(repoDir, resolveConfigTierPath, {
        swampVersion: "test-version",
      }),
      {
        datastorePath,
        repoDir,
        skipMigration: false,
        format: 3,
      },
    ),
  );
}

function errorOf(events: DatastoreSetupEvent[]): string | undefined {
  const error = events.find((e) => e.kind === "error");
  return error?.kind === "error" ? error.error.message : undefined;
}

/**
 * What another live process holding the writer lease looks like to this
 * one: a fence held by this process's pid, which is alive.
 */
function holdWriterLockElsewhere(datastorePath: string) {
  return plantV3WriterLease(datastorePath, { pid: Deno.pid });
}

Deno.test("v3 opt-in: setup writes the marker first, then commits.db and _blobs, and the repo opens as v3", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    const datastorePath = join(dir, "datastore");
    await initRepo(repoDir);
    const events = await setupV3(repoDir, datastorePath);
    assertEquals(errorOf(events), undefined);
    const completed = events.at(-1);
    assertEquals(completed?.kind, "completed");
    if (completed?.kind === "completed") assertEquals(completed.data.format, 3);

    const names = [];
    for await (const entry of Deno.readDir(datastorePath)) {
      names.push(entry.name);
    }
    assertEquals(names.sort(), [
      "_blobs",
      "commits.db",
      "datastore-format.json",
    ]);
    const marker = JSON.parse(
      await Deno.readTextFile(join(datastorePath, "datastore-format.json")),
    );
    assertEquals(marker, {
      format: 3,
      minReaderFormat: 3,
      writtenBy: "test-version",
    });
    assertStringIncludes(
      await Deno.readTextFile(join(repoDir, ".swamp.yaml")),
      "format: 3",
    );

    const { engine } = await resolveDatastoreForRepo(repoDir);
    assertEquals(engine, "v3");
    const { repoContext } = await requireInitializedRepoUnlocked({
      repoDir,
      outputMode: "json",
    });
    assert(repoContext.commitLog !== undefined, "the context commits on v3");
  });
});

Deno.test("v3 opt-in: setup refuses a non-empty path, a symlinked path and a repo that holds records", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    await initRepo(repoDir);

    const occupied = join(dir, "occupied");
    await Deno.mkdir(occupied);
    await Deno.writeTextFile(join(occupied, "something"), "x");
    assertStringIncludes(
      errorOf(await setupV3(repoDir, occupied)) ?? "",
      "is not empty",
    );

    if (Deno.build.os !== "windows") {
      const target = join(dir, "target");
      await Deno.mkdir(target);
      const link = join(dir, "link");
      await Deno.symlink(target, link, { type: "dir" });
      assertStringIncludes(
        errorOf(await setupV3(repoDir, link)) ?? "",
        "symbolic link",
      );
    }

    // A record in the repo's own datastore: v3 starts empty.
    const record = swampPath(repoDir, "data", "some", "record.yaml");
    await Deno.mkdir(join(record, ".."), { recursive: true });
    await Deno.writeTextFile(record, "x: 1\n");
    const fresh = join(dir, "fresh");
    assertStringIncludes(
      errorOf(await setupV3(repoDir, fresh)) ?? "",
      "holds records",
    );
    // Nothing was created for the refused setup.
    await assertRejects(() => Deno.stat(fresh), Deno.errors.NotFound);
  });
});

Deno.test("v3 opt-in: format 3 is read for S3, GCS and extension datastores, whose providers are checked where they are built (swamp-club#3534)", () => {
  for (const type of ["s3", "@swamp/s3-datastore", "@swamp/gcs-datastore"]) {
    assertEquals(readDatastoreFormatKey(type, 3), 3);
    assertEquals(readDatastoreFormatKey(type, 2), undefined);
  }
  assertEquals(readDatastoreFormatKey("filesystem", 3), 3);
  const error = (() => {
    try {
      readDatastoreFormatKey("@swamp/s3-datastore", 4);
    } catch (error) {
      return error;
    }
  })();
  assertInstanceOf(error, UserError);
  assertStringIncludes(error.message, "must be 2 or 3");
});

Deno.test("v3 opt-in: a crash before the marker leaves no v3 files", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await Deno.mkdir(join(datastorePath, "datastore-format.json"), {
      recursive: true,
    });
    await assertRejects(() => initializeV3Datastore(datastorePath, "test"));
    const names = [];
    for await (const entry of Deno.readDir(datastorePath)) {
      names.push(entry.name);
    }
    assertEquals(names, ["datastore-format.json"]);
  });
});

Deno.test("v3 opt-in: a binary that reads only format 2 refuses a v3 datastore", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const read = await readDatastoreFormatMarker(dir, {
      type: "filesystem",
      path: datastorePath,
    });
    let refused: unknown;
    try {
      assertSupportedDatastoreFormat(read, [2]);
    } catch (error) {
      refused = error;
    }
    assertInstanceOf(refused, UnsupportedDatastoreFormatError);
  });
});

Deno.test("v3 opt-in: a second writing process is refused, and a reader is not", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const model = await saveSeedModel(repos);
    await runInRootUnitOfWork(
      repos.a.repoContext,
      { flush: undefined },
      () => saveData(repos.serveRepo, model, "seeded"),
    );
    await closeV3Datastores();
    const other = await holdWriterLockElsewhere(datastorePath);
    try {
      await withMockedEnv({ SWAMP_LOCK_TIMEOUT_MS: "200" }, async () => {
        const error = await assertRejects(
          () =>
            requireInitializedRepoUnlocked({
              repoDir: repos.repoB,
              outputMode: "json",
            }),
          V3WriterBusyError,
        );
        assertStringIncludes(error.message, "one writer at a time");
        const reader = await requireInitializedRepoReadOnly({
          repoDir: repos.repoB,
          outputMode: "json",
        });
        assertEquals(
          (await reader.repoContext.dataQueryService.query("true")).length,
          1,
          "the reader sees the writer's committed data",
        );
      });
    } finally {
      await other.release();
    }
  });
});

/** A model saved in A's commit-log root. */
function saveSeedModel(
  repos: Parameters<Parameters<typeof withV3RowRepos>[1]>[0],
) {
  return runInRootUnitOfWork(
    repos.a.repoContext,
    { flush: undefined },
    () => saveModel(repos.serveRepo, "m1"),
  );
}

Deno.test("v3 opt-in: a write outside every root is refused, not left uncommitted", async () => {
  await withV3RowRepos({}, async (repos) => {
    const model = await saveSeedModel(repos);
    await assertRejects(
      () => saveData(repos.serveRepo, model, "outside"),
      Error,
      "outside a unit of work",
    );
  });
});

Deno.test("v3 opt-in: a root that throws commits what it wrote, as v2 publishes it; a success-only root discards it and keeps its local files", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const model = await saveSeedModel(repos);
    const handle = v3DatastoreFor(repos.repoA, {
      type: "filesystem",
      path: datastorePath,
    });
    const commits = async () =>
      (await handle.commitStore.changesSince(0, 10_000)).length;

    const before = await commits();
    await assertRejects(
      () =>
        runInRootUnitOfWork(
          repos.a.repoContext,
          { flush: undefined },
          async () => {
            await saveData(repos.serveRepo, model, "failed-op");
            throw new Error("the operation failed");
          },
        ),
      Error,
      "the operation failed",
    );
    assert(await commits() > before, "the failed operation's write landed");

    const committed = await commits();
    await assertRejects(
      () =>
        runInRootUnitOfWork(repos.a.repoContext, {
          flush: undefined,
          pushWhen: "completed",
        }, async () => {
          await saveData(repos.serveRepo, model, "discarded");
          throw new Error("the operation failed");
        }),
      Error,
      "the operation failed",
    );
    assertEquals(await commits(), committed, "a success-only root discards");
    const local = await repos.a.repoContext.unifiedDataRepo.findByName(
      repos.modelType,
      model.id,
      "discarded",
    );
    assert(local !== null, "the writer's checkout keeps the discarded write");
  });
});

Deno.test("v3 opt-in: a query in a root reads what the root saved before it commits", async () => {
  await withV3RowRepos({}, async (repos) => {
    const model = await saveSeedModel(repos);
    await runInRootUnitOfWork(
      repos.a.repoContext,
      { flush: undefined },
      async () => {
        await saveData(repos.serveRepo, model, "early");
        const found = await repos.a.repoContext.dataQueryService.query(
          'name == "early"',
        );
        assertEquals(found.length, 1);
      },
    );
  });
});

Deno.test("v3 opt-in: a dry-run data gc takes no writer lock", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    await closeV3Datastores();
    const other = await holdWriterLockElsewhere(datastorePath);
    try {
      await withMockedEnv(
        { ...UNSET_ENV, SWAMP_LOCK_TIMEOUT_MS: "200" },
        () =>
          runCli({
            args: [
              "data",
              "gc",
              "--dry-run",
              "--repo-dir",
              repos.repoB,
              "--json",
            ],
          }),
      );
    } finally {
      await other.release();
    }
  });
});

Deno.test("v3 opt-in: every v2 sync path is skipped or refused", async () => {
  await withV3RowRepos({}, async (repos) => {
    // The context syncs nothing: no sync service, so serve builds no sync
    // gate, pollers or config pull, and no push or pull runs at the locks.
    assertEquals(repos.a.syncService, undefined);
    // `datastore sync`.
    const sync = await createDatastoreSyncDeps(
      repos.repoA,
      repos.a.datastoreResolver,
    );
    assertEquals((await sync.validateSyncSupport()).supported, false);
    await withMockedEnv(UNSET_ENV, async () => {
      const json = ["--repo-dir", repos.repoA, "--json"];
      for (
        const [args, expected] of [
          [[
            "datastore",
            "catalog",
            "pull",
            "--namespaces",
            "other",
            ...json,
          ], "remote datastore"],
          [["datastore", "migrate-index", ...json], ""],
          [["datastore", "namespace", "set", "team", ...json], "v3"],
          [["datastore", "namespace", "migrate", "--confirm", ...json], "v3"],
        ] as const
      ) {
        const error = await runCliRejecting({ args: [...args] });
        assertInstanceOf(error, Error, args.join(" "));
        if (expected !== "") {
          assertStringIncludes(
            error.message.toLowerCase(),
            expected.toLowerCase(),
            args.join(" "),
          );
        }
      }
    });
  });
});

Deno.test("v3 opt-in: datastore gc collects on v3, and datastore status reports the commit log", async () => {
  await withV3RowRepos({}, async (repos) => {
    const model = await saveSeedModel(repos);
    await runInRootUnitOfWork(
      repos.a.repoContext,
      { flush: undefined },
      () => saveData(repos.serveRepo, model, "d1"),
    );
    await withMockedEnv(UNSET_ENV, async () => {
      const json = ["--repo-dir", repos.repoA, "--json"];
      const gc = JSON.parse(
        (await runCli({ args: ["datastore", "gc", ...json] })).join("\n"),
      );
      assertEquals(gc.applies, true);
      assert(typeof gc.chunks.scanned === "number");
      const status = JSON.parse(
        (await runCli({ args: ["datastore", "status", ...json] })).join("\n"),
      );
      assertEquals(status.format, 3);
      // The model is git-tracked; its data is the one commit.
      assertEquals(status.commitLog.storedCommits, 1);
      assertEquals(status.commitLog.compactedThrough, 0);
    });
  });
});

/** Every `sha256` an output record's data artifacts carry, in its checkout. */
async function artifactDigests(repoDir: string): Promise<(string | null)[]> {
  const digests: (string | null)[] = [];
  for await (
    const entry of walk(swampPath(repoDir, "outputs"), {
      includeDirs: false,
      exts: [".yaml"],
    })
  ) {
    const record = parseYaml(await Deno.readTextFile(entry.path)) as {
      artifacts?: { dataArtifacts?: { sha256?: string }[] };
    };
    for (const artifact of record.artifacts?.dataArtifacts ?? []) {
      digests.push(artifact.sha256 ?? null);
    }
  }
  return digests;
}

Deno.test("v3 opt-in: a method run's data artifacts record their content's sha256 on v3, and not on v2", async () => {
  const run = async (repoDir: string) => {
    await withMockedEnv(UNSET_ENV, async () => {
      const json = ["--repo-dir", repoDir, "--json"];
      await runCli({
        args: ["model", "create", "command/shell", "hello", ...json],
      });
      await runCli({
        args: [
          "model",
          "method",
          "run",
          "hello",
          "execute",
          "--input",
          "run=echo hi",
          ...json,
        ],
      });
    });
  };
  await withV3RowRepos({}, async (repos) => {
    await run(repos.repoA);
    const digests = await artifactDigests(repos.repoA);
    assert(digests.length > 0, "the run produced data");
    for (const digest of digests) {
      assert(digest !== null && /^[0-9a-f]{64}$/.test(digest), `${digest}`);
    }
  });
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "v2");
    await initRepo(repoDir);
    await run(repoDir);
    const digests = await artifactDigests(repoDir);
    assert(digests.length > 0, "the run produced data");
    assertEquals(digests.filter((d) => d !== null), []);
  });
});

Deno.test("v3 opt-in: a failed method run's record is committed, as v2 publishes it", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    await withMockedEnv(UNSET_ENV, async () => {
      const json = ["--repo-dir", repos.repoA, "--json"];
      await runCli({
        args: ["model", "create", "command/shell", "boom", ...json],
      });
      await runCliRejecting({
        args: [
          "model",
          "method",
          "run",
          "boom",
          "execute",
          "--input",
          "run=exit 3",
          ...json,
        ],
      });
    });
    const b = openV3Datastore({ repoDir: repos.repoB, datastorePath });
    try {
      await b.catchUp();
    } finally {
      await b.close();
    }
    const outputs = [];
    for await (
      const entry of walk(swampPath(repos.repoB, "outputs"), {
        includeDirs: false,
        exts: [".yaml"],
      })
    ) {
      outputs.push(parseYaml(await Deno.readTextFile(entry.path)) as {
        status: string;
      });
    }
    assertEquals(outputs.map((o) => o.status), ["failed"]);
  });
});

Deno.test("v3 opt-in: a query on a fresh checkout answers from the read model, never a disk walk", async () => {
  await withV3RowRepos({}, async (repos) => {
    const model = await saveSeedModel(repos);
    await runInRootUnitOfWork(
      repos.a.repoContext,
      { flush: undefined },
      () => saveData(repos.serveRepo, model, "committed"),
    );
    // B joins first: a checkout holding records before its first v3 open
    // is refused (swamp-club#3690).
    await requireInitializedRepoReadOnly({
      repoDir: repos.repoB,
      outputMode: "json",
    });
    await closeV3Datastores();
    // A stray record file in B's checkout that no commit names: a v2 disk
    // walk would index it; the v3 catalog never does.
    const stray = swampPath(
      repos.repoB,
      "data",
      repos.modelType.normalized,
      model.id,
      "stray",
      "1",
    );
    await Deno.mkdir(stray, { recursive: true });
    await Deno.writeTextFile(
      join(stray, "metadata.yaml"),
      await Deno.readTextFile(
        swampPath(
          repos.repoA,
          "data",
          repos.modelType.normalized,
          model.id,
          "committed",
          "1",
          "metadata.yaml",
        ),
      ),
    );
    const reader = await requireInitializedRepoReadOnly({
      repoDir: repos.repoB,
      outputMode: "json",
    });
    const names = (await reader.repoContext.dataQueryService.query("true"))
      .map((record) => (record as { name: string }).name);
    assertEquals(names, ["committed"]);
  });
});

Deno.test("v3 opt-in: setup refuses to move a repo off its v3 datastore, to v2 or to another v3", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    await initRepo(repoDir);
    assertEquals(
      errorOf(await setupV3(repoDir, join(dir, "first"))),
      undefined,
    );
    const yaml = await Deno.readTextFile(join(repoDir, ".swamp.yaml"));

    assertStringIncludes(
      errorOf(await setupV3(repoDir, join(dir, "second"))) ?? "",
      "uses a v3 datastore",
    );
    const toV2 = await collect<DatastoreSetupEvent>(
      datastoreSetupFilesystem(
        createLibSwampContext(),
        createDatastoreSetupDeps(repoDir, resolveConfigTierPath),
        {
          datastorePath: join(dir, "v2"),
          repoDir,
          skipMigration: false,
          outgoingDatastorePath: join(dir, "first"),
        },
      ),
    );
    assertStringIncludes(errorOf(toV2) ?? "", "uses a v3 datastore");
    assertEquals(await Deno.readTextFile(join(repoDir, ".swamp.yaml")), yaml);
    await assertRejects(
      () => Deno.stat(join(dir, "second")),
      Deno.errors.NotFound,
    );
  });
});

Deno.test("v3 opt-in: a namespace set before setup becomes the v3 datastore's namespace", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    await initRepo(repoDir);
    await withMockedEnv(UNSET_ENV, () =>
      runCli({
        args: [
          "datastore",
          "namespace",
          "set",
          "team",
          "--repo-dir",
          repoDir,
          "--json",
        ],
      }));
    assertEquals(errorOf(await setupV3(repoDir, join(dir, "v3"))), undefined);
    const { datastoreConfig, engine } = await resolveDatastoreForRepo(repoDir);
    assertEquals(engine, "v3");
    assertEquals(datastoreConfig.namespace, "team");
  });
});

/** Every file under `root`, by relative path, with its bytes as text. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for await (const entry of walk(root, { includeDirs: false })) {
    files[entry.path.slice(root.length)] = await Deno.readTextFile(entry.path)
      .catch(() => "<binary>");
  }
  return files;
}

Deno.test("v3 opt-in: a v2 setup onto an existing v3 datastore is refused, changing nothing", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "v3");
    await initializeV3Datastore(datastorePath, "test");
    const repoDir = join(dir, "repo");
    await initRepo(repoDir);
    const record = swampPath(repoDir, "data", "x", "y", "rec.json");
    await Deno.mkdir(join(record, ".."), { recursive: true });
    await Deno.writeTextFile(record, '{"kept":true}');
    const yaml = await Deno.readTextFile(join(repoDir, ".swamp.yaml"));
    const targetBefore = await snapshot(datastorePath);

    const events = await collect<DatastoreSetupEvent>(
      datastoreSetupFilesystem(
        createLibSwampContext(),
        createDatastoreSetupDeps(repoDir, resolveConfigTierPath),
        { datastorePath, repoDir, skipMigration: false },
      ),
    );
    assertStringIncludes(errorOf(events) ?? "", "is a v3 datastore");
    assertEquals(await Deno.readTextFile(record), '{"kept":true}');
    assertEquals(await Deno.readTextFile(join(repoDir, ".swamp.yaml")), yaml);
    assertEquals(await snapshot(datastorePath), targetBefore);
  });
});

Deno.test("v3 opt-in: a setup that stopped after the marker, or after the skeleton, is completed by a re-run", async () => {
  for (const stoppedAfter of ["marker", "skeleton"] as const) {
    await withTempDir(async (dir) => {
      const repoDir = join(dir, "repo");
      await initRepo(repoDir);
      const datastorePath = join(dir, "v3");
      if (stoppedAfter === "marker") {
        await Deno.mkdir(datastorePath);
        await Deno.writeTextFile(
          join(datastorePath, "datastore-format.json"),
          '{"format":3,"minReaderFormat":3}',
        );
      } else {
        await initializeV3Datastore(datastorePath, "test");
      }
      assertEquals(errorOf(await setupV3(repoDir, datastorePath)), undefined);
      assertEquals((await resolveDatastoreForRepo(repoDir)).engine, "v3");
    });
  }
});

/** Every file under `dir`, by relative path, with its bytes. */
async function snapshotOf(
  dir: string,
): Promise<Map<string, Uint8Array | string>> {
  const files = new Map<string, Uint8Array | string>();
  for await (const entry of walk(dir, { includeDirs: true })) {
    const rel = entry.path.slice(dir.length);
    files.set(
      rel,
      entry.isFile
        ? await Deno.readFile(entry.path)
        : entry.isDirectory
        ? "dir"
        : "other",
    );
  }
  return files;
}

Deno.test("v3 opt-in: doctor datastores --repair refuses on v3, and the check still runs", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    await withMockedEnv(UNSET_ENV, async () => {
      const json = ["--repo-dir", repos.repoA, "--json"];
      await closeV3Datastores();
      const before = await snapshotOf(datastorePath);
      for (const args of [["--repair"], ["--repair", "--yes"]]) {
        const error = await runCliRejecting({
          args: ["doctor", "datastores", ...args, ...json],
        });
        assertInstanceOf(error, UserError);
        // Pinned by swamp-uat.
        assertEquals(
          error.message,
          "`swamp doctor datastores --repair` is not available for v3 " +
            "datastores yet. A v3 checkout rebuilds its records and catalog " +
            "from the commit log; run `swamp doctor datastores` to check it. " +
            "Nothing was changed.",
        );
      }
      // Nothing was changed: the datastore is byte-identical.
      assertEquals(await snapshotOf(datastorePath), before);
      const report = JSON.parse(
        (await runCli({ args: ["doctor", "datastores", ...json] })).join("\n"),
      );
      // The v3 content check passes on a healthy checkout (swamp-club#3617).
      assertEquals(report.overallStatus, "pass");
      assertEquals(
        report.healthFindings.find((f: { check: string }) =>
          f.check === "v3_content"
        )?.passed,
        true,
      );
    });
  });
});

Deno.test("v3 opt-in: serve's doctor datastores reports a v3 checkout's at-risk copies (swamp-club#3617)", async () => {
  await withV3RowRepos({}, async (repos) => {
    const v3Content = async () => {
      const frames = await sendRequest(createServeCtx(repos.serveRepo), {
        type: "doctor.datastores",
        id: crypto.randomUUID(),
      });
      const data = frames.find((frame) => frame.type === "doctor.datastores")
        ?.payload?.data as {
          healthFindings: { check: string; passed: boolean; message: string }[];
        };
      return data.healthFindings.find((f) => f.check === "v3_content");
    };
    assertEquals((await v3Content())?.passed, true);

    const db = new DatabaseSync(
      join(readModelStateDir(repos.repoA), READ_MODEL_STATE_FILE),
    );
    try {
      db.exec("PRAGMA busy_timeout=5000");
      db.prepare(
        "INSERT INTO at_risk_copies (namespace, sha256, record_key, blob, size, created_at, last_attempt) VALUES ('', ?, 'data/m/held/1/raw', NULL, 9, 1, 1)",
      ).run("b".repeat(64));
    } finally {
      db.close();
    }
    const finding = await v3Content();
    assertEquals(finding?.passed, false);
    assertStringIncludes(finding?.message ?? "", "data/m/held/1/raw");
  });
});

Deno.test({
  name:
    "v3 opt-in: serve's doctor datastores reports a v3 content check that cannot read a read-only state directory as failed, and completes (swamp-club#3617)",
  // Windows has no read-only directory mode; root ignores it.
  ignore: Deno.build.os === "windows" || Deno.uid() === 0,
  fn: async () => {
    await withV3RowRepos({}, async (repos) => {
      const stateDir = readModelStateDir(repos.repoA);
      // Every connection closed, so its WAL files are gone.
      await closeV3Datastores();
      for (const suffix of ["-wal", "-shm"]) {
        await Deno.remove(join(stateDir, READ_MODEL_STATE_FILE + suffix))
          .catch(() => {});
      }
      await Deno.chmod(stateDir, 0o555);
      try {
        const frames = await sendRequest(createServeCtx(repos.serveRepo), {
          type: "doctor.datastores",
          id: crypto.randomUUID(),
        });
        const data = frames.find((frame) => frame.type === "doctor.datastores")
          ?.payload?.data as {
            healthFindings: {
              check: string;
              passed: boolean;
              message: string;
            }[];
            v3ContentFinding?: unknown;
          };
        assert(data !== undefined, JSON.stringify(frames));
        const finding = data.healthFindings.find((f) =>
          f.check === "v3_content"
        );
        assertEquals(finding?.passed, false);
        assertStringIncludes(
          finding?.message ?? "",
          "Could not inspect this v3 checkout's content: ",
        );
        // The other checks still report.
        assertEquals(
          data.healthFindings.find((f) => f.check === "health")?.passed,
          true,
        );
        assertEquals(data.v3ContentFinding ?? null, null);
      } finally {
        await Deno.chmod(stateDir, 0o755);
      }
    });
  },
});

Deno.test("v3 opt-in: a read-only context refuses any change staged through it", async () => {
  await withV3RowRepos({}, async (repos) => {
    const model = await saveSeedModel(repos);
    const reader = await requireInitializedRepoReadOnly({
      repoDir: repos.repoA,
      outputMode: "json",
    });
    await assertRejects(
      () =>
        runInRootUnitOfWork(
          reader.repoContext,
          { flush: undefined },
          () =>
            saveData(
              { ...repos.serveRepo, repoContext: reader.repoContext },
              model,
              "from-a-reader",
            ),
        ),
      ReadOnlyV3WriteError,
    );
  });
});

Deno.test("v3 opt-in: datastore lock status and release act on the writer lease", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    await withMockedEnv(UNSET_ENV, async () => {
      const json = ["--repo-dir", repos.repoB, "--json"];
      // A holds the writer lock: B's status sees this process holding it.
      const held = JSON.parse(
        (await runCli({ args: ["datastore", "lock", "status", ...json] }))
          .join("\n"),
      );
      assertEquals(held.held, true);
      assertEquals(held.info.pid, Deno.pid);
      assertEquals(typeof held.info.fence, "number");
      await runCli({
        args: ["datastore", "lock", "release", "--force", ...json],
      });
      // The fence is marked released, never deleted, so it is never reused.
      await Deno.stat(
        join(
          datastorePath,
          "_control",
          "writer",
          `released-${String(held.info.fence).padStart(12, "0")}`,
        ),
      );
      const released = JSON.parse(
        (await runCli({ args: ["datastore", "lock", "status", ...json] }))
          .join("\n"),
      );
      assertEquals(released.held, false);
    });
  });
});

Deno.test("v3 opt-in: namespace unset and the datastore sync command refuse on v3", async () => {
  await withV3RowRepos({}, async (repos) => {
    await withMockedEnv(UNSET_ENV, async () => {
      const json = ["--repo-dir", repos.repoA, "--json"];
      const unset = await runCliRejecting({
        args: ["datastore", "namespace", "unset", ...json],
      });
      assertInstanceOf(unset, Error);
      assertStringIncludes(unset.message, "v3 datastore");
      const sync = await runCliRejecting({
        args: ["datastore", "sync", ...json],
      });
      assertInstanceOf(sync, Error);
      assertStringIncludes(sync.message, "only available for");
    });
  });
});
