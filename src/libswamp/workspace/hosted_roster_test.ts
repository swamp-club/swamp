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
import { HostedWorkspace } from "../../domain/serve/hosted_workspace.ts";
import {
  freshFolderClaim,
  type HostedRoster,
  hostedWorkspaceFolders,
  readHostedRegistry,
  registryOfRead,
  wantedFolderOf,
} from "./hosted_roster.ts";
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

const listed = (roster: HostedRoster) =>
  roster.workspaces.map(({ name, folder, owner }) => ({ name, folder, owner }));

Deno.test("hostedWorkspaceFolders: an entry at its own scanned folder is the host's own at that folder", async () => {
  await withWorkspaceFixture(async (f) => {
    const workspacesDir = join(f.dir, "host", "workspaces");
    await f.makeRepo(join(workspacesDir, "alpha"));
    const roster = await hostedWorkspaceFolders({
      workspacesDir,
      scanned: ["alpha"],
      registry: registryOf({
        name: "alpha",
        path: join(workspacesDir, "alpha"),
      }),
      rootRepo: null,
    });
    assertEquals(roster, {
      workspaces: [{
        name: "alpha",
        folder: join(workspacesDir, "alpha"),
        owner: "host",
        isRepo: true,
        fromWantedFile: false,
        shadows: false,
      }],
      gone: [],
      passedOver: [],
      registered: new Set(["alpha"]),
    });
  });
});

Deno.test("hostedWorkspaceFolders: an entry naming its folder by another spelling is one workspace at the real path", async () => {
  await withWorkspaceFixture(async (f) => {
    const workspacesDir = join(f.dir, "host", "workspaces");
    await f.makeRepo(join(workspacesDir, "alpha"));
    await f.makeRepo(join(workspacesDir, "beta"));
    const roster = await hostedWorkspaceFolders({
      workspacesDir,
      scanned: ["alpha", "beta"],
      registry: registryOf(
        {
          name: "alpha",
          path: [workspacesDir, "..", "workspaces", "alpha"].join(SEPARATOR),
        },
        { name: "beta", path: join(workspacesDir, "beta") + SEPARATOR },
      ),
      rootRepo: null,
    });
    assertEquals(listed(roster), [
      { name: "alpha", folder: join(workspacesDir, "alpha"), owner: "host" },
      { name: "beta", folder: join(workspacesDir, "beta"), owner: "host" },
    ]);
  });
});

Deno.test({
  name:
    "hostedWorkspaceFolders: a linked folder registered at its target is the host's own; retargeted, the entry keeps the name",
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
      const registry = registryOf({ name: "linked", path: target });
      assertEquals(
        listed(
          await hostedWorkspaceFolders({
            workspacesDir,
            scanned: ["linked"],
            registry,
            rootRepo: null,
          }),
        ),
        [{ name: "linked", folder: target, owner: "host" }],
      );

      const other = join(f.dir, "elsewhere", "other");
      await f.makeRepo(other);
      await Deno.remove(join(workspacesDir, "linked"));
      await Deno.symlink(other, join(workspacesDir, "linked"), {
        type: "dir",
      });
      assertEquals(
        listed(
          await hostedWorkspaceFolders({
            workspacesDir,
            scanned: ["linked"],
            registry,
            rootRepo: null,
          }),
        ),
        [{ name: "linked", folder: target, owner: "operator" }],
      );
    });
  },
});

Deno.test("hostedWorkspaceFolders: an entry outside workspaces/ is the operator's own at its folder", async () => {
  await withWorkspaceFixture(async (f) => {
    const workspacesDir = join(f.dir, "host", "workspaces");
    const outside = join(f.dir, "projects", "outside");
    await f.makeRepo(join(workspacesDir, "alpha"));
    await f.makeRepo(outside);
    const roster = await hostedWorkspaceFolders({
      workspacesDir,
      scanned: ["alpha"],
      registry: registryOf({ name: "outside", path: outside }),
      rootRepo: null,
    });
    assertEquals(roster.workspaces, [
      {
        name: "alpha",
        folder: join(workspacesDir, "alpha"),
        owner: "host",
        isRepo: true,
        fromWantedFile: false,
        shadows: false,
      },
      {
        name: "outside",
        folder: outside,
        owner: "operator",
        isRepo: true,
        fromWantedFile: false,
        shadows: false,
      },
    ]);
  });
});

Deno.test("hostedWorkspaceFolders: an operator's folder that is gone or holds no repo is listed and not a repo", async () => {
  await withWorkspaceFixture(async (f) => {
    const workspacesDir = join(f.dir, "host", "workspaces");
    const empty = join(f.dir, "projects", "empty");
    await Deno.mkdir(empty, { recursive: true });
    const roster = await hostedWorkspaceFolders({
      workspacesDir,
      scanned: [],
      registry: registryOf(
        { name: "empty", path: empty },
        { name: "removed", path: join(f.dir, "projects", "removed") },
      ),
      rootRepo: null,
    });
    assertEquals(
      roster.workspaces.map(({ name, owner, isRepo }) => ({
        name,
        owner,
        isRepo,
      })),
      [
        { name: "empty", owner: "operator", isRepo: false },
        { name: "removed", owner: "operator", isRepo: false },
      ],
    );
  });
});

Deno.test("hostedWorkspaceFolders: the root's repo is never a workspace, however it is registered", async () => {
  await withWorkspaceFixture(async (f) => {
    const workspacesDir = join(f.dir, "host", "workspaces");
    const root = join(f.dir, "host", "root");
    await f.makeRepo(root);
    const roster = await hostedWorkspaceFolders({
      workspacesDir,
      scanned: [],
      registry: registryOf({ name: "main", path: root + SEPARATOR }),
      rootRepo: [f.dir, "host", ".", "root"].join(SEPARATOR),
    });
    assertEquals(roster.workspaces, []);
  });
});

Deno.test("hostedWorkspaceFolders: a folder in workspaces/ whose name or folder another entry has is not listed; the entry is", async () => {
  await withWorkspaceFixture(async (f) => {
    const workspacesDir = join(f.dir, "host", "workspaces");
    await f.makeRepo(join(workspacesDir, "alpha"));
    await f.makeRepo(join(workspacesDir, "beta"));
    await f.makeRepo(join(f.dir, "projects", "beta"));
    const roster = await hostedWorkspaceFolders({
      workspacesDir,
      scanned: ["alpha", "beta"],
      registry: registryOf(
        { name: "renamed", path: join(workspacesDir, "alpha") },
        { name: "beta", path: join(f.dir, "projects", "beta") },
      ),
      rootRepo: null,
    });
    assertEquals(listed(roster), [
      {
        name: "beta",
        folder: join(f.dir, "projects", "beta"),
        owner: "operator",
      },
      {
        name: "renamed",
        folder: join(workspacesDir, "alpha"),
        owner: "operator",
      },
    ]);
  });
});

Deno.test("hostedWorkspaceFolders: an entry for a workspaces/<name> folder that is gone is not listed and is reported gone", async () => {
  await withWorkspaceFixture(async (f) => {
    const workspacesDir = join(f.dir, "host", "workspaces");
    await f.makeRepo(join(workspacesDir, "alpha"));
    // no marker yet: not listed, and not gone either
    await Deno.mkdir(join(workspacesDir, "settling"));
    const registry = registryOf(
      { name: "alpha", path: join(workspacesDir, "alpha") },
      { name: "gone", path: join(workspacesDir, "gone") },
      { name: "settling", path: join(workspacesDir, "settling") },
    );
    const roster = await hostedWorkspaceFolders({
      workspacesDir,
      scanned: ["alpha"],
      registry,
      rootRepo: null,
    });
    assertEquals(roster.workspaces.map(({ name }) => name), ["alpha"]);
    assertEquals(roster.gone, ["gone"]);

    const empty = await hostedWorkspaceFolders({
      workspacesDir,
      scanned: [],
      registry,
      rootRepo: null,
    });
    assertEquals(empty.workspaces, []);
    assertEquals(empty.gone, []);
  });
});

Deno.test("hostedWorkspaceFolders: with no registry read, the scanned folders and each active wanted file naming a repo folder", async () => {
  await withWorkspaceFixture(async (f) => {
    const workspacesDir = join(f.dir, "host", "workspaces");
    const root = join(f.dir, "host", "root");
    const named = join(f.dir, "projects", "named");
    await f.makeRepo(root);
    await f.makeRepo(named);
    await f.makeRepo(join(f.dir, "projects", "paused"));
    await Deno.mkdir(join(f.dir, "projects", "bare"), { recursive: true });
    const wanted = new Map([
      ["named", HostedWorkspace.active("named").withFolder(named)],
      [
        "paused",
        HostedWorkspace.active("paused").withFolder(
          join(f.dir, "projects", "paused"),
        ).suspend(new Date()),
      ],
      [
        "bare",
        HostedWorkspace.active("bare").withFolder(
          join(f.dir, "projects", "bare"),
        ),
      ],
      ["main", HostedWorkspace.active("main").withFolder(root)],
      ["plain", HostedWorkspace.active("plain")],
    ]);
    const roster = await hostedWorkspaceFolders({
      workspacesDir,
      scanned: ["beta", "alpha"],
      registry: null,
      rootRepo: root,
      wanted,
    });
    assertEquals(roster.workspaces, [
      {
        name: "alpha",
        folder: join(workspacesDir, "alpha"),
        owner: "host",
        isRepo: true,
        fromWantedFile: false,
        shadows: false,
      },
      {
        name: "beta",
        folder: join(workspacesDir, "beta"),
        owner: "host",
        isRepo: true,
        fromWantedFile: false,
        shadows: false,
      },
      {
        name: "named",
        folder: named,
        owner: "operator",
        isRepo: true,
        fromWantedFile: true,
        shadows: false,
      },
    ]);
  });
});

Deno.test("hostedWorkspaceFolders: an entry with a name no workspace may have is passed over", async () => {
  await withWorkspaceFixture(async (f) => {
    const workspacesDir = join(f.dir, "host", "workspaces");
    const registry = registryOf({
      name: "Not_A_Name",
      path: join(f.dir, "projects", "odd"),
    });
    const roster = await hostedWorkspaceFolders({
      workspacesDir,
      scanned: [],
      registry,
      rootRepo: null,
    });
    assertEquals(roster.workspaces, []);
  });
});

Deno.test("registryOfRead: a missing file is an empty registry, and one that cannot be read is none", () => {
  assertEquals(
    registryOfRead({ kind: "read", registry: null })?.list(),
    [],
  );
  assertEquals(registryOfRead({ kind: "unreadable", reason: "bad" }), null);
});

Deno.test("wantedFolderOf: a wanted file with no folder stands for workspaces/<name>", () => {
  const workspacesDir = join(SEPARATOR, "host", "workspaces");
  assertEquals(
    wantedFolderOf(workspacesDir, HostedWorkspace.active("alpha")),
    join(workspacesDir, "alpha"),
  );
  assertEquals(
    wantedFolderOf(
      workspacesDir,
      HostedWorkspace.active("alpha").withFolder(join(SEPARATOR, "srv", "a")),
    ),
    join(SEPARATOR, "srv", "a"),
  );
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

Deno.test("hostedWorkspaceFolders: an entry whose name is also a folder in workspaces/ shadows it", async () => {
  await withWorkspaceFixture(async (f) => {
    const workspacesDir = join(f.dir, "host", "workspaces");
    await f.makeRepo(join(workspacesDir, "alpha"));
    await f.makeRepo(join(f.dir, "ext", "alpha"));
    await f.makeRepo(join(f.dir, "ext", "other"));
    const roster = await hostedWorkspaceFolders({
      workspacesDir,
      scanned: ["alpha"],
      registry: registryOf(
        { name: "alpha", path: join(f.dir, "ext", "alpha") },
        { name: "other", path: join(f.dir, "ext", "other") },
      ),
      rootRepo: null,
    });
    assertEquals(
      roster.workspaces.map(({ name, shadows }) => [name, shadows]),
      [["alpha", true], ["other", false]],
    );
  });
});

Deno.test({
  name:
    "hostedWorkspaceFolders: a folder an entry took is passed over, and one that is the root's repo is not offered",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withWorkspaceFixture(async (f) => {
      const workspacesDir = join(f.dir, "host", "workspaces");
      const root = join(f.dir, "host", "root");
      await f.makeRepo(root);
      await f.makeRepo(join(workspacesDir, "alpha"));
      await f.makeRepo(join(workspacesDir, "gamma"));
      await f.makeRepo(join(f.dir, "ext", "alpha"));
      await Deno.symlink(root, join(workspacesDir, "rooted"), { type: "dir" });
      const roster = await hostedWorkspaceFolders({
        workspacesDir,
        scanned: ["alpha", "gamma", "rooted"],
        registry: registryOf(
          { name: "alpha", path: join(f.dir, "ext", "alpha") },
          { name: "beta", path: join(workspacesDir, "gamma") },
        ),
        rootRepo: root,
      });
      assertEquals(roster.passedOver, ["alpha", "gamma"]);
      assertEquals([...roster.registered].sort(), ["alpha", "beta"]);
    });
  },
});

Deno.test("freshFolderClaim: names another entry holding workspaces/<name>, ignores its own, and defers when the registry cannot be read", async () => {
  await withWorkspaceFixture(async (f) => {
    const workspacesDir = join(f.dir, "host", "workspaces");
    await f.makeRepo(join(workspacesDir, "gamma"));
    const folder = await Deno.realPath(join(workspacesDir, "gamma"));
    const claim = () =>
      freshFolderClaim({ store: f.deps, workspacesDir, name: "gamma" });
    assertEquals(await claim(), null);
    await f.deps.registry.update((registry) => {
      registry.register({ name: "gamma", path: folder, createdAt: "t" });
    });
    assertEquals(await claim(), null);
    await f.deps.registry.update((registry) => {
      registry.remove("gamma");
      registry.register({ name: "beta", path: folder, createdAt: "t" });
    });
    assertEquals(await claim(), "it is registered as beta");
    await Deno.writeTextFile(join(f.dir, "config", "workspaces.json"), "{no");
    assertEquals(await claim(), null);
  });
});

Deno.test("hostedWorkspaceFolders: with no host folder, every entry is the operator's own, one in the state folder included, and none is gone", async () => {
  await withWorkspaceFixture(async (f) => {
    const stateDir = join(f.dir, "data", "host");
    const outside = join(f.dir, "projects", "outside");
    const inState = join(stateDir, "alpha");
    const root = join(f.dir, "projects", "root");
    await f.makeRepo(outside);
    await f.makeRepo(inState);
    await f.makeRepo(root);
    const roster = await hostedWorkspaceFolders({
      workspacesDir: stateDir,
      hostFolder: false,
      scanned: [],
      registry: registryOf(
        { name: "alpha", path: inState },
        { name: "gone", path: join(stateDir, "gone") },
        { name: "outside", path: outside },
        { name: "root", path: root },
      ),
      rootRepo: root,
    });
    assertEquals(listed(roster), [
      { name: "alpha", folder: inState, owner: "operator" },
      { name: "gone", folder: join(stateDir, "gone"), owner: "operator" },
      { name: "outside", folder: outside, owner: "operator" },
    ]);
    assertEquals(
      roster.workspaces.find((w) => w.name === "gone")?.isRepo,
      false,
    );
    assertEquals(roster.gone, []);
    assertEquals(roster.passedOver, []);
  });
});
