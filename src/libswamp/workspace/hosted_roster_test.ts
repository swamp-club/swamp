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
import { join, SEPARATOR } from "@std/path";
import {
  type WorkspaceEntry,
  WorkspaceRegistry,
} from "../../domain/workspace/workspace_registry.ts";
import { hostedWorkspaceFolders, readHostedRegistry } from "./hosted_roster.ts";
import { withWorkspaceFixture } from "./workspace_test_helpers.ts";

function registryOf(
  ...entries: { name: string; path: string }[]
): WorkspaceRegistry {
  return WorkspaceRegistry.fromEntries(
    entries.map((entry): WorkspaceEntry => ({
      ...entry,
      createdAt: "2026-10-14T10:00:00.000Z",
    })),
  );
}

Deno.test("hostedWorkspaceFolders: an entry at its own scanned folder gives that folder", async () => {
  await withWorkspaceFixture(async (f) => {
    const workspacesDir = join(f.dir, "host", "workspaces");
    await f.makeRepo(join(workspacesDir, "alpha"));
    const folders = await hostedWorkspaceFolders({
      workspacesDir,
      scanned: ["alpha"],
      registry: registryOf({
        name: "alpha",
        path: join(workspacesDir, "alpha"),
      }),
    });
    assertEquals(folders, [{
      name: "alpha",
      folder: join(workspacesDir, "alpha"),
    }]);
  });
});

Deno.test("hostedWorkspaceFolders: an entry naming its folder by another spelling is one workspace at the real path", async () => {
  await withWorkspaceFixture(async (f) => {
    const workspacesDir = join(f.dir, "host", "workspaces");
    await f.makeRepo(join(workspacesDir, "alpha"));
    await f.makeRepo(join(workspacesDir, "beta"));
    const folders = await hostedWorkspaceFolders({
      workspacesDir,
      scanned: ["alpha", "beta"],
      registry: registryOf(
        {
          name: "alpha",
          path: [workspacesDir, "..", "workspaces", "alpha"].join(SEPARATOR),
        },
        { name: "beta", path: join(workspacesDir, "beta") + SEPARATOR },
      ),
    });
    assertEquals(folders, [
      { name: "alpha", folder: join(workspacesDir, "alpha") },
      { name: "beta", folder: join(workspacesDir, "beta") },
    ]);
  });
});

Deno.test({
  name:
    "hostedWorkspaceFolders: a linked folder registered at its target is served from the target's real path",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withWorkspaceFixture(async (f) => {
      const workspacesDir = join(f.dir, "host", "workspaces");
      const target = join(f.dir, "elsewhere", "repo");
      await f.makeRepo(target);
      await Deno.mkdir(workspacesDir, { recursive: true });
      await Deno.symlink(target, join(workspacesDir, "linked"), {
        type: "dir",
      });
      const folders = await hostedWorkspaceFolders({
        workspacesDir,
        scanned: ["linked"],
        registry: registryOf({ name: "linked", path: target }),
      });
      assertEquals(folders, [{ name: "linked", folder: target }]);

      // retargeted, the entry no longer names the folder there
      const other = join(f.dir, "elsewhere", "other");
      await f.makeRepo(other);
      await Deno.remove(join(workspacesDir, "linked"));
      await Deno.symlink(other, join(workspacesDir, "linked"), {
        type: "dir",
      });
      assertEquals(
        await hostedWorkspaceFolders({
          workspacesDir,
          scanned: ["linked"],
          registry: registryOf({ name: "linked", path: target }),
        }),
        [{ name: "linked", folder: join(workspacesDir, "linked") }],
      );
    });
  },
});

Deno.test("hostedWorkspaceFolders: entries outside the scanned folders are passed over", async () => {
  await withWorkspaceFixture(async (f) => {
    const workspacesDir = join(f.dir, "host", "workspaces");
    await f.makeRepo(join(workspacesDir, "alpha"));
    await f.makeRepo(join(f.dir, "projects", "outside"));
    const folders = await hostedWorkspaceFolders({
      workspacesDir,
      scanned: ["alpha"],
      registry: registryOf(
        { name: "outside", path: join(f.dir, "projects", "outside") },
        // inside workspaces/, but no folder the scan lists
        { name: "gone", path: join(workspacesDir, "gone") },
      ),
    });
    assertEquals(folders, [{
      name: "alpha",
      folder: join(workspacesDir, "alpha"),
    }]);
  });
});

Deno.test("hostedWorkspaceFolders: a folder registered under another name, or whose name is registered elsewhere, keeps its own name and folder", async () => {
  await withWorkspaceFixture(async (f) => {
    const workspacesDir = join(f.dir, "host", "workspaces");
    await f.makeRepo(join(workspacesDir, "alpha"));
    await f.makeRepo(join(workspacesDir, "beta"));
    await f.makeRepo(join(f.dir, "projects", "beta"));
    const folders = await hostedWorkspaceFolders({
      workspacesDir,
      scanned: ["alpha", "beta"],
      registry: registryOf(
        { name: "renamed", path: join(workspacesDir, "alpha") },
        { name: "beta", path: join(f.dir, "projects", "beta") },
      ),
    });
    assertEquals(folders, [
      { name: "alpha", folder: join(workspacesDir, "alpha") },
      { name: "beta", folder: join(workspacesDir, "beta") },
    ]);
  });
});

Deno.test("hostedWorkspaceFolders: with no registry every scanned folder is a workspace at its own folder", async () => {
  const workspacesDir = join(SEPARATOR, "host", "workspaces");
  assertEquals(
    await hostedWorkspaceFolders({
      workspacesDir,
      scanned: ["beta", "alpha"],
      registry: null,
      realPath: () => Promise.reject(new Error("not resolved")),
    }),
    [
      { name: "alpha", folder: join(workspacesDir, "alpha") },
      { name: "beta", folder: join(workspacesDir, "beta") },
    ],
  );
});

Deno.test("hostedWorkspaceFolders: a scanned folder gone before it resolves keeps its own folder", async () => {
  await withWorkspaceFixture(async (f) => {
    const workspacesDir = join(f.dir, "host", "workspaces");
    await f.makeRepo(join(f.dir, "elsewhere"));
    const folders = await hostedWorkspaceFolders({
      workspacesDir,
      scanned: ["vanished"],
      registry: registryOf({
        name: "vanished",
        path: join(f.dir, "elsewhere"),
      }),
    });
    assertEquals(folders, [{
      name: "vanished",
      folder: join(workspacesDir, "vanished"),
    }]);
  });
});

Deno.test("readHostedRegistry: reads without writing, and a missing file is no registry", async () => {
  await withWorkspaceFixture(async (f) => {
    await f.makeRepo(join(f.dataDir, "workspaces", "local"));
    assertEquals(await readHostedRegistry(f.deps), {
      kind: "read",
      registry: null,
    });
    // a read adopts nothing, so no file appears
    assertEquals(await exists(join(f.dir, "config", "workspaces.json")), false);
  });
});

Deno.test("readHostedRegistry: a corrupt file, a newer schema and a folder in its place are all unreadable", async () => {
  await withWorkspaceFixture(async (f) => {
    const file = join(f.dir, "config", "workspaces.json");
    await Deno.mkdir(join(f.dir, "config"), { recursive: true });
    for (
      const write of [
        () => Deno.writeTextFile(file, "{not json"),
        () =>
          Deno.writeTextFile(
            file,
            JSON.stringify({ schemaVersion: 99, workspaces: [] }),
          ),
        async () => {
          await Deno.remove(file);
          await Deno.mkdir(file);
        },
      ]
    ) {
      await write();
      assertEquals((await readHostedRegistry(f.deps)).kind, "unreadable");
    }
  });
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
