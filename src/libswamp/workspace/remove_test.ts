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
import { workspaceList } from "./list.ts";
import { workspaceRemove } from "./remove.ts";
import {
  completed,
  ctx,
  errorCode,
  withWorkspaceFixture,
} from "./workspace_test_helpers.ts";

Deno.test("workspaceRemove: drops the entry and its trust, and keeps the folder", async () => {
  await withWorkspaceFixture(async (f) => {
    const { path } = await completed(
      workspaceCreate(ctx, f.deps, { name: "prod" }),
    );
    await f.deps.registry.update((r) =>
      r.markTrusted(path, "2026-10-14T11:00:00.000Z")
    );
    assertEquals(
      await completed(workspaceRemove(ctx, f.deps, { name: "prod" })),
      { name: "prod", path, openInStart: false },
    );
    const registry = await f.deps.registry.load();
    assertEquals(registry?.get("prod"), undefined);
    assertEquals(registry?.isTrusted(path), false);
    assertEquals(await f.deps.repo.isRepo(path), true);
  });
});

Deno.test("workspaceRemove: says when a swamp start still has it open", async () => {
  await withWorkspaceFixture(async (f) => {
    const { path } = await completed(
      workspaceCreate(ctx, f.deps, { name: "prod" }),
    );
    f.open.add(path);
    const data = await completed(
      workspaceRemove(ctx, f.deps, { name: "prod" }),
    );
    assertEquals(data.openInStart, true);
  });
});

Deno.test("workspaceRemove: an unknown name is not_found", async () => {
  await withWorkspaceFixture(async (f) => {
    assertEquals(
      await errorCode(workspaceRemove(ctx, f.deps, { name: "nope" })),
      "not_found",
    );
  });
});

Deno.test("workspaceRemove: a workspace only adopted so far stays removed", async () => {
  await withWorkspaceFixture(async (f) => {
    // Folders swamp start made before the registry existed.
    await f.makeRepo(join(f.dataDir, "workspaces", "first-workspace"));
    await f.makeRepo(join(f.dataDir, "workspaces", "second"));
    await completed(
      workspaceRemove(ctx, f.deps, { name: "first-workspace" }),
    );
    const { workspaces } = await completed(workspaceList(ctx, f.deps));
    assertEquals(workspaces.map((w) => w.name), ["second"]);
  });
});
