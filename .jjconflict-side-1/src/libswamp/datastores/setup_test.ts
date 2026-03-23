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
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  type DatastoreSetupDeps,
  type DatastoreSetupEvent,
  datastoreSetupFilesystem,
  type DatastoreSetupFilesystemInput,
  datastoreSetupS3,
  type DatastoreSetupS3Input,
} from "./setup.ts";

function makeDeps(
  overrides: Partial<DatastoreSetupDeps> = {},
): DatastoreSetupDeps {
  return {
    requireUpgradedRepo: () => Promise.resolve(),
    verifyPath: () => Promise.resolve({ healthy: true, message: "ok" }),
    verifyS3: () => Promise.resolve({ healthy: true, message: "ok" }),
    checkS3DatastoreExists: () => Promise.resolve(false),
    ensureDir: () => Promise.resolve(),
    getDatastoreDirectories: () => ["data", "outputs"],
    migrateData: () =>
      Promise.resolve({
        filesCopied: 5,
        bytesCopied: 1024,
        directoriesMigrated: ["data", "outputs"],
        errors: [],
      }),
    verifyMigration: () =>
      Promise.resolve({ valid: true, sourceCount: 5, destCount: 5 }),
    cleanupSourceDirs: () => Promise.resolve(),
    updateRepoConfig: () => Promise.resolve(),
    pushAllToS3: () => Promise.resolve(3),
    getSwampDataDir: () => "/home/user/.swamp",
    getCachePath: (repoId: string) => `/home/user/.swamp/repos/${repoId}`,
    collapseEnvVars: (path: string) => path,
    ...overrides,
  };
}

function makeFilesystemInput(
  overrides: Partial<DatastoreSetupFilesystemInput> = {},
): DatastoreSetupFilesystemInput {
  return {
    datastorePath: "/tmp/datastore",
    repoDir: "/tmp/repo",
    skipMigration: false,
    ...overrides,
  };
}

function makeS3Input(
  overrides: Partial<DatastoreSetupS3Input> = {},
): DatastoreSetupS3Input {
  return {
    bucket: "my-bucket",
    repoDir: "/tmp/repo",
    repoId: "test-repo-id",
    skipMigration: false,
    ...overrides,
  };
}

Deno.test("datastoreSetupFilesystem: completes with migration", async () => {
  const deps = makeDeps();
  const input = makeFilesystemInput();

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupFilesystem(createLibSwampContext(), deps, input),
  );

  assertEquals(events.length, 3);
  assertEquals(events[0].kind, "validating");
  assertEquals(events[1].kind, "migrating");
  const completed = events[2] as Extract<
    DatastoreSetupEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.type, "filesystem");
  assertEquals(completed.data.path, "/tmp/datastore");
  assertEquals(completed.data.filesCopied, 5);
  assertEquals(completed.data.bytesCopied, 1024);
  assertEquals(completed.data.directoriesMigrated, ["data", "outputs"]);
  assertEquals(completed.data.errors, []);
});

Deno.test("datastoreSetupFilesystem: completes with skip migration", async () => {
  const deps = makeDeps();
  const input = makeFilesystemInput({ skipMigration: true });

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupFilesystem(createLibSwampContext(), deps, input),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0].kind, "validating");
  const completed = events[1] as Extract<
    DatastoreSetupEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.filesCopied, 0);
  assertEquals(completed.data.directoriesMigrated, []);
});

Deno.test("datastoreSetupFilesystem: errors on unhealthy path", async () => {
  const deps = makeDeps({
    verifyPath: () =>
      Promise.resolve({ healthy: false, message: "permission denied" }),
  });
  const input = makeFilesystemInput();

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupFilesystem(createLibSwampContext(), deps, input),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0].kind, "validating");
  const error = events[1] as Extract<DatastoreSetupEvent, { kind: "error" }>;
  assertEquals(error.kind, "error");
  assertEquals(error.error.code, "validation_failed");
});

Deno.test("datastoreSetupFilesystem: errors on non-upgraded repo", async () => {
  const deps = makeDeps({
    requireUpgradedRepo: () => {
      throw new Error("Run 'swamp repo upgrade' first");
    },
  });
  const input = makeFilesystemInput();

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupFilesystem(createLibSwampContext(), deps, input),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0].kind, "validating");
  const error = events[1] as Extract<DatastoreSetupEvent, { kind: "error" }>;
  assertEquals(error.kind, "error");
  assertEquals(error.error.code, "validation_failed");
});

Deno.test("datastoreSetupS3: completes with migration", async () => {
  const deps = makeDeps();
  const input = makeS3Input();

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupS3(createLibSwampContext(), deps, input),
  );

  assertEquals(events.length, 3);
  assertEquals(events[0].kind, "validating");
  assertEquals(events[1].kind, "migrating");
  const completed = events[2] as Extract<
    DatastoreSetupEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.type, "s3");
  assertEquals(completed.data.bucket, "my-bucket");
  assertEquals(completed.data.filesCopied, 3);
});

Deno.test("datastoreSetupS3: errors on existing datastore", async () => {
  const deps = makeDeps({
    checkS3DatastoreExists: () => Promise.resolve(true),
  });
  const input = makeS3Input();

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupS3(createLibSwampContext(), deps, input),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0].kind, "validating");
  const error = events[1] as Extract<DatastoreSetupEvent, { kind: "error" }>;
  assertEquals(error.kind, "error");
  assertEquals(error.error.code, "already_exists");
});

Deno.test("datastoreSetupS3: errors on unhealthy bucket", async () => {
  const deps = makeDeps({
    verifyS3: () =>
      Promise.resolve({ healthy: false, message: "access denied" }),
  });
  const input = makeS3Input();

  const events = await collect<DatastoreSetupEvent>(
    datastoreSetupS3(createLibSwampContext(), deps, input),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0].kind, "validating");
  const error = events[1] as Extract<DatastoreSetupEvent, { kind: "error" }>;
  assertEquals(error.kind, "error");
  assertEquals(error.error.code, "validation_failed");
});
