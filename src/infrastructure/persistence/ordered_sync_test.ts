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

import {
  assertEquals,
  assertNotStrictEquals,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import { join } from "@std/path";
import type { DatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { BarrierSyncResult } from "./barrier_sync.ts";
import { DefaultDatastorePathResolver } from "./default_datastore_path_resolver.ts";
import {
  fullWriteSync,
  orderedWriteSync,
  selectDurableWriteSync,
} from "./ordered_sync.ts";

const REPO = join("/", "repo");
const CATALOG = join(REPO, ".swamp", "data", "_catalog.db");

function resolverFor(
  config: DatastoreConfig,
  engine: "v2" | "v3" = "v2",
): DatastorePathResolver {
  return new DefaultDatastorePathResolver(REPO, config, { engine });
}

/** A file handle double that records whether it was fully synced. */
function fakeFile(): { file: Deno.FsFile; synced: () => number } {
  let synced = 0;
  const file = {
    sync: () => {
      synced++;
      return Promise.resolve();
    },
  } as unknown as Deno.FsFile;
  return { file, synced: () => synced };
}

/**
 * Ordered hooks on a fake darwin host: every path is on device 1 unless
 * `devices` says otherwise, and the barrier answers `barrier`.
 */
function darwinHooks(options: {
  barrier?: (path: string) => BarrierSyncResult;
  devices?: Record<string, number>;
  failStat?: ReadonlySet<string>;
  refusedDevices?: Set<number>;
} = {}) {
  const barriers: string[] = [];
  const hooks = orderedWriteSync({
    orderedBefore: CATALOG,
    platform: "darwin",
    barrierSync: (path) => {
      barriers.push(path);
      return Promise.resolve(options.barrier?.(path) ?? "synced");
    },
    deviceOf: (path) =>
      options.failStat?.has(path)
        ? Promise.reject(new Deno.errors.NotFound(path))
        : Promise.resolve(options.devices?.[path] ?? 1),
    refusedDevices: options.refusedDevices ?? new Set(),
  });
  return { hooks, barriers };
}

const TEMP = join(REPO, ".swamp", "data", "m", "id", "out", "1", ".x.tmp");
const PATHS = { temp: TEMP, target: join(REPO, "raw") };

// --- selectDurableWriteSync ---

Deno.test("selectDurableWriteSync: no resolver orders against the catalog", () => {
  assertNotStrictEquals(
    selectDurableWriteSync(undefined, CATALOG, { platform: "darwin" }),
    fullWriteSync,
  );
});

Deno.test("selectDurableWriteSync: the default v2 filesystem datastore is ordered", () => {
  const resolver = resolverFor({
    type: "filesystem",
    path: join(REPO, ".swamp"),
  });
  assertNotStrictEquals(
    selectDurableWriteSync(resolver, CATALOG, { platform: "darwin" }),
    fullWriteSync,
  );
});

Deno.test("selectDurableWriteSync: a data directory spelled differently but the same is still the repo's own", () => {
  const real = resolverFor({ type: "filesystem", path: join(REPO, ".swamp") });
  const resolver: DatastorePathResolver = {
    ...real,
    config: () => real.config(),
    engine: () => "v2",
    localPath: (...segments) => real.localPath(...segments),
    // Spelled by hand on purpose: a `..` segment and a trailing separator
    // that only `resolve()` folds back into the local data directory.
    resolvePath: (subdir) =>
      join(REPO, ".swamp", "outputs") + "/../" + subdir + "/",
  };
  assertNotStrictEquals(
    selectDurableWriteSync(resolver, CATALOG, { platform: "darwin" }),
    fullWriteSync,
  );
});

Deno.test("selectDurableWriteSync: a filesystem datastore that keeps data local is ordered", () => {
  const resolver = resolverFor({
    type: "filesystem",
    path: join("/", "elsewhere"),
    directories: ["outputs"],
  });
  assertNotStrictEquals(
    selectDurableWriteSync(resolver, CATALOG, { platform: "darwin" }),
    fullWriteSync,
  );
});

Deno.test("selectDurableWriteSync: a custom-path filesystem datastore is synced in full", () => {
  const resolver = resolverFor({
    type: "filesystem",
    path: join("/", "mnt", "data"),
  });
  assertStrictEquals(
    selectDurableWriteSync(resolver, CATALOG, { platform: "darwin" }),
    fullWriteSync,
  );
});

Deno.test("selectDurableWriteSync: a namespaced filesystem datastore is synced in full", () => {
  const resolver = resolverFor({
    type: "filesystem",
    path: join(REPO, ".swamp"),
    namespace: "team",
  });
  assertStrictEquals(
    selectDurableWriteSync(resolver, CATALOG, { platform: "darwin" }),
    fullWriteSync,
  );
});

Deno.test("selectDurableWriteSync: a namespaced datastore is synced in full even when it keeps data local", () => {
  const resolver = resolverFor({
    type: "filesystem",
    path: join(REPO, ".swamp"),
    namespace: "team",
    directories: ["outputs"],
  });
  assertStrictEquals(
    selectDurableWriteSync(resolver, CATALOG, { platform: "darwin" }),
    fullWriteSync,
  );
});

for (const hydrationStrategy of ["full", "lazy"] as const) {
  Deno.test(`selectDurableWriteSync: an extension datastore's ${hydrationStrategy} cache is synced in full`, () => {
    const resolver = resolverFor({
      type: "@swamp/s3-datastore",
      config: {},
      datastorePath: "s3://bucket",
      cachePath: join(REPO, ".swamp"),
      hydrationStrategy,
    });
    assertStrictEquals(
      selectDurableWriteSync(resolver, CATALOG, { platform: "darwin" }),
      fullWriteSync,
    );
  });
}

Deno.test("selectDurableWriteSync: a v3 datastore is synced in full", () => {
  const resolver = resolverFor(
    { type: "filesystem", path: join(REPO, ".swamp"), format: 3 },
    "v3",
  );
  assertStrictEquals(
    selectDurableWriteSync(resolver, CATALOG, { platform: "darwin" }),
    fullWriteSync,
  );
});

Deno.test("selectDurableWriteSync: an injected catalog store is synced in full", () => {
  assertStrictEquals(
    selectDurableWriteSync(undefined, CATALOG, {
      catalogStoreInjected: true,
      platform: "darwin",
    }),
    fullWriteSync,
  );
});

// --- orderedWriteSync ---

Deno.test("orderedWriteSync: off macOS every sync is a full one", () => {
  for (const platform of ["linux", "windows"] as const) {
    assertStrictEquals(
      orderedWriteSync({ orderedBefore: CATALOG, platform }),
      fullWriteSync,
    );
  }
});

Deno.test("orderedWriteSync: a file on the catalog's device takes the barrier, not a full sync", async () => {
  const { hooks, barriers } = darwinHooks();
  const { file, synced } = fakeFile();
  await hooks.syncFile!(file, PATHS);
  assertEquals(barriers, [TEMP]);
  assertEquals(synced(), 0);
});

Deno.test("orderedWriteSync: a directory on the catalog's device takes the barrier", async () => {
  const { hooks, barriers } = darwinHooks();
  const dir = join(REPO, ".swamp", "data", "m");
  await hooks.syncDirectory!(dir);
  assertEquals(barriers, [dir]);
});

Deno.test("orderedWriteSync: a volume that refuses the barrier is synced in full, and remembered", async () => {
  const refusedDevices = new Set<number>();
  const { hooks, barriers } = darwinHooks({
    barrier: () => "unsupported",
    refusedDevices,
  });
  const first = fakeFile();
  await hooks.syncFile!(first.file, PATHS);
  assertEquals(first.synced(), 1);
  assertEquals([...refusedDevices], [1]);

  const second = fakeFile();
  await hooks.syncFile!(second.file, PATHS);
  assertEquals(second.synced(), 1);
  assertEquals(barriers.length, 1);
});

Deno.test("orderedWriteSync: a path on another device is synced in full", async () => {
  const { hooks, barriers } = darwinHooks({ devices: { [TEMP]: 2 } });
  const { file, synced } = fakeFile();
  await hooks.syncFile!(file, PATHS);
  assertEquals(barriers, []);
  assertEquals(synced(), 1);
});

Deno.test("orderedWriteSync: a path that cannot be looked up is synced in full", async () => {
  const { hooks, barriers } = darwinHooks({ failStat: new Set([TEMP]) });
  const { file, synced } = fakeFile();
  await hooks.syncFile!(file, PATHS);
  assertEquals(barriers, []);
  assertEquals(synced(), 1);
});

Deno.test("orderedWriteSync: a catalog directory that cannot be looked up yet is retried by the next sync", async () => {
  const catalogDir = join(REPO, ".swamp", "data");
  const failStat = new Set([catalogDir]);
  const { hooks, barriers } = darwinHooks({ failStat });
  const first = fakeFile();
  await hooks.syncFile!(first.file, PATHS);
  assertEquals(first.synced(), 1);

  failStat.delete(catalogDir);
  const second = fakeFile();
  await hooks.syncFile!(second.file, PATHS);
  assertEquals(second.synced(), 0);
  assertEquals(barriers, [TEMP]);
});

Deno.test("orderedWriteSync: a failed full sync after a refused barrier still fails the write", async () => {
  const { hooks } = darwinHooks({ barrier: () => "unsupported" });
  const file = {
    sync: () => Promise.reject(new Error("EIO")),
  } as unknown as Deno.FsFile;
  await assertRejects(() => hooks.syncFile!(file, PATHS), Error, "EIO");
});
