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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { swampPath } from "../persistence/paths.ts";
import { initializeV3Datastore } from "./v3_datastore.ts";
import {
  assertV3CheckoutJoinable,
  hasV3CheckoutState,
  isJoinOwnFile,
  movePreV3CheckoutRecords,
  PRE_V3_RECORDS_DIR,
  preV3CheckoutRecordDirs,
  preV3RecordsRunName,
  V3_CHECKOUT_HOLDS_RECORDS_CODE,
  V3CheckoutHoldsRecordsError,
} from "./v3_checkout_join.ts";
import {
  closeV3Datastores,
  holdV3Writer,
  v3DatastoreFor,
  v3RepositoryFactoryConfig,
} from "./v3_repo_context.ts";
import { isCheckoutLocalKey, readModelStateDir } from "./record_path_guard.ts";
import { hasDatastoreRecords } from "../persistence/datastore_records.ts";
import {
  CATALOG_FILES,
  DEFAULT_DATASTORE_SUBDIRS,
} from "../../domain/datastore/datastore_config.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-v3-join-" });
  try {
    await fn(dir);
  } finally {
    await closeV3Datastores().catch(() => {});
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function plant(repoDir: string, ...segments: string[]): Promise<void> {
  const path = swampPath(repoDir, ...segments);
  await Deno.mkdir(join(path, ".."), { recursive: true });
  await Deno.writeTextFile(path, "v2 record");
}

/** Every file under `dir`, relative, with its content. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walkDir = async (path: string, rel: string) => {
    for await (const entry of Deno.readDir(path)) {
      const child = join(path, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory) await walkDir(child, childRel);
      else files[childRel] = await Deno.readTextFile(child).catch(() => "");
    }
  };
  try {
    await walkDir(dir, "");
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return files;
}

Deno.test("assertV3CheckoutJoinable: refuses the first open of a checkout holding records, naming them, and writes nothing", async () => {
  await withTempDir(async (repoDir) => {
    await plant(repoDir, "data", "m1", "log", "1", "raw");
    await plant(repoDir, "outputs", "m1", "run.yaml");
    const before = await snapshot(swampPath(repoDir));
    const error = await assertRejects(
      () => assertV3CheckoutJoinable(repoDir),
      V3CheckoutHoldsRecordsError,
    );
    assertEquals(error.code, V3_CHECKOUT_HOLDS_RECORDS_CODE);
    assertEquals([...error.recordDirs], ["data", "outputs"]);
    assert(error.message.includes("A v3 datastore starts empty"));
    assert(error.message.includes("swamp doctor datastores --repair"));
    assert(error.message.includes(PRE_V3_RECORDS_DIR));
    assertEquals(await snapshot(swampPath(repoDir)), before);
  });
});

Deno.test("assertV3CheckoutJoinable: a checkout holding nothing, or only repo-local and always-local files, joins", async () => {
  await withTempDir(async (repoDir) => {
    await assertV3CheckoutJoinable(repoDir);
    await Deno.mkdir(swampPath(repoDir), { recursive: true });
    await assertV3CheckoutJoinable(repoDir);
    for (const subdir of ["logs", "telemetry", "audit", "files", "secrets"]) {
      await plant(repoDir, subdir, "a.json");
    }
    await plant(repoDir, "bundles", "ext", "mod.js");
    // The v2 catalog is an index, not a record.
    await plant(repoDir, "data", "_catalog.db");
    await plant(repoDir, "run_tracker.db");
    await assertV3CheckoutJoinable(repoDir);
  });
});

Deno.test("assertV3CheckoutJoinable: a checkout with v3 state is not walked again, and state deleted by hand is checked again", async () => {
  await withTempDir(async (repoDir) => {
    const stateDir = readModelStateDir(repoDir);
    await Deno.mkdir(stateDir, { recursive: true });
    await Deno.writeTextFile(join(stateDir, "_read_model_v3.db"), "");
    await plant(repoDir, "data", "m1", "log", "1", "raw");
    await assertV3CheckoutJoinable(repoDir);
    assertEquals(await preV3CheckoutRecordDirs(repoDir), []);
    await Deno.remove(stateDir, { recursive: true });
    await assertRejects(
      () => assertV3CheckoutJoinable(repoDir),
      V3CheckoutHoldsRecordsError,
    );
  });
});

Deno.test("preV3CheckoutRecordDirs: counts the namespace's records under the namespace", async () => {
  await withTempDir(async (repoDir) => {
    await plant(repoDir, "team", "data", "m1", "log", "1", "raw");
    assertEquals(await preV3CheckoutRecordDirs(repoDir), []);
    assertEquals(await preV3CheckoutRecordDirs(repoDir, "team"), [
      join("team", "data"),
    ]);
  });
});

Deno.test("preV3RecordsRunName: holds no character Windows refuses, and differs per run", () => {
  const now = new Date("2026-10-20T21:13:21.267Z");
  const name = preV3RecordsRunName(now);
  assert(name.startsWith("20261020T211321Z-"), name);
  assert(!/[<>:"/\\|?*]/.test(name), name);
  assert(preV3RecordsRunName(now) !== name);
});

Deno.test("movePreV3CheckoutRecords: moves each record directory under pre-v3-records, keeping its path, and leaves the rest", async () => {
  await withTempDir(async (repoDir) => {
    await plant(repoDir, "data", "m1", "log", "1", "raw");
    await plant(repoDir, "team", "outputs", "m1", "run.yaml");
    await plant(repoDir, "logs", "run.log");
    const { destination, moved } = await movePreV3CheckoutRecords(
      repoDir,
      "team",
      new Date("2026-10-20T21:13:21Z"),
    );
    assertEquals([...moved], ["data", join("team", "outputs")]);
    assert(
      destination.startsWith(swampPath(repoDir, PRE_V3_RECORDS_DIR)),
      destination,
    );
    assertEquals(
      await Deno.readTextFile(
        join(destination, "data", "m1", "log", "1", "raw"),
      ),
      "v2 record",
    );
    assertEquals(
      await Deno.readTextFile(
        join(destination, "team", "outputs", "m1", "run.yaml"),
      ),
      "v2 record",
    );
    await Deno.stat(swampPath(repoDir, "logs", "run.log"));
    await assertRejects(
      () => Deno.stat(swampPath(repoDir, "data")),
      Deno.errors.NotFound,
    );
    // The moved records no longer stop the checkout joining.
    await assertV3CheckoutJoinable(repoDir, "team");
  });
});

Deno.test("movePreV3CheckoutRecords: moves nothing in a checkout with v3 state", async () => {
  await withTempDir(async (repoDir) => {
    const stateDir = readModelStateDir(repoDir);
    await Deno.mkdir(stateDir, { recursive: true });
    await Deno.writeTextFile(join(stateDir, "_read_model_v3.db"), "");
    await plant(repoDir, "data", "m1", "log", "1", "raw");
    const { moved } = await movePreV3CheckoutRecords(repoDir);
    assertEquals([...moved], []);
    await Deno.stat(swampPath(repoDir, "data", "m1", "log", "1", "raw"));
  });
});

Deno.test("hasV3CheckoutState: the read model's state exists once a checkout's v3 handle opens, before anything is materialised", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const repoDir = join(dir, "repo");
    await Deno.mkdir(repoDir);
    assertEquals(await hasV3CheckoutState(repoDir), false);
    v3DatastoreFor(repoDir, { type: "filesystem", path: datastorePath });
    assertEquals(await hasV3CheckoutState(repoDir), true);
  });
});

Deno.test("holdV3Writer: refuses a checkout holding records before the lease records it in the datastore", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const repoDir = join(dir, "repo");
    await plant(repoDir, "data", "m1", "log", "1", "raw");
    const datastoreBefore = await snapshot(datastorePath);
    const checkoutBefore = await snapshot(swampPath(repoDir));
    await assertRejects(
      () => holdV3Writer({ type: "filesystem", path: datastorePath }, repoDir),
      V3CheckoutHoldsRecordsError,
    );
    assertEquals(await snapshot(datastorePath), datastoreBefore);
    assertEquals(await snapshot(swampPath(repoDir)), checkoutBefore);
  });
});

Deno.test("v3RepositoryFactoryConfig: refuses a checkout holding records before its read model opens", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const repoDir = join(dir, "repo");
    await plant(repoDir, "data", "m1", "log", "1", "raw");
    await assertRejects(
      () =>
        v3RepositoryFactoryConfig(repoDir, {
          type: "filesystem",
          path: datastorePath,
        }, { readOnly: true }),
      V3CheckoutHoldsRecordsError,
    );
    assertEquals(await hasV3CheckoutState(repoDir), false);
  });
});

Deno.test("assertV3CheckoutJoinable: files a v3 checkout keeps as its own are no records: pulled extensions, dot-prefixed locks and run logs", async () => {
  await withTempDir(async (repoDir) => {
    await plant(repoDir, "config", "pulled-extensions", "@acme", "mod.ts");
    await plant(repoDir, "data", ".lock");
    await plant(repoDir, "outputs", "m1", "run.log");
    await assertV3CheckoutJoinable(repoDir);
    // A config record beside them still counts.
    await plant(repoDir, "config", "vaults", "local_encryption", "v1.yaml");
    const error = await assertRejects(
      () => assertV3CheckoutJoinable(repoDir),
      V3CheckoutHoldsRecordsError,
    );
    assertEquals([...error.recordDirs], ["config"]);
  });
});

Deno.test("assertV3CheckoutJoinable and movePreV3CheckoutRecords: a v2 dot-named record counts and moves, while the checkout's own dot files do not (swamp-club#3736)", async () => {
  await withTempDir(async (repoDir) => {
    const temp = ".0f4e2a6c-1b3d-4c5e-8f90-a1b2c3d4e5f6.tmp";
    await plant(repoDir, "data", "t", "m1", temp);
    await plant(repoDir, "data", "t", "m1", ".lock");
    await plant(repoDir, "workflow-runs", "w1", ".runs-index.json");
    await plant(repoDir, "workflow-runs", "w1", "workflow-run-1.log");
    await assertV3CheckoutJoinable(repoDir);
    await plant(repoDir, "data", "t", "m1", ".kubeconfig", "1", "raw");
    const error = await assertRejects(
      () => assertV3CheckoutJoinable(repoDir),
      V3CheckoutHoldsRecordsError,
    );
    assertEquals([...error.recordDirs], ["data"]);
    const { destination, moved } = await movePreV3CheckoutRecords(repoDir);
    assertEquals([...moved], ["data"]);
    await Deno.stat(
      join(destination, "data", "t", "m1", ".kubeconfig", "1", "raw"),
    );
    await Deno.stat(swampPath(repoDir, "data", "t", "m1", temp));
    await Deno.stat(swampPath(repoDir, "data", "t", "m1", ".lock"));
    await Deno.stat(
      swampPath(repoDir, "workflow-runs", "w1", ".runs-index.json"),
    );
    await assertV3CheckoutJoinable(repoDir);
  });
});

Deno.test("hasDatastoreRecords with isCheckoutLocalKey, as v3 setup checks: a dot-named record counts, the checkout's own dot files do not (swamp-club#3736)", async () => {
  await withTempDir(async (repoDir) => {
    const dir = swampPath(repoDir);
    const check = () =>
      hasDatastoreRecords(
        dir,
        DEFAULT_DATASTORE_SUBDIRS,
        CATALOG_FILES,
        isCheckoutLocalKey,
      );
    await plant(
      repoDir,
      "data",
      "t",
      "m1",
      ".0f4e2a6c-1b3d-4c5e-8f90-a1b2c3d4e5f6.tmp",
    );
    await plant(repoDir, "data", "t", "m1", ".lock");
    await plant(repoDir, "workflow-runs", "w1", ".runs-index.json");
    await plant(repoDir, "outputs", "t", "probe", "run.log");
    assertEquals(await check(), false);
    await plant(repoDir, "outputs", "t", ".probe", "def-1.yaml");
    assertEquals(await check(), true);
  });
});

Deno.test("movePreV3CheckoutRecords: moves records only, leaving the checkout's own files, and removes the version directories it empties", async () => {
  await withTempDir(async (repoDir) => {
    await plant(repoDir, "config", "pulled-extensions", "@acme", "mod.ts");
    await plant(repoDir, "config", "upstream_extensions.json");
    await plant(repoDir, "config", "vaults", "local_encryption", "v1.yaml");
    await plant(repoDir, "data", "m1", "log", "3", "raw");
    await plant(repoDir, "data", "_catalog.db");
    await plant(repoDir, "outputs", "m1", "run.log");
    await plant(repoDir, "outputs", "m1", "run.yaml");
    const { destination, moved } = await movePreV3CheckoutRecords(repoDir);
    assertEquals([...moved], ["config", "data", "outputs"]);
    await Deno.stat(
      swampPath(repoDir, "config", "pulled-extensions", "@acme", "mod.ts"),
    );
    await Deno.stat(swampPath(repoDir, "outputs", "m1", "run.log"));
    await Deno.stat(swampPath(repoDir, "data", "_catalog.db"));
    await Deno.stat(swampPath(repoDir, "config", "upstream_extensions.json"));
    await Deno.stat(
      join(destination, "config", "vaults", "local_encryption", "v1.yaml"),
    );
    await Deno.stat(join(destination, "outputs", "m1", "run.yaml"));
    // No empty version directory is left to be listed as a version.
    await assertRejects(
      () => Deno.stat(swampPath(repoDir, "data", "m1")),
      Deno.errors.NotFound,
    );
    await assertV3CheckoutJoinable(repoDir);
  });
});

Deno.test("movePreV3CheckoutRecords: a namespace named like a record directory moves once, without failing", async () => {
  await withTempDir(async (repoDir) => {
    await plant(repoDir, "data", "data", "m1", "log", "1", "raw");
    assertEquals(await preV3CheckoutRecordDirs(repoDir, "data"), [
      "data",
      join("data", "data"),
    ]);
    const { destination, moved } = await movePreV3CheckoutRecords(
      repoDir,
      "data",
    );
    assertEquals([...moved], ["data"]);
    await Deno.stat(join(destination, "data", "data", "m1", "log", "1", "raw"));
    await assertV3CheckoutJoinable(repoDir, "data");
  });
});

Deno.test("preV3CheckoutRecordDirs and movePreV3CheckoutRecords: a namespace that is no slug is refused before any path outside .swamp is walked or moved", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    // A record outside the repo that `../..` would reach.
    await Deno.mkdir(join(dir, "data"), { recursive: true });
    await Deno.writeTextFile(join(dir, "data", "outside"), "not the repo's");
    for (const namespace of ["../..", "a/b", "UPPER"]) {
      await assertRejects(() => preV3CheckoutRecordDirs(repoDir, namespace));
      await assertRejects(() => movePreV3CheckoutRecords(repoDir, namespace));
    }
    assertEquals(
      await Deno.readTextFile(join(dir, "data", "outside")),
      "not the repo's",
    );
  });
});

Deno.test("isJoinOwnFile: the managedConfig lockfile is the joining checkout's own, and no other file of that name or config record is (swamp-club#3696)", () => {
  for (
    const key of [
      "config/upstream_extensions.json",
      "config/pulled-extensions/@swamp/s3-datastore/manifest.yaml",
      "data/.lock",
    ]
  ) {
    assertEquals(isJoinOwnFile(key.split("/")), true, key);
  }
  for (
    const key of [
      "config/vaults/local_encryption/v1.yaml",
      "config/models/m1.yaml",
      "config/x/upstream_extensions.json",
      "models/upstream_extensions.json",
      "upstream_extensions.json",
    ]
  ) {
    assertEquals(isJoinOwnFile(key.split("/")), false, key);
  }
});

Deno.test("assertV3CheckoutJoinable: a fresh managedConfig checkout holding only what the datastore extension's install wrote joins, and one holding records beside it is refused (swamp-club#3696)", async () => {
  await withTempDir(async (repoDir) => {
    // What auto-installing the datastore extension leaves in a fresh clone.
    await plant(
      repoDir,
      "config",
      "pulled-extensions",
      "@swamp",
      "s3-datastore",
      "datastores",
      "s3.ts",
    );
    await plant(repoDir, "config", "upstream_extensions.json");
    await plant(repoDir, "datastore-bundles", "85cd93fd", "s3.js");
    await plant(repoDir, "_extension_catalog.db");
    await assertV3CheckoutJoinable(repoDir);
    assertEquals(await preV3CheckoutRecordDirs(repoDir), []);
    await plant(repoDir, "data", "m1", "log", "1", "raw");
    const error = await assertRejects(
      () => assertV3CheckoutJoinable(repoDir),
      V3CheckoutHoldsRecordsError,
    );
    assertEquals([...error.recordDirs], ["data"]);
  });
});
