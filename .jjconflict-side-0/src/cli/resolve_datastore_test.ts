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

import { assertEquals, assertThrows } from "@std/assert";
import {
  parseDatastoreEnvVar,
  resolveDatastoreConfig,
} from "./resolve_datastore.ts";
import type { RepoMarkerData } from "../infrastructure/persistence/repo_marker_repository.ts";

Deno.test("parseDatastoreEnvVar - parses filesystem path", () => {
  const config = parseDatastoreEnvVar("filesystem:/data/my-project");
  assertEquals(config.type, "filesystem");
  if (config.type === "filesystem") {
    assertEquals(config.path, "/data/my-project");
  }
});

Deno.test("parseDatastoreEnvVar - parses s3 bucket with prefix", () => {
  const config = parseDatastoreEnvVar("s3:my-bucket/my-prefix", "test-repo");
  assertEquals(config.type, "s3");
  if (config.type === "s3") {
    assertEquals(config.bucket, "my-bucket");
    assertEquals(config.prefix, "my-prefix");
  }
});

Deno.test("parseDatastoreEnvVar - parses s3 bucket without prefix", () => {
  const config = parseDatastoreEnvVar("s3:my-bucket", "test-repo");
  assertEquals(config.type, "s3");
  if (config.type === "s3") {
    assertEquals(config.bucket, "my-bucket");
    assertEquals(config.prefix, undefined);
  }
});

Deno.test("parseDatastoreEnvVar - throws on invalid format", () => {
  assertThrows(
    () => parseDatastoreEnvVar("invalid"),
    Error,
    "Invalid SWAMP_DATASTORE format",
  );
});

Deno.test("parseDatastoreEnvVar - throws on invalid type", () => {
  assertThrows(
    () => parseDatastoreEnvVar("gcs:bucket"),
    Error,
    "Invalid SWAMP_DATASTORE type",
  );
});

Deno.test("parseDatastoreEnvVar - throws on invalid S3 bucket name", () => {
  assertThrows(
    () => parseDatastoreEnvVar("s3:INVALID_BUCKET"),
    Error,
    "Invalid S3 bucket name",
  );
});

Deno.test("resolveDatastoreConfig - default is filesystem at .swamp/", () => {
  const config = resolveDatastoreConfig(null, undefined, "/repo");
  assertEquals(config.type, "filesystem");
  if (config.type === "filesystem") {
    assertEquals(config.path, "/repo/.swamp");
  }
});

Deno.test("resolveDatastoreConfig - env var takes priority", () => {
  const originalEnv = Deno.env.get("SWAMP_DATASTORE");
  try {
    Deno.env.set("SWAMP_DATASTORE", "filesystem:/custom/path");
    const config = resolveDatastoreConfig(null, undefined, "/repo");
    assertEquals(config.type, "filesystem");
    if (config.type === "filesystem") {
      assertEquals(config.path, "/custom/path");
    }
  } finally {
    if (originalEnv) {
      Deno.env.set("SWAMP_DATASTORE", originalEnv);
    } else {
      Deno.env.delete("SWAMP_DATASTORE");
    }
  }
});

Deno.test("resolveDatastoreConfig - CLI arg overrides marker", () => {
  const marker: RepoMarkerData = {
    swampVersion: "0.1.0",
    initializedAt: "2024-01-01",
    repoId: "test-repo",
    datastore: { type: "filesystem", path: "/marker-path" },
  };
  const config = resolveDatastoreConfig(
    marker,
    "filesystem:/cli-path",
    "/repo",
  );
  assertEquals(config.type, "filesystem");
  if (config.type === "filesystem") {
    assertEquals(config.path, "/cli-path");
  }
});

Deno.test("resolveDatastoreConfig - marker config used when no env/cli", () => {
  const marker: RepoMarkerData = {
    swampVersion: "0.1.0",
    initializedAt: "2024-01-01",
    repoId: "test-repo",
    datastore: {
      type: "filesystem",
      path: "/marker-path",
      directories: ["data", "outputs"],
    },
  };
  const config = resolveDatastoreConfig(marker, undefined, "/repo");
  assertEquals(config.type, "filesystem");
  if (config.type === "filesystem") {
    assertEquals(config.path, "/marker-path");
    assertEquals(config.directories, ["data", "outputs"]);
  }
});
