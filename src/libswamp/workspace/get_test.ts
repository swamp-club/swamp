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
import { workspaceCreate } from "./create.ts";
import { workspaceGet } from "./get.ts";
import {
  completed,
  ctx,
  errorCode,
  withWorkspaceFixture,
} from "./workspace_test_helpers.ts";

Deno.test("workspaceGet: shows the entry, its trust, agents and whether start has it open", async () => {
  await withWorkspaceFixture(async (f) => {
    const { path } = await completed(
      workspaceCreate(ctx, f.deps, { name: "prod" }),
    );
    f.tools.set(path, ["claude", "codex"]);
    f.open.add(path);
    await f.deps.registry.update((r) =>
      r.markTrusted(path, "2026-10-14T11:00:00.000Z")
    );
    assertEquals(await completed(workspaceGet(ctx, f.deps, { name: "prod" })), {
      name: "prod",
      path,
      createdAt: "2026-10-14T10:00:00.000Z",
      imported: false,
      folder: "ok",
      trusted: true,
      enrolledTools: ["claude", "codex"],
      openInStart: true,
    });
  });
});

Deno.test("workspaceGet: a workspace whose folder is gone", async () => {
  await withWorkspaceFixture(async (f) => {
    const { path } = await completed(
      workspaceCreate(ctx, f.deps, { name: "prod" }),
    );
    f.open.add(path);
    await Deno.remove(path, { recursive: true });
    const data = await completed(workspaceGet(ctx, f.deps, { name: "prod" }));
    assertEquals(
      [data.folder, data.enrolledTools, data.openInStart],
      ["missing", [], false],
    );
  });
});

Deno.test("workspaceGet: an unknown name is not_found", async () => {
  await withWorkspaceFixture(async (f) => {
    assertEquals(
      await errorCode(workspaceGet(ctx, f.deps, { name: "nope" })),
      "not_found",
    );
  });
});
