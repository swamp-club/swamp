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

import { assertEquals, assertNotEquals } from "@std/assert";
import { join, SEPARATOR } from "@std/path";
import {
  type WorkspaceEntry,
  WorkspaceRegistry,
} from "../../domain/workspace/workspace_registry.ts";
import { HostedWorkspace } from "../../domain/serve/hosted_workspace.ts";
import {
  createdOwnership,
  folderRepoIdentity,
  hostCreated,
  type HostedRoster,
  hostedWorkspaceFolders,
  readHostedRegistry,
  registryOfRead,
  type RepoIdentity,
  wantedFolderMatches,
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

Deno.test("hostedWorkspaceFolders: with no wanted file, every entry is the operator's own at its real path, and the root's is not listed", async () => {
  await withWorkspaceFixture(async (f) => {
    const outside = join(f.dir, "projects", "outside");
    const root = join(f.dir, "projects", "root");
    await f.makeRepo(outside);
    await f.makeRepo(root);
    const roster = await hostedWorkspaceFolders({
      registry: registryOf(
        { name: "gone", path: join(f.dir, "projects", "gone") },
        {
          name: "outside",
          path: [f.dir, "projects", "..", "projects", "outside"].join(
            SEPARATOR,
          ),
        },
        { name: "root", path: root },
      ),
      rootRepo: root,
    });
    assertEquals(roster, {
      workspaces: [
        {
          name: "gone",
          folder: join(f.dir, "projects", "gone"),
          owner: "operator",
          isRepo: false,
          fromWantedFile: false,
        },
        {
          name: "outside",
          folder: outside,
          owner: "operator",
          isRepo: true,
          fromWantedFile: false,
        },
      ],
      registered: new Set(["gone", "outside", "root"]),
    });
  });
});

Deno.test("hostedWorkspaceFolders: an operator's folder that is gone or holds no repo is listed and not a repo", async () => {
  await withWorkspaceFixture(async (f) => {
    const empty = join(f.dir, "projects", "empty");
    await Deno.mkdir(empty, { recursive: true });
    const roster = await hostedWorkspaceFolders({
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
    const root = join(f.dir, "host", "root");
    await f.makeRepo(root);
    const roster = await hostedWorkspaceFolders({
      registry: registryOf({ name: "main", path: root + SEPARATOR }),
      rootRepo: [f.dir, "host", ".", "root"].join(SEPARATOR),
    });
    assertEquals(roster.workspaces, []);
  });
});

Deno.test("hostedWorkspaceFolders: two entries for one folder list it once, under the first name; both names are registered", async () => {
  await withWorkspaceFixture(async (f) => {
    const folder = join(f.dir, "projects", "shared");
    await f.makeRepo(folder);
    const roster = await hostedWorkspaceFolders({
      registry: registryOf(
        { name: "alpha", path: folder },
        { name: "beta", path: folder + SEPARATOR },
      ),
      rootRepo: null,
    });
    assertEquals(listed(roster), [
      { name: "alpha", folder, owner: "operator" },
    ]);
    assertEquals([...roster.registered].sort(), ["alpha", "beta"]);
  });
});

Deno.test("hostedWorkspaceFolders: with no registry read, each active wanted file naming a repo folder", async () => {
  await withWorkspaceFixture(async (f) => {
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
      registry: null,
      rootRepo: root,
      wanted,
    });
    assertEquals(roster, {
      workspaces: [{
        name: "named",
        folder: named,
        owner: "operator",
        isRepo: true,
        fromWantedFile: true,
      }],
      registered: new Set<string>(),
    });
  });
});

Deno.test("hostedWorkspaceFolders: an entry with a name no workspace may have is passed over", async () => {
  await withWorkspaceFixture(async (f) => {
    const roster = await hostedWorkspaceFolders({
      registry: registryOf({
        name: "Not_A_Name",
        path: join(f.dir, "projects", "odd"),
      }),
      rootRepo: null,
    });
    assertEquals(roster.workspaces, []);
  });
});

Deno.test("wantedFolderMatches: compares the wanted file's folder with the listed one by real path, and never matches a file that names none or a name not listed", async () => {
  await withWorkspaceFixture(async (f) => {
    const folder = join(f.dir, "projects", "alpha");
    await f.makeRepo(folder);
    const named = HostedWorkspace.active("alpha").withFolder(
      [f.dir, "projects", ".", "alpha"].join(SEPARATOR),
    );
    assertEquals(
      await wantedFolderMatches({ workspace: named, listed: folder }),
      true,
    );
    assertEquals(
      await wantedFolderMatches({
        workspace: named,
        listed: join(f.dir, "projects", "other"),
      }),
      false,
    );
    assertEquals(
      await wantedFolderMatches({ workspace: named, listed: null }),
      false,
    );
    assertEquals(
      await wantedFolderMatches({
        workspace: HostedWorkspace.active("alpha"),
        listed: folder,
      }),
      false,
    );
  });
});

Deno.test("registryOfRead: a missing file is an empty registry, and one that cannot be read is none", () => {
  assertEquals(
    registryOfRead({ kind: "read", registry: null })?.list(),
    [],
  );
  assertEquals(registryOfRead({ kind: "unreadable", reason: "bad" }), null);
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

Deno.test("hostedWorkspaceFolders: an entry is the host's own only when its wanted file has a creator, names the entry's folder and records the repo in it", async () => {
  await withWorkspaceFixture(async (f) => {
    const location = join(f.dir, "data", "workspaces");
    const at = new Date("2026-11-20T10:00:00.000Z");
    const created = (name: string, folder: string, repoId = "test") =>
      HostedWorkspace.create(name, "user:sub-alice", at).withFolder(folder)
        .withRepoId(repoId);
    const names = [
      "made",
      "moved",
      "hand",
      "unnamed",
      "none",
      "replaced",
      "unrecorded",
    ];
    for (const name of names) {
      await f.makeRepo(join(location, name));
    }
    const roster = await hostedWorkspaceFolders({
      registry: registryOf(
        ...names.map((name) => ({
          name,
          path: join(location, name),
        })),
      ),
      rootRepo: null,
      wanted: new Map([
        ["made", created("made", join(location, "made"))],
        ["moved", created("moved", join(f.dir, "elsewhere", "moved"))],
        [
          "hand",
          HostedWorkspace.active("hand").withFolder(join(location, "hand")),
        ],
        ["unnamed", HostedWorkspace.create("unnamed", "user:sub-alice", at)],
        [
          "replaced",
          created("replaced", join(location, "replaced"), "an-older-repo"),
        ],
        [
          "unrecorded",
          created("unrecorded", join(location, "unrecorded")).withRepoId(null),
        ],
      ]),
    });
    assertEquals(
      roster.workspaces.map(({ name, owner, replaced }) => [
        name,
        owner,
        replaced ?? false,
      ]),
      [
        ["hand", "operator", false],
        ["made", "host", false],
        ["moved", "operator", false],
        ["none", "operator", false],
        ["replaced", "operator", true],
        ["unnamed", "operator", false],
        ["unrecorded", "operator", false],
      ],
    );
  });
});

Deno.test("hostCreated: compares the wanted file's folder with the entry's by real path, and needs a creator and a repoId", async () => {
  await withWorkspaceFixture(async (f) => {
    const real = join(f.dir, "real");
    await f.makeRepo(real);
    const link = join(f.dir, "link");
    await Deno.symlink(real, link, { type: "dir" });
    const at = new Date("2026-11-20T10:00:00.000Z");
    const made = HostedWorkspace.create("alpha", "user:sub-alice", at)
      .withRepoId("test");
    assertEquals(await hostCreated(made.withFolder(link), real), true);
    assertEquals(await hostCreated(made.withFolder(real), link), true);
    assertEquals(await hostCreated(made, real), false);
    assertEquals(
      await hostCreated(HostedWorkspace.active("alpha").withFolder(real), real),
      false,
    );
    assertEquals(
      await hostCreated(made.withFolder(join(f.dir, "other")), real),
      false,
    );
  });
});

Deno.test("createdOwnership: a folder holding another repo is replaced, an absent one is the create's own, and one it cannot read is unknown", async () => {
  await withWorkspaceFixture(async (f) => {
    const folder = join(f.dir, "alpha");
    const made = HostedWorkspace.create(
      "alpha",
      "user:sub-alice",
      new Date("2026-11-20T10:00:00.000Z"),
    ).withFolder(folder).withRepoId("repo-1");
    const as = (identity: RepoIdentity) => ({
      repoIdentity: () => Promise.resolve(identity),
    });
    assertEquals(
      await createdOwnership(made, folder, as({ kind: "absent" })),
      "host",
    );
    assertEquals(
      await createdOwnership(
        made,
        folder,
        as({ kind: "id", repoId: "repo-1" }),
      ),
      "host",
    );
    assertEquals(
      await createdOwnership(
        made,
        folder,
        as({ kind: "id", repoId: "repo-2" }),
      ),
      "replaced",
    );
    assertEquals(
      await createdOwnership(made, folder, as({ kind: "none" })),
      "operator",
    );
    assertEquals(
      await createdOwnership(made, folder, as({ kind: "unreadable" })),
      "unknown",
    );
    assertEquals(
      await createdOwnership(
        made.withRepoId(null),
        folder,
        as({ kind: "absent" }),
      ),
      "operator",
    );

    // removed and made again at the same folder while the host was stopped
    await f.makeRepo(folder);
    await Deno.writeTextFile(join(folder, ".swamp.yaml"), "repoId: repo-2\n");
    assertEquals(await createdOwnership(made, folder), "replaced");
    assertEquals(await hostCreated(made, folder), false);
  });
});

Deno.test("folderRepoIdentity: tells an absent folder, a repoId, no repoId and a marker it cannot read apart", async () => {
  await withWorkspaceFixture(async (f) => {
    const folder = join(f.dir, "alpha");
    assertEquals(await folderRepoIdentity(folder), { kind: "absent" });
    const link = join(f.dir, "dangling");
    await Deno.symlink(join(f.dir, "nowhere"), link, { type: "dir" });
    assertNotEquals((await folderRepoIdentity(link)).kind, "absent");
    await Deno.mkdir(folder);
    assertEquals(await folderRepoIdentity(folder), { kind: "none" });
    const marker = join(folder, ".swamp.yaml");
    await Deno.writeTextFile(marker, "swampVersion: x\n");
    assertEquals(await folderRepoIdentity(folder), { kind: "none" });
    await Deno.writeTextFile(marker, "repoId: repo-1\n");
    assertEquals(await folderRepoIdentity(folder), {
      kind: "id",
      repoId: "repo-1",
    });
    await Deno.writeTextFile(marker, "repoId: [unclosed\n");
    assertEquals(await folderRepoIdentity(folder), { kind: "unreadable" });
    await Deno.writeTextFile(marker, "x".repeat(64 * 1024 + 1));
    assertEquals(await folderRepoIdentity(folder), { kind: "unreadable" });
    await Deno.remove(marker);
    await Deno.mkdir(marker);
    assertEquals(await folderRepoIdentity(folder), { kind: "unreadable" });
  });
});
