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
import { workspaceGet } from "./get.ts";
import {
  completed,
  ctx,
  errorCode,
  withWorkspaceFixture,
} from "./workspace_test_helpers.ts";

Deno.test("workspaceImport: registers a repo where it is, named after its folder", async () => {
  await withWorkspaceFixture(async (f) => {
    const path = join(f.dir, "code", "My Infra");
    await f.makeRepo(path);
    assertEquals(await completed(workspaceImport(ctx, f.deps, { path })), {
      name: "my-infra",
      path,
      alreadyRegistered: false,
    });
    assertEquals((await f.deps.registry.load())?.get("my-infra")?.path, path);
  });
});

Deno.test("workspaceImport: a folder already registered answers with its name", async () => {
  await withWorkspaceFixture(async (f) => {
    const path = join(f.dir, "infra");
    await f.makeRepo(path);
    await completed(workspaceImport(ctx, f.deps, { path, name: "prod" }));
    assertEquals(
      await completed(workspaceImport(ctx, f.deps, { path: "~/infra" })),
      { name: "prod", path, alreadyRegistered: true },
    );
  });
});

Deno.test("workspaceImport: refuses a taken name, a folder that isn't a repo, and one that is gone", async () => {
  await withWorkspaceFixture(async (f) => {
    await completed(workspaceCreate(ctx, f.deps, { name: "prod" }));
    const repo = join(f.dir, "infra");
    await f.makeRepo(repo);
    assertEquals(
      await errorCode(
        workspaceImport(ctx, f.deps, { path: repo, name: "prod" }),
      ),
      "name_taken",
    );
    const plain = join(f.dir, "plain");
    await Deno.mkdir(plain);
    assertEquals(
      await errorCode(workspaceImport(ctx, f.deps, { path: plain })),
      "not_a_repo",
    );
    assertEquals(
      await errorCode(
        workspaceImport(ctx, f.deps, { path: join(f.dir, "gone") }),
      ),
      "not_found",
    );
  });
});

Deno.test("workspaceImport: records an imported repo as imported, and a data dir folder as created", async () => {
  await withWorkspaceFixture(async (f) => {
    const path = join(f.dir, "infra");
    await f.makeRepo(path);
    await completed(workspaceImport(ctx, f.deps, { path }));
    assertEquals(
      (await f.deps.registry.load())?.get("infra")?.origin,
      "imported",
    );
    assertEquals(
      (await completed(workspaceGet(ctx, f.deps, { name: "infra" }))).imported,
      true,
    );
    const leftBehind = join(f.dataDir, "workspaces", "prod");
    await f.makeRepo(leftBehind);
    await completed(workspaceImport(ctx, f.deps, { path: leftBehind }));
    assertEquals(
      (await f.deps.registry.load())?.get("prod")?.origin,
      "created",
    );
  });
});
