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
import { DefaultDatastorePathResolver } from "./default_datastore_path_resolver.ts";
import type { DatastoreConfig } from "../../domain/datastore/datastore_config.ts";

Deno.test("DefaultDatastorePathResolver - localPath always uses .swamp", () => {
  const config: DatastoreConfig = {
    type: "filesystem",
    path: "/data/store",
  };
  const resolver = new DefaultDatastorePathResolver("/repo", config);
  assertEquals(
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
  assertEquals(resolver.datastorePath("data", "foo"), "/data/store/data/foo");
});

Deno.test("DefaultDatastorePathResolver - custom datastorePath uses datastorePath", () => {
  const config: DatastoreConfig = {
    type: "s3",
    config: { bucket: "my-bucket" },
    datastorePath: "/home/user/.swamp/repos/abc",
    cachePath: "/home/user/.swamp/repos/abc",
  };
  const resolver = new DefaultDatastorePathResolver("/repo", config);
  assertEquals(
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
  assertEquals(resolver.resolvePath("data", "foo"), "/data/store/data/foo");
  // Non-datastore subdir stays local (definitions is no longer always-local
  // but it's also not in DEFAULT_DATASTORE_SUBDIRS, so it stays local)
  assertEquals(
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
  assertEquals(
    resolver.resolvePath("telemetry", "foo.json"),
    "/repo/.swamp/telemetry/foo.json",
  );
  // data is not excluded
  assertEquals(resolver.resolvePath("data", "foo"), "/data/store/data/foo");
});

Deno.test("DefaultDatastorePathResolver - default config (no external datastore) keeps paths in .swamp", () => {
  const config: DatastoreConfig = {
    type: "filesystem",
    path: "/repo/.swamp",
  };
  const resolver = new DefaultDatastorePathResolver("/repo", config);

  // Both local and datastore paths resolve to .swamp
  assertEquals(resolver.resolvePath("data", "foo"), "/repo/.swamp/data/foo");
  // definitions is not a datastore subdir, so it stays in .swamp even with default config
  assertEquals(
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
  assertEquals(
    resolver.datastorePath("data"),
    "/home/user/.swamp/repos/abc/data",
  );
  assertEquals(
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
  assertEquals(
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
