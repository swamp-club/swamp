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
import { join } from "@std/path";
import { workspaceCreate } from "./create.ts";
import { workspaceImport } from "./import.ts";
import { workspaceList } from "./list.ts";
import {
  completed,
  ctx,
  withWorkspaceFixture,
} from "./workspace_test_helpers.ts";

Deno.test("workspaceList: no workspaces is an empty list", async () => {
  await withWorkspaceFixture(async (f) => {
    assertEquals(await completed(workspaceList(ctx, f.deps)), {
      workspaces: [],
    });
  });
});

Deno.test("workspaceList: every entry by name, flagging imports and folders that are gone", async () => {
  await withWorkspaceFixture(async (f) => {
    const prod = await completed(
      workspaceCreate(ctx, f.deps, { name: "prod" }),
    );
    const dev = await completed(workspaceCreate(ctx, f.deps, { name: "dev" }));
    const infra = join(f.dir, "code", "infra");
    await f.makeRepo(infra);
    await completed(workspaceImport(ctx, f.deps, { path: infra }));
    await Deno.remove(dev.path, { recursive: true });
    await Deno.remove(join(prod.path, ".swamp.yaml"));

    const { workspaces } = await completed(workspaceList(ctx, f.deps));
    assertEquals(
      workspaces.map((w) => [w.name, w.imported, w.folder]),
      [
        ["dev", false, "missing"],
        ["infra", true, "ok"],
        ["prod", false, "not_a_repo"],
      ],
    );
  });
});

Deno.test("workspaceList: reports the folders swamp start made without writing the registry", async () => {
  await withWorkspaceFixture(async (f) => {
    await f.makeRepo(join(f.dataDir, "workspaces", "first-workspace"));
    const { workspaces } = await completed(workspaceList(ctx, f.deps));
    assertEquals(workspaces.map((w) => w.name), ["first-workspace"]);
    assertEquals(await f.deps.registry.load(), null);
  });
});
