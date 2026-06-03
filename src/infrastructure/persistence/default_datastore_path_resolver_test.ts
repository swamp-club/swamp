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

import { assertEquals } from "@std/assert";
import { DefaultDatastorePathResolver } from "./default_datastore_path_resolver.ts";
import type { DatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { assertPathEquals } from "./path_test_helpers.ts";

Deno.test("DefaultDatastorePathResolver - localPath always uses .swamp", () => {
  const config: DatastoreConfig = {
    type: "filesystem",
    path: "/data/store",
  };
  const resolver = new DefaultDatastorePathResolver("/repo", config);
  assertPathEquals(
    resolver.localPath("definitions", "foo.yaml"),
    "/repo/.swamp/definitions/foo.yaml",
  );
});

Deno.test("DefaultDatastorePathResolver - datastorePath uses configured path", () => {
  const config: DatastoreConfig = {
    type: "filesystem",
    path: "/data/store",
  };
  const resolver = new DefaultDatastorePathResolver("/repo", config);
  assertPathEquals(
    resolver.datastorePath("data", "foo"),
    "/data/store/data/foo",
  );
});

Deno.test("DefaultDatastorePathResolver - custom datastorePath uses datastorePath", () => {
  const config: DatastoreConfig = {
    type: "s3",
    config: { bucket: "my-bucket" },
    datastorePath: "/home/user/.swamp/repos/abc",
    cachePath: "/home/user/.swamp/repos/abc",
  };
  const resolver = new DefaultDatastorePathResolver("/repo", config);
  assertPathEquals(
    resolver.datastorePath("data"),
    "/home/user/.swamp/repos/abc/data",
  );
});

Deno.test("DefaultDatastorePathResolver - no always-local subdirs remain", () => {
  const config: DatastoreConfig = {
    type: "filesystem",
    path: "/data/store",
  };
  const resolver = new DefaultDatastorePathResolver("/repo", config);
  // definitions, workflows, and vault are now top-level dirs, not .swamp/ subdirs
  // They are no longer in ALWAYS_LOCAL_SUBDIRS, so if they appeared in the
  // datastore directories list they would be routed to the datastore.
  // In practice they are not in DEFAULT_DATASTORE_SUBDIRS either.
  assertEquals(resolver.isDatastoreSubdir("definitions"), false);
  assertEquals(resolver.isDatastoreSubdir("workflows"), false);
  assertEquals(resolver.isDatastoreSubdir("vault"), false);
});

Deno.test("DefaultDatastorePathResolver - default datastore subdirs are recognized", () => {
  const config: DatastoreConfig = {
    type: "filesystem",
    path: "/data/store",
  };
  const resolver = new DefaultDatastorePathResolver("/repo", config);
  assertEquals(resolver.isDatastoreSubdir("data"), true);
  assertEquals(resolver.isDatastoreSubdir("outputs"), true);
  assertEquals(resolver.isDatastoreSubdir("workflow-runs"), true);
  assertEquals(resolver.isDatastoreSubdir("audit"), true);
  assertEquals(resolver.isDatastoreSubdir("telemetry"), true);
});

Deno.test("DefaultDatastorePathResolver - custom directories list", () => {
  const config: DatastoreConfig = {
    type: "filesystem",
    path: "/data/store",
    directories: ["data", "outputs"],
  };
  const resolver = new DefaultDatastorePathResolver("/repo", config);
  assertEquals(resolver.isDatastoreSubdir("data"), true);
  assertEquals(resolver.isDatastoreSubdir("outputs"), true);
  assertEquals(resolver.isDatastoreSubdir("audit"), false);
  assertEquals(resolver.isDatastoreSubdir("telemetry"), false);
});

Deno.test("DefaultDatastorePathResolver - resolvePath routes datastore subdirs", () => {
  const config: DatastoreConfig = {
    type: "filesystem",
    path: "/data/store",
  };
  const resolver = new DefaultDatastorePathResolver("/repo", config);

  // Datastore subdir goes to datastore
  assertPathEquals(resolver.resolvePath("data", "foo"), "/data/store/data/foo");
  // Non-datastore subdir stays local (definitions is no longer always-local
  // but it's also not in DEFAULT_DATASTORE_SUBDIRS, so it stays local)
  assertPathEquals(
    resolver.resolvePath("definitions", "foo"),
    "/repo/.swamp/definitions/foo",
  );
});

Deno.test("DefaultDatastorePathResolver - resolvePath with exclude patterns", () => {
  const config: DatastoreConfig = {
    type: "filesystem",
    path: "/data/store",
    exclude: ["telemetry/**"],
  };
  const resolver = new DefaultDatastorePathResolver("/repo", config);

  // telemetry is a datastore subdir, but excluded by pattern
  assertPathEquals(
    resolver.resolvePath("telemetry", "foo.json"),
    "/repo/.swamp/telemetry/foo.json",
  );
  // data is not excluded
  assertPathEquals(resolver.resolvePath("data", "foo"), "/data/store/data/foo");
});

Deno.test("DefaultDatastorePathResolver - default config (no external datastore) keeps paths in .swamp", () => {
  const config: DatastoreConfig = {
    type: "filesystem",
    path: "/repo/.swamp",
  };
  const resolver = new DefaultDatastorePathResolver("/repo", config);

  // Both local and datastore paths resolve to .swamp
  assertPathEquals(
    resolver.resolvePath("data", "foo"),
    "/repo/.swamp/data/foo",
  );
  // definitions is not a datastore subdir, so it stays in .swamp even with default config
  assertPathEquals(
    resolver.resolvePath("definitions", "foo"),
    "/repo/.swamp/definitions/foo",
  );
});

Deno.test("DefaultDatastorePathResolver - custom datastore prefers cachePath over datastorePath", () => {
  const config: DatastoreConfig = {
    type: "s3",
    config: { bucket: "my-bucket" },
    datastorePath: "/repo/.swamp",
    cachePath: "/home/user/.swamp/repos/abc",
  };
  const resolver = new DefaultDatastorePathResolver("/repo", config);
  // Data should go to cachePath so the sync service can find it
  assertPathEquals(
    resolver.datastorePath("data"),
    "/home/user/.swamp/repos/abc/data",
  );
  assertPathEquals(
    resolver.resolvePath("data", "foo"),
    "/home/user/.swamp/repos/abc/data/foo",
  );
});

Deno.test("DefaultDatastorePathResolver - custom datastore falls back to datastorePath without cachePath", () => {
  const config: DatastoreConfig = {
    type: "custom",
    config: {},
    datastorePath: "/shared/datastore",
  };
  const resolver = new DefaultDatastorePathResolver("/repo", config);
  assertPathEquals(
    resolver.datastorePath("data"),
    "/shared/datastore/data",
  );
});

Deno.test("DefaultDatastorePathResolver - config returns the stored config", () => {
  const config: DatastoreConfig = {
    type: "filesystem",
    path: "/data/store",
  };
  const resolver = new DefaultDatastorePathResolver("/repo", config);
  assertEquals(resolver.config(), config);
});

Deno.test("DefaultDatastorePathResolver - bundle subdirs are recognized as datastore subdirs", () => {
  const config: DatastoreConfig = {
    type: "filesystem",
    path: "/data/store",
  };
  const resolver = new DefaultDatastorePathResolver("/repo", config);
  assertEquals(resolver.isDatastoreSubdir("bundles"), true);
  assertEquals(resolver.isDatastoreSubdir("vault-bundles"), true);
  assertEquals(resolver.isDatastoreSubdir("driver-bundles"), true);
  // datastore-bundles intentionally excluded — bootstrap ordering
  assertEquals(resolver.isDatastoreSubdir("datastore-bundles"), false);
  assertEquals(resolver.isDatastoreSubdir("report-bundles"), true);
});

Deno.test("DefaultDatastorePathResolver - resolvePath routes bundles to S3 cache", () => {
  const config: DatastoreConfig = {
    type: "s3",
    config: { bucket: "my-bucket" },
    datastorePath: "/repo/.swamp",
    cachePath: "/home/user/.swamp/repos/abc",
  };
  const resolver = new DefaultDatastorePathResolver("/repo", config);

  assertPathEquals(
    resolver.resolvePath("bundles", "2e4ea9ae", "aws/logs.js"),
    "/home/user/.swamp/repos/abc/bundles/2e4ea9ae/aws/logs.js",
  );
  assertPathEquals(
    resolver.resolvePath("vault-bundles", "ff00aa11", "sm.js"),
    "/home/user/.swamp/repos/abc/vault-bundles/ff00aa11/sm.js",
  );
  assertPathEquals(
    resolver.resolvePath("driver-bundles", "bb22cc33", "driver.js"),
    "/home/user/.swamp/repos/abc/driver-bundles/bb22cc33/driver.js",
  );
  // datastore-bundles stays local (bootstrap ordering — excluded from datastore tier)
  assertPathEquals(
    resolver.resolvePath("datastore-bundles", "dd44ee55", "ds.js"),
    "/repo/.swamp/datastore-bundles/dd44ee55/ds.js",
  );
  assertPathEquals(
    resolver.resolvePath("report-bundles", "66778899", "report.js"),
    "/home/user/.swamp/repos/abc/report-bundles/66778899/report.js",
  );
});

Deno.test("DefaultDatastorePathResolver - filesystem datastore resolves bundles to same local path", () => {
  const config: DatastoreConfig = {
    type: "filesystem",
    path: "/repo/.swamp",
  };
  const resolver = new DefaultDatastorePathResolver("/repo", config);

  // With default filesystem datastore, bundles stay in .swamp/ (same path)
  assertPathEquals(
    resolver.resolvePath("bundles", "2e4ea9ae", "aws/logs.js"),
    "/repo/.swamp/bundles/2e4ea9ae/aws/logs.js",
  );
});

// ── Giga-swamp namespace prefixing (Phase 3) ────────────────────────────────

Deno.test("DefaultDatastorePathResolver - namespace prepends as outermost datastore segment", () => {
  const config: DatastoreConfig = {
    type: "filesystem",
    path: "/data/store",
    namespace: "infra",
  };
  const resolver = new DefaultDatastorePathResolver("/repo", config);
  // {base}/{namespace}/data/... — NOT {base}/data/{namespace}/...
  assertPathEquals(
    resolver.datastorePath("data", "aws/ec2/vpc"),
    "/data/store/infra/data/aws/ec2/vpc",
  );
  assertPathEquals(
    resolver.resolvePath("data", "aws/ec2/vpc"),
    "/data/store/infra/data/aws/ec2/vpc",
  );
});

Deno.test("DefaultDatastorePathResolver - empty namespace is byte-identical to solo mode", () => {
  const solo: DatastoreConfig = { type: "filesystem", path: "/data/store" };
  const explicit: DatastoreConfig = {
    type: "filesystem",
    path: "/data/store",
    namespace: "",
  };
  const soloResolver = new DefaultDatastorePathResolver("/repo", solo);
  const explicitResolver = new DefaultDatastorePathResolver("/repo", explicit);

  // No prefix, no leading separator, no double slash.
  assertPathEquals(soloResolver.datastorePath("data"), "/data/store/data");
  assertPathEquals(explicitResolver.datastorePath("data"), "/data/store/data");
  assertPathEquals(
    explicitResolver.resolvePath("outputs", "run-1"),
    "/data/store/outputs/run-1",
  );
});

Deno.test("DefaultDatastorePathResolver - namespace never affects localPath (.swamp)", () => {
  const config: DatastoreConfig = {
    type: "filesystem",
    path: "/data/store",
    namespace: "security",
  };
  const resolver = new DefaultDatastorePathResolver("/repo", config);
  // The repo-local tier is private to the repo and never namespaced.
  assertPathEquals(
    resolver.localPath("secrets", "vault", "key"),
    "/repo/.swamp/secrets/vault/key",
  );
});

Deno.test("DefaultDatastorePathResolver - namespace prefixes the custom-datastore cache tier", () => {
  const config: DatastoreConfig = {
    type: "s3",
    config: { bucket: "my-bucket" },
    datastorePath: "/home/user/.swamp/repos/abc",
    cachePath: "/home/user/.swamp/repos/abc",
    namespace: "platform",
  };
  const resolver = new DefaultDatastorePathResolver("/repo", config);
  // Cache mirrors the namespaced remote layout so sync needs no translation.
  assertPathEquals(
    resolver.resolvePath("data", "result"),
    "/home/user/.swamp/repos/abc/platform/data/result",
  );
});

Deno.test("DefaultDatastorePathResolver - exclude patterns match the un-prefixed relative path under a namespace", () => {
  const config: DatastoreConfig = {
    type: "filesystem",
    path: "/data/store",
    namespace: "infra",
    exclude: ["data/scratch/**"],
  };
  const resolver = new DefaultDatastorePathResolver("/repo", config);
  // Excluded paths fall back to local tier (and are therefore not namespaced).
  assertPathEquals(
    resolver.resolvePath("data", "scratch", "tmp.json"),
    "/repo/.swamp/data/scratch/tmp.json",
  );
  // Non-excluded data is namespaced in the datastore tier.
  assertPathEquals(
    resolver.resolvePath("data", "keep", "v.json"),
    "/data/store/infra/data/keep/v.json",
  );
});
