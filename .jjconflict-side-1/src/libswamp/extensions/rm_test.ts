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

import { assertEquals, assertRejects } from "@std/assert";
import { assertCompletes, assertErrors, collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  extensionRm,
  type ExtensionRmDeps,
  type ExtensionRmEvent,
  extensionRmPreview,
  type UpstreamMap,
} from "./rm.ts";
import { UserError } from "../../domain/errors.ts";

function fakeCtx() {
  return createLibSwampContext();
}

function fakeDeps(
  overrides: Partial<ExtensionRmDeps> = {},
): ExtensionRmDeps {
  const defaultUpstream: UpstreamMap = {
    "@test/ext": {
      version: "1.0.0",
      pulledAt: "2026-01-01T00:00:00Z",
      files: ["models/ext/model.yaml", "models/ext/model.ts"],
    },
  };

  return {
    readUpstreamExtensions: () => Promise.resolve(defaultUpstream),
    findDependents: () => Promise.resolve([]),
    removeFile: () => Promise.resolve(),
    readDirEntries: () => Promise.resolve([]),
    removeDir: () => Promise.resolve(),
    removeUpstreamExtension: () => Promise.resolve(),
    modelsDir: "/fake/models",
    repoDir: "/fake/repo",
    ...overrides,
  };
}

Deno.test("extensionRmPreview: returns preview for installed extension", async () => {
  const ctx = fakeCtx();
  const deps = fakeDeps();

  const preview = await extensionRmPreview(ctx, deps, {
    extensionName: "@test/ext",
  });

  assertEquals(preview.name, "@test/ext");
  assertEquals(preview.version, "1.0.0");
  assertEquals(preview.fileCount, 2);
  assertEquals(preview.dependents, []);
});

Deno.test("extensionRmPreview: includes dependents", async () => {
  const ctx = fakeCtx();
  const deps = fakeDeps({
    findDependents: () => Promise.resolve(["@test/other"]),
  });

  const preview = await extensionRmPreview(ctx, deps, {
    extensionName: "@test/ext",
  });

  assertEquals(preview.dependents, ["@test/other"]);
});

Deno.test("extensionRmPreview: throws not_found for missing extension", async () => {
  const ctx = fakeCtx();
  const deps = fakeDeps({
    readUpstreamExtensions: () => Promise.resolve({}),
  });

  await assertRejects(
    () => extensionRmPreview(ctx, deps, { extensionName: "@test/missing" }),
    UserError,
    "is not installed",
  );
});

Deno.test("extensionRmPreview: throws validation_failed when no file tracking", async () => {
  const ctx = fakeCtx();
  const deps = fakeDeps({
    readUpstreamExtensions: () =>
      Promise.resolve({
        "@test/ext": {
          version: "1.0.0",
          pulledAt: "2026-01-01T00:00:00Z",
        },
      }),
  });

  await assertRejects(
    () => extensionRmPreview(ctx, deps, { extensionName: "@test/ext" }),
    UserError,
    "file tracking",
  );
});

Deno.test("extensionRm: deletes files and yields completed", async () => {
  const removedFiles: string[] = [];
  let upstreamRemoved = false;

  const ctx = fakeCtx();
  const deps = fakeDeps({
    removeFile: (path: string) => {
      removedFiles.push(path);
      return Promise.resolve();
    },
    // Return non-empty so dirs aren't pruned
    readDirEntries: () =>
      Promise.resolve([
        {
          name: "other.txt",
          isFile: true,
          isDirectory: false,
          isSymlink: false,
        },
      ]),
    removeUpstreamExtension: () => {
      upstreamRemoved = true;
      return Promise.resolve();
    },
  });

  await assertCompletes<ExtensionRmEvent>(
    extensionRm(ctx, deps, { extensionName: "@test/ext" }),
    {
      kind: "completed",
      data: {
        name: "@test/ext",
        version: "1.0.0",
        filesDeleted: 2,
        filesSkipped: 0,
        dirsRemoved: 0,
      },
    },
  );

  assertEquals(removedFiles.length, 2);
  assertEquals(upstreamRemoved, true);
});

Deno.test("extensionRm: counts skipped files when NotFound", async () => {
  const ctx = fakeCtx();
  const deps = fakeDeps({
    removeFile: () => {
      throw new Deno.errors.NotFound("not found");
    },
  });

  await assertCompletes<ExtensionRmEvent>(
    extensionRm(ctx, deps, { extensionName: "@test/ext" }),
    {
      kind: "completed",
      data: {
        name: "@test/ext",
        version: "1.0.0",
        filesDeleted: 0,
        filesSkipped: 2,
        dirsRemoved: 0,
      },
    },
  );
});

Deno.test("extensionRm: yields error for missing extension", async () => {
  const ctx = fakeCtx();
  const deps = fakeDeps({
    readUpstreamExtensions: () => Promise.resolve({}),
  });

  await assertErrors<ExtensionRmEvent>(
    extensionRm(ctx, deps, { extensionName: "@test/missing" }),
    "not_found",
  );
});

Deno.test("extensionRm: events include deleting then completed", async () => {
  const ctx = fakeCtx();
  const deps = fakeDeps();

  const events = await collect(
    extensionRm(ctx, deps, { extensionName: "@test/ext" }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0].kind, "deleting");
  assertEquals(events[1].kind, "completed");
});
