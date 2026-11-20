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
import {
  creatingFolderName,
  deletingFolderName,
} from "../../infrastructure/persistence/hosted_workspace_folder_scan.ts";
import { unregisterCreatedWorkspace } from "./hosted_registration.ts";
import { loadWorkspaceRegistry } from "./workspace_store.ts";
import { withWorkspaceFixture } from "./workspace_test_helpers.ts";

Deno.test("loadWorkspaceRegistry: the first read passes over the hidden set-up and removal folders a host leaves in the data dir", async () => {
  await withWorkspaceFixture(async (f) => {
    const root = join(f.dataDir, "workspaces");
    await f.makeRepo(join(root, "local"));
    await f.makeRepo(join(root, creatingFolderName("fresh")));
    await f.makeRepo(join(root, deletingFolderName("old")));
    const registry = await loadWorkspaceRegistry(f.deps);
    assertEquals(registry.list().map((e) => e.name), ["local"]);
  });
});

Deno.test("unregisterCreatedWorkspace: removes the entry only while it names the folder the host created", async () => {
  await withWorkspaceFixture(async (f) => {
    const made = join(f.dataDir, "workspaces", "alpha");
    const other = join(f.dir, "projects", "alpha");
    await f.makeRepo(made);
    await f.makeRepo(other);
    await f.deps.registry.update((registry) => {
      registry.register({
        name: "alpha",
        path: other,
        createdAt: "2026-11-20T10:00:00.000Z",
        origin: "imported",
      });
    });
    assertEquals(
      (await unregisterCreatedWorkspace(f.deps, {
        name: "alpha",
        folder: made,
      }))
        .kind,
      "not_ours",
    );
    assertEquals((await f.deps.registry.load())?.get("alpha")?.path, other);
    assertEquals(
      (await unregisterCreatedWorkspace(f.deps, {
        name: "alpha",
        folder: other,
      }))
        .kind,
      "removed",
    );
    assertEquals(
      (await unregisterCreatedWorkspace(f.deps, {
        name: "alpha",
        folder: other,
      }))
        .kind,
      "absent",
    );
  });
});
