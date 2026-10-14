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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { workspaceCreate } from "./create.ts";
import { workspaceRemove } from "./remove.ts";
import { workspaceImport } from "./import.ts";
import { folderState } from "./workspace_store.ts";
import {
  completed,
  ctx,
  errorCode,
  errorOf,
  withWorkspaceFixture,
} from "./workspace_test_helpers.ts";

Deno.test("workspaceCreate: creates a repo under the data dir and registers it", async () => {
  await withWorkspaceFixture(async (f) => {
    const data = await completed(
      workspaceCreate(ctx, f.deps, { name: "prod" }),
    );
    const path = join(f.dataDir, "workspaces", "prod");
    assertEquals(data, { name: "prod", path });
    assertEquals(await f.deps.repo.isRepo(path), true);
    const registry = await f.deps.registry.load();
    assertEquals(registry?.get("prod")?.path, path);
    assertEquals(f.locks, ["prod"]);
  });
});

Deno.test("workspaceCreate: refuses an invalid name", async () => {
  await withWorkspaceFixture(async (f) => {
    assertEquals(
      await errorCode(workspaceCreate(ctx, f.deps, { name: "Bad Name" })),
      "invalid_name",
    );
  });
});

Deno.test("workspaceCreate: refuses a name that is registered", async () => {
  await withWorkspaceFixture(async (f) => {
    await completed(workspaceCreate(ctx, f.deps, { name: "prod" }));
    assertEquals(
      await errorCode(workspaceCreate(ctx, f.deps, { name: "prod" })),
      "name_taken",
    );
  });
});

Deno.test("workspaceCreate: refuses the folder a removed workspace left behind", async () => {
  await withWorkspaceFixture(async (f) => {
    const { path } = await completed(
      workspaceCreate(ctx, f.deps, { name: "prod" }),
    );
    await completed(workspaceRemove(ctx, f.deps, { name: "prod" }));
    assertEquals(
      await errorCode(workspaceCreate(ctx, f.deps, { name: "prod" })),
      "folder_exists",
    );
    assertEquals((await f.deps.registry.load())?.get("prod"), undefined);
    // Importing it brings it back.
    const back = await completed(workspaceImport(ctx, f.deps, { path }));
    assertEquals(back, { name: "prod", path, alreadyRegistered: false });
  });
});

Deno.test("workspaceCreate: refuses a data-dir folder imported under another name", async () => {
  await withWorkspaceFixture(async (f) => {
    // A registry exists, so the folder isn't adopted under its own name.
    await completed(workspaceCreate(ctx, f.deps, { name: "first" }));
    const path = join(f.dataDir, "workspaces", "prod");
    await f.makeRepo(path);
    await completed(workspaceImport(ctx, f.deps, { path, name: "other" }));
    const error = await errorOf(workspaceCreate(ctx, f.deps, { name: "prod" }));
    assertEquals(error.code, "folder_exists");
    assertStringIncludes(error.message, 'registered as the workspace "other"');
  });
});

Deno.test("workspaceCreate: refuses a folder that holds something else", async () => {
  await withWorkspaceFixture(async (f) => {
    // A registry exists, so nothing is adopted.
    await completed(workspaceCreate(ctx, f.deps, { name: "first" }));
    const path = join(f.dataDir, "workspaces", "prod");
    await Deno.mkdir(path, { recursive: true });
    await Deno.writeTextFile(join(path, "notes.txt"), "mine");
    assertEquals(
      await errorCode(workspaceCreate(ctx, f.deps, { name: "prod" })),
      "not_a_workspace",
    );
    assertEquals(await f.deps.repo.isRepo(path), false);
  });
});

Deno.test("workspaceCreate: an existing workspace folder is adopted by the first read, so its name is taken", async () => {
  await withWorkspaceFixture(async (f) => {
    // A folder `swamp start` made before the registry existed.
    await f.makeRepo(join(f.dataDir, "workspaces", "prod"));
    assertEquals(
      await errorCode(workspaceCreate(ctx, f.deps, { name: "prod" })),
      "name_taken",
    );
  });
});

Deno.test("workspaceCreate: fails when the name is registered elsewhere while the folder is made", async () => {
  await withWorkspaceFixture(async (f) => {
    await completed(workspaceCreate(ctx, f.deps, { name: "first" }));
    const elsewhere = join(f.dir, "code", "prod");
    await f.makeRepo(elsewhere);
    const init = f.deps.repo.init;
    const deps = {
      ...f.deps,
      repo: {
        ...f.deps.repo,
        // Another process imports a folder as "prod" meanwhile.
        init: async (path: string) => {
          await init(path);
          await completed(
            workspaceImport(ctx, f.deps, { path: elsewhere, name: "prod" }),
          );
        },
      },
    };
    const events = [];
    for await (const event of workspaceCreate(ctx, deps, { name: "prod" })) {
      events.push(event);
    }
    assertEquals(events.map((e) => e.kind), ["error"]);
    assertEquals((await f.deps.registry.load())?.get("prod")?.path, elsewhere);
    // The folder it made is removed, not left behind unregistered.
    assertEquals(
      await folderState(join(f.dataDir, "workspaces", "prod")),
      "missing",
    );
  });
});
