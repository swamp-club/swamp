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

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  registerHostedWorkspaces,
  unregisterHostedWorkspace,
} from "./hosted_registration.ts";
import { withWorkspaceFixture } from "./workspace_test_helpers.ts";

async function unregisteredKind(
  ...args: Parameters<typeof unregisterHostedWorkspace>
): Promise<string> {
  return (await unregisterHostedWorkspace(...args)).kind;
}

const NEWER = JSON.stringify({ schemaVersion: 99, workspaces: [] });

Deno.test("registerHostedWorkspaces: registers each folder by its real path, as an import, with no trust mark", async () => {
  await withWorkspaceFixture(async (f) => {
    const workspacesDir = join(f.dir, "host", "workspaces");
    await f.makeRepo(join(workspacesDir, "alpha"));
    await f.makeRepo(join(workspacesDir, "beta"));
    const result = await registerHostedWorkspaces(f.deps, {
      workspacesDir,
      names: ["beta", "alpha"],
    });
    assertEquals(result, {
      kind: "done",
      workspaces: [
        {
          kind: "registered",
          name: "alpha",
          folder: join(workspacesDir, "alpha"),
        },
        {
          kind: "registered",
          name: "beta",
          folder: join(workspacesDir, "beta"),
        },
      ],
    });
    assertEquals((await f.deps.registry.load())?.list(), [
      {
        name: "alpha",
        path: join(workspacesDir, "alpha"),
        createdAt: "2026-10-14T10:00:00.000Z",
        origin: "imported",
      },
      {
        name: "beta",
        path: join(workspacesDir, "beta"),
        createdAt: "2026-10-14T10:00:00.000Z",
        origin: "imported",
      },
    ]);
    const again = await registerHostedWorkspaces(f.deps, {
      workspacesDir,
      names: ["alpha"],
    });
    assertEquals(again.kind === "done" && again.workspaces[0].kind, "present");
  });
});

Deno.test("registerHostedWorkspaces: a registry it creates adopts the repos under the data dir first", async () => {
  await withWorkspaceFixture(async (f) => {
    await f.makeRepo(join(f.dataDir, "workspaces", "local"));
    const workspacesDir = join(f.dir, "host", "workspaces");
    await f.makeRepo(join(workspacesDir, "alpha"));
    await registerHostedWorkspaces(f.deps, { workspacesDir, names: ["alpha"] });
    const registry = await f.deps.registry.load();
    assertEquals(registry?.get("local")?.origin, "created");
    assertEquals(registry?.get("alpha")?.origin, "imported");
  });
});

Deno.test("registerHostedWorkspaces: writes no file when nothing is lacking, and skips a folder that is gone", async () => {
  await withWorkspaceFixture(async (f) => {
    const workspacesDir = join(f.dir, "host", "workspaces");
    await Deno.mkdir(workspacesDir, { recursive: true });
    assertEquals(
      await registerHostedWorkspaces(f.deps, {
        workspacesDir,
        names: ["gone"],
      }),
      { kind: "done", workspaces: [] },
    );
    assertEquals(await f.deps.registry.load(), null);
  });
});

Deno.test("registerHostedWorkspaces: a name or folder registered otherwise is a clash and the registry is unchanged", async () => {
  await withWorkspaceFixture(async (f) => {
    const workspacesDir = join(f.dir, "host", "workspaces");
    const elsewhere = join(f.dir, "elsewhere");
    await f.makeRepo(elsewhere);
    await f.makeRepo(join(workspacesDir, "alpha"));
    await f.makeRepo(join(workspacesDir, "beta"));
    await f.deps.registry.update((r) => {
      r.register({ name: "alpha", path: elsewhere, createdAt: "t" });
      r.register({
        name: "renamed",
        path: join(workspacesDir, "beta"),
        createdAt: "t",
      });
    });
    const file = join(f.dir, "config", "workspaces.json");
    const before = await Deno.readTextFile(file);
    assertEquals(
      await registerHostedWorkspaces(f.deps, {
        workspacesDir,
        names: ["alpha", "beta"],
      }),
      {
        kind: "done",
        workspaces: [
          {
            kind: "name_elsewhere",
            name: "alpha",
            folder: join(workspacesDir, "alpha"),
            registeredFolder: elsewhere,
          },
          {
            kind: "folder_elsewhere",
            name: "beta",
            folder: join(workspacesDir, "beta"),
            registeredName: "renamed",
          },
        ],
      },
    );
    assertEquals(await Deno.readTextFile(file), before);
  });
});

Deno.test("registerHostedWorkspaces: an entry another process registers for the same folder meanwhile is present, not a clash", async () => {
  await withWorkspaceFixture(async (f) => {
    const workspacesDir = join(f.dir, "host", "workspaces");
    const folder = join(workspacesDir, "alpha");
    await f.makeRepo(folder);
    await f.deps.registry.update(() => {});
    const registry = f.deps.registry;
    let raced = false;
    const deps = {
      ...f.deps,
      registry: {
        load: () => registry.load(),
        update: async <T>(change: Parameters<typeof registry.update<T>>[0]) => {
          if (!raced) {
            raced = true;
            await registry.update((r) =>
              r.register({ name: "alpha", path: folder, createdAt: "root" })
            );
          }
          return await registry.update(change);
        },
      },
    };
    assertEquals(
      await registerHostedWorkspaces(deps, { workspacesDir, names: ["alpha"] }),
      {
        kind: "done",
        workspaces: [{ kind: "present", name: "alpha", folder }],
      },
    );
    assertEquals((await registry.load())?.get("alpha")?.createdAt, "root");
  });
});

Deno.test("registerHostedWorkspaces: an unreadable registry is reported and never written", async () => {
  for (const content of ["{nope", NEWER]) {
    await withWorkspaceFixture(async (f) => {
      const workspacesDir = join(f.dir, "host", "workspaces");
      await f.makeRepo(join(workspacesDir, "alpha"));
      const file = join(f.dir, "config", "workspaces.json");
      await Deno.mkdir(join(f.dir, "config"));
      await Deno.writeTextFile(file, content);
      const result = await registerHostedWorkspaces(f.deps, {
        workspacesDir,
        names: ["alpha"],
      });
      assertEquals(result.kind, "unreadable");
      assertEquals(await Deno.readTextFile(file), content);
      assertEquals(
        await unregisteredKind(f.deps, {
          workspacesDir,
          name: "alpha",
        }),
        "unreadable",
      );
      assertEquals(await Deno.readTextFile(file), content);
    });
  }
});

Deno.test("unregisterHostedWorkspace: removes only an entry for the folder of that name inside the host's workspaces", async () => {
  await withWorkspaceFixture(async (f) => {
    const workspacesDir = join(f.dir, "host", "workspaces");
    await Deno.mkdir(workspacesDir, { recursive: true });
    assertEquals(
      await unregisteredKind(f.deps, { workspacesDir, name: "alpha" }),
      "absent",
    );
    assertEquals(await f.deps.registry.load(), null);
    await f.deps.registry.update((r) => {
      r.register({
        name: "alpha",
        path: join(workspacesDir, "alpha"),
        createdAt: "t",
      });
      r.register({ name: "mine", path: join(f.dir, "mine"), createdAt: "t" });
      r.register({
        name: "other",
        path: join(workspacesDir, "different"),
        createdAt: "t",
      });
    });
    for (const name of ["mine", "other"]) {
      assertEquals(
        await unregisteredKind(f.deps, { workspacesDir, name }),
        "not_ours",
      );
    }
    assertEquals(
      await unregisteredKind(f.deps, { workspacesDir, name: "alpha" }),
      "removed",
    );
    assertEquals(
      (await f.deps.registry.load())?.list().map((e) => e.name),
      ["mine", "other"],
    );
  });
});

Deno.test("unregisterHostedWorkspace: a write that cannot take the lock rejects, so the caller retries", async () => {
  await withWorkspaceFixture(async (f) => {
    const workspacesDir = join(f.dir, "host", "workspaces");
    await f.deps.registry.update((r) =>
      r.register({
        name: "alpha",
        path: join(workspacesDir, "alpha"),
        createdAt: "t",
      })
    );
    const deps = {
      ...f.deps,
      registry: {
        load: () => f.deps.registry.load(),
        update: () => Promise.reject(new Error("lock timed out")),
      },
    };
    await assertRejects(
      () => unregisterHostedWorkspace(deps, { workspacesDir, name: "alpha" }),
      Error,
      "lock timed out",
    );
  });
});
