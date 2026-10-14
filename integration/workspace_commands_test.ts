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

// `swamp workspace` and `swamp start` share one registry and one folder
// layout: a workspace made by either is seen by the other, and a removed
// one stays removed. Real repos, real registry file, real create lock.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import {
  createStartDeps,
  startImportWorkspace,
  startListWorkspaces,
  startOpenWorkspace,
} from "../src/libswamp/start/start.ts";
import { createWorkspaceDeps } from "../src/libswamp/workspace/deps.ts";
import { workspaceCreate } from "../src/libswamp/workspace/create.ts";
import { workspaceList } from "../src/libswamp/workspace/list.ts";
import { workspaceRemove } from "../src/libswamp/workspace/remove.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";

const ctx = createLibSwampContext();

async function last<T>(events: AsyncIterable<T>): Promise<T> {
  let out: T | undefined;
  for await (const event of events) out = event;
  return out!;
}

async function withHome(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp-workspace-integration-" }),
  );
  try {
    await withMockedEnv({
      SWAMP_HOME: join(dir, "swamp"),
      SWAMP_CONFIG_DIR: join(dir, "config"),
    }, () => fn(dir));
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

function startDeps() {
  return createStartDeps({
    version: "0.0.0-test",
    checkSignedIn: () =>
      Promise.resolve({ kind: "signed_in", source: "file" } as const),
    serverUrl: "http://127.0.0.1:1",
    isRunning: () => Promise.resolve(false),
  });
}

Deno.test("workspace commands and swamp start share workspaces", async () => {
  await withHome(async (dir) => {
    const deps = createWorkspaceDeps({ version: "0.0.0-test" });

    // A workspace made by `workspace create` opens in `swamp start`.
    const created = await last(workspaceCreate(ctx, deps, { name: "prod" }));
    assertEquals(created.kind, "completed");
    const path = join(dir, "swamp", "workspaces", "prod");
    const opened = [];
    for await (
      const event of startOpenWorkspace(ctx, startDeps(), {
        workspaceName: "prod",
      })
    ) opened.push(event);
    assertEquals(opened[0], { kind: "workspace_ready", path, created: false });

    // A repo imported on the start page is listed by `workspace list`.
    const repo = join(dir, "code", "infra");
    await Deno.mkdir(repo, { recursive: true });
    await new RepoService("0.0.0-test", {
      homeDir: dir,
      configDir: join(dir, "config"),
    }).init(RepoPath.create(repo), { tools: [] });
    await startImportWorkspace(ctx, startDeps(), { path: repo });
    const listed = await last(workspaceList(ctx, deps));
    assertEquals(
      listed.kind === "completed"
        ? listed.data.workspaces.map((w) => [w.name, w.imported, w.folder])
        : listed,
      [["infra", true, "ok"], ["prod", false, "ok"]],
    );

    // A workspace removed by `workspace remove` is gone from the start page,
    // and its folder is kept.
    await last(workspaceRemove(ctx, deps, { name: "prod" }));
    const { workspaces } = await startListWorkspaces(ctx, startDeps());
    assertEquals(workspaces.map((w) => w.name), ["infra"]);
    assertEquals((await Deno.stat(join(path, ".swamp.yaml"))).isFile, true);
  });
});

Deno.test("workspace commands adopt the folders swamp start made before the registry", async () => {
  await withHome(async (dir) => {
    // An older `swamp start` made the folder and no registry.
    const deps = createWorkspaceDeps({ version: "0.0.0-test" });
    await last(workspaceCreate(ctx, deps, { name: "first-workspace" }));
    await Deno.remove(join(dir, "config", "workspaces.json"));

    const listed = await last(workspaceList(ctx, deps));
    assertEquals(
      listed.kind === "completed"
        ? listed.data.workspaces.map((w) => w.name)
        : listed,
      ["first-workspace"],
    );
    const removed = await last(
      workspaceRemove(ctx, deps, { name: "first-workspace" }),
    );
    assertEquals(removed.kind, "completed");
    const { workspaces } = await startListWorkspaces(ctx, startDeps());
    assertEquals(workspaces, []);
  });
});
