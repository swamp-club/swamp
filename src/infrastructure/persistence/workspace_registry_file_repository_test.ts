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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { errorPaths, UserError } from "../../domain/errors.ts";
import { WorkspaceRegistryFileRepository } from "./workspace_registry_file_repository.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-registry-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("WorkspaceRegistryFileRepository: null before anything is written, then round-trips", async () => {
  await withTempDir(async (dir) => {
    const repo = new WorkspaceRegistryFileRepository(dir);
    assertEquals(await repo.load(), null);
    await repo.update((r) =>
      r.register({
        name: "a",
        path: "/w/a",
        createdAt: "2026-10-11T00:00:00.000Z",
      })
    );
    assertEquals((await repo.load())?.list().map((e) => e.path), ["/w/a"]);
    if (Deno.build.os !== "windows") {
      const mode = (await Deno.stat(join(dir, "workspaces.json"))).mode!;
      assertEquals(mode & 0o777, 0o600);
    }
  });
});

Deno.test("WorkspaceRegistryFileRepository: an unreadable file is an error naming it, never missing", async () => {
  const entry = { name: "a", path: "/w/a", createdAt: "t" };
  const unreadable = [
    "{nope",
    JSON.stringify({ schemaVersion: 1, workspaces: "x" }),
    JSON.stringify({ schemaVersion: 2, workspaces: [entry] }),
    JSON.stringify({ schemaVersion: 1, workspaces: [entry, entry] }),
    JSON.stringify({
      schemaVersion: 1,
      workspaces: [entry, { ...entry, name: "b" }],
    }),
  ];
  for (const content of unreadable) {
    await withTempDir(async (dir) => {
      const file = join(dir, "workspaces.json");
      await Deno.writeTextFile(file, content);
      const repo = new WorkspaceRegistryFileRepository(dir);
      const error = await assertRejects(() => repo.load(), UserError);
      assertEquals((error as UserError).code, "registry_unreadable");
      assertStringIncludes(error.message, file);
      assertEquals(errorPaths(error), [file]);
    });
  }
});

Deno.test("WorkspaceRegistryFileRepository.update: never writes over an unreadable file", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "workspaces.json");
    const content = JSON.stringify({
      schemaVersion: 2,
      workspaces: [{ name: "imported", path: "/src/app", createdAt: "t" }],
    });
    await Deno.writeTextFile(file, content);
    const repo = new WorkspaceRegistryFileRepository(dir);
    let ran = false;
    await assertRejects(
      () =>
        repo.update((r) => {
          ran = true;
          r.register({ name: "a", path: "/w/a", createdAt: "t" });
        }),
      UserError,
      "newer version",
    );
    assertEquals(ran, false);
    assertEquals(await Deno.readTextFile(file), content);
  });
});

Deno.test("WorkspaceRegistryFileRepository: persists trustedAt, and loads files written without it", async () => {
  await withTempDir(async (dir) => {
    const repo = new WorkspaceRegistryFileRepository(dir);
    await repo.update((r) => {
      r.register({ name: "a", path: "/w/a", createdAt: "t" });
      r.register({ name: "b", path: "/w/b", createdAt: "t" });
      r.markTrusted("/w/a", "2026-10-11T01:00:00.000Z");
    });
    const loaded = await repo.load();
    assertEquals(loaded?.isTrusted("/w/a"), true);
    assertEquals(loaded?.isTrusted("/w/b"), false);
    assertEquals(loaded?.get("b")?.trustedAt, undefined);
  });
});

Deno.test("WorkspaceRegistryFileRepository: persists the last agent, and drops one it can't use without refusing the file", async () => {
  await withTempDir(async (dir) => {
    const repo = new WorkspaceRegistryFileRepository(dir);
    await repo.update((r) => {
      r.register({ name: "a", path: "/w/a", createdAt: "t" });
    });
    assertEquals((await repo.load())?.lastAgent(), undefined);
    await repo.update((r) => r.rememberAgent("codex"));
    assertEquals((await repo.load())?.lastAgent(), "codex");
    // Registry changes that aren't about the agent keep it.
    await repo.update((r) => r.markTrusted("/w/a", "t"));
    assertEquals((await repo.load())?.lastAgent(), "codex");

    await Deno.writeTextFile(
      join(dir, "workspaces.json"),
      JSON.stringify({
        schemaVersion: 1,
        workspaces: [{ name: "a", path: "/w/a", createdAt: "t" }],
        lastAgent: 42,
      }),
    );
    const loaded = await repo.load();
    assertEquals(loaded?.lastAgent(), undefined);
    assertEquals(loaded?.list().map((e) => e.name), ["a"]);
  });
});

Deno.test("WorkspaceRegistryFileRepository: persists origin, loads files without it, and drops an unknown one", async () => {
  await withTempDir(async (dir) => {
    const repo = new WorkspaceRegistryFileRepository(dir);
    await repo.update((r) => {
      r.register({
        name: "made",
        path: "/w/made",
        createdAt: "2026-10-14T00:00:00.000Z",
        origin: "created",
      });
      r.register({
        name: "mine",
        path: "/w/mine",
        createdAt: "2026-10-14T00:00:00.000Z",
        origin: "imported",
      });
    });
    const loaded = await repo.load();
    assertEquals(loaded?.get("made")?.origin, "created");
    assertEquals(loaded?.get("mine")?.origin, "imported");

    await Deno.writeTextFile(
      join(dir, "workspaces.json"),
      JSON.stringify({
        schemaVersion: 1,
        workspaces: [
          { name: "old", path: "/w/old", createdAt: "2026-10-01T00:00:00Z" },
          {
            name: "odd",
            path: "/w/odd",
            createdAt: "2026-10-01T00:00:00Z",
            origin: "cloned",
          },
        ],
      }),
    );
    const legacy = await repo.load();
    assertEquals(legacy?.get("old")?.origin, undefined);
    assertEquals(legacy?.get("odd")?.origin, undefined);
    assertEquals(legacy?.get("odd")?.path, "/w/odd");
  });
});
