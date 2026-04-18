// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assertEquals } from "@std/assert";
import {
  type DatastoreAutoUpdateDeps,
  maybeAutoUpdateDatastoreExtension,
} from "./datastore_auto_update.ts";
import type { ExtensionUpdateCheckMap } from "../../domain/extensions/extension_update_check_cache.ts";
import { CHECK_INTERVAL_MS } from "../../domain/update/update_check_cache.ts";

function createMockDeps(
  overrides?: Partial<DatastoreAutoUpdateDeps>,
): DatastoreAutoUpdateDeps & {
  cache: ExtensionUpdateCheckMap;
  pulled: string[];
} {
  const cache: ExtensionUpdateCheckMap = {};
  const pulled: string[] = [];
  return {
    cache,
    pulled,
    getInstalledVersion: overrides?.getInstalledVersion ??
      (() => Promise.resolve("2026.03.15.1")),
    getLatestVersion: overrides?.getLatestVersion ??
      (() => Promise.resolve("2026.03.30.1")),
    pullExtension: overrides?.pullExtension ?? ((name, version) => {
      pulled.push(`${name}@${version}`);
      return Promise.resolve();
    }),
    cacheRepository: overrides?.cacheRepository ?? {
      read: () => Promise.resolve(cache),
      write: (data) => {
        Object.assign(cache, data);
        return Promise.resolve();
      },
    },
    detectLocalEdits: overrides?.detectLocalEdits,
  };
}

Deno.test("maybeAutoUpdateDatastoreExtension: skips non-@swamp/ extensions", async () => {
  const deps = createMockDeps();
  const result = await maybeAutoUpdateDatastoreExtension(
    "@myorg/custom-store",
    deps,
  );
  assertEquals(result, null);
  assertEquals(deps.pulled.length, 0);
});

Deno.test("maybeAutoUpdateDatastoreExtension: skips when cache is fresh", async () => {
  const deps = createMockDeps();
  deps.cache["@swamp/s3-datastore"] = {
    checkedAt: new Date().toISOString(),
    latestVersion: "2026.03.30.1",
  };
  const result = await maybeAutoUpdateDatastoreExtension(
    "@swamp/s3-datastore",
    deps,
  );
  assertEquals(result, null);
  assertEquals(deps.pulled.length, 0);
});

Deno.test("maybeAutoUpdateDatastoreExtension: pulls when update available", async () => {
  const deps = createMockDeps();
  const result = await maybeAutoUpdateDatastoreExtension(
    "@swamp/s3-datastore",
    deps,
  );
  assertEquals(result?.updated, true);
  assertEquals(result?.previousVersion, "2026.03.15.1");
  assertEquals(result?.newVersion, "2026.03.30.1");
  assertEquals(deps.pulled, ["@swamp/s3-datastore@2026.03.30.1"]);
});

Deno.test("maybeAutoUpdateDatastoreExtension: returns not-updated when already at latest", async () => {
  const deps = createMockDeps({
    getInstalledVersion: () => Promise.resolve("2026.03.30.1"),
    getLatestVersion: () => Promise.resolve("2026.03.30.1"),
  });
  const result = await maybeAutoUpdateDatastoreExtension(
    "@swamp/s3-datastore",
    deps,
  );
  assertEquals(result?.updated, false);
  assertEquals(deps.pulled.length, 0);
});

Deno.test("maybeAutoUpdateDatastoreExtension: skips when no installed version", async () => {
  const deps = createMockDeps({
    getInstalledVersion: () => Promise.resolve(null),
  });
  const result = await maybeAutoUpdateDatastoreExtension(
    "@swamp/s3-datastore",
    deps,
  );
  assertEquals(result, null);
});

Deno.test("maybeAutoUpdateDatastoreExtension: handles registry error gracefully", async () => {
  const deps = createMockDeps({
    getLatestVersion: () => Promise.resolve(null),
  });
  const result = await maybeAutoUpdateDatastoreExtension(
    "@swamp/s3-datastore",
    deps,
  );
  assertEquals(result, null);
  // Cache should still be updated to avoid retrying immediately
  assertEquals(
    deps.cache["@swamp/s3-datastore"]?.latestVersion,
    "2026.03.15.1",
  );
});

Deno.test("maybeAutoUpdateDatastoreExtension: handles pull error gracefully", async () => {
  const deps = createMockDeps({
    pullExtension: () => Promise.reject(new Error("network error")),
  });
  const result = await maybeAutoUpdateDatastoreExtension(
    "@swamp/s3-datastore",
    deps,
  );
  // Returns null on error, doesn't throw
  assertEquals(result, null);
});

Deno.test("maybeAutoUpdateDatastoreExtension: checks again after 24h", async () => {
  const deps = createMockDeps();
  const staleTime = new Date(Date.now() - CHECK_INTERVAL_MS - 1000);
  deps.cache["@swamp/s3-datastore"] = {
    checkedAt: staleTime.toISOString(),
    latestVersion: "2026.03.15.1",
  };
  const result = await maybeAutoUpdateDatastoreExtension(
    "@swamp/s3-datastore",
    deps,
  );
  assertEquals(result?.updated, true);
  assertEquals(deps.pulled, ["@swamp/s3-datastore@2026.03.30.1"]);
});

Deno.test("maybeAutoUpdateDatastoreExtension: proceeds when detectLocalEdits returns match", async () => {
  const deps = createMockDeps({
    detectLocalEdits: () => Promise.resolve("match"),
  });
  const result = await maybeAutoUpdateDatastoreExtension(
    "@swamp/s3-datastore",
    deps,
  );
  assertEquals(result?.updated, true);
  assertEquals(result?.skipped, undefined);
  assertEquals(deps.pulled, ["@swamp/s3-datastore@2026.03.30.1"]);
});

Deno.test("maybeAutoUpdateDatastoreExtension: refuses when detectLocalEdits returns mismatch", async () => {
  const deps = createMockDeps({
    detectLocalEdits: () => Promise.resolve("mismatch"),
  });
  const result = await maybeAutoUpdateDatastoreExtension(
    "@swamp/s3-datastore",
    deps,
  );
  assertEquals(result?.updated, false);
  assertEquals(result?.skipped, "local_edits");
  assertEquals(result?.previousVersion, "2026.03.15.1");
  assertEquals(result?.newVersion, "2026.03.30.1");
  // Must NOT invoke pullExtension — the whole point of the refusal.
  assertEquals(deps.pulled.length, 0);
});

Deno.test("maybeAutoUpdateDatastoreExtension: grandfathers when detectLocalEdits returns no-anchor", async () => {
  const deps = createMockDeps({
    detectLocalEdits: () => Promise.resolve("no-anchor"),
  });
  const result = await maybeAutoUpdateDatastoreExtension(
    "@swamp/s3-datastore",
    deps,
  );
  assertEquals(result?.updated, true);
  assertEquals(result?.skipped, undefined);
  assertEquals(deps.pulled, ["@swamp/s3-datastore@2026.03.30.1"]);
});
