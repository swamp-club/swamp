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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { UserError } from "../src/domain/errors.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { assertPathEquals } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { VERSION } from "../src/infrastructure/runtime/build_info.ts";
import { WorkspaceRegistryFileRepository } from "../src/infrastructure/persistence/workspace_registry_file_repository.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { collect } from "../src/libswamp/testing.ts";
import { workspaceCreate } from "../src/libswamp/workspace/create.ts";
import {
  withWorkspaceCreateLock,
  type WorkspaceDeps,
} from "../src/libswamp/workspace/deps.ts";
import { workspaceRemove } from "../src/libswamp/workspace/remove.ts";
import { createWorkspaceCreateHandlers } from "../src/presentation/renderers/workspace.ts";
import {
  resolveRootWorkspace,
  ROOT_WORKSPACE_NAME,
  type RootWorkspaceCreator,
  rootWorkspaceLocation,
} from "../src/serve/host/root_workspace.ts";
import { parseWorkspaceCreateOutput } from "../src/serve/root_workspace_process.ts";
import {
  hostConfiguredParent,
  hostWorkspaceStore,
} from "../src/serve/host/workspace_registration.ts";

await initializeLogging({});

interface Dirs extends AsyncDisposable {
  readonly homeDir: string;
  readonly configDir: string;
  readonly dataDir: string;
  readonly stateDir: string;
}

async function dirs(): Promise<Dirs> {
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp-root-workspace-" }),
  );
  const configDir = join(dir, "config");
  const dataDir = join(dir, "data");
  const stateDir = join(dataDir, "host");
  await Deno.mkdir(configDir);
  await Deno.mkdir(stateDir, { recursive: true });
  return {
    homeDir: join(dir, "home"),
    configDir,
    dataDir,
    stateDir,
    async [Symbol.asyncDispose]() {
      if (Deno.build.os === "windows") {
        await Deno.remove(dir, { recursive: true }).catch(() => {});
      } else {
        await Deno.remove(dir, { recursive: true });
      }
    },
  };
}

/** what swamp workspace create runs, against the same two dirs the host pins its child to */
function workspaceDeps(d: Dirs): WorkspaceDeps {
  const service = new RepoService(VERSION, {
    homeDir: d.homeDir,
    configDir: d.configDir,
  });
  return {
    dataDir: d.dataDir,
    os: Deno.build.os,
    registry: new WorkspaceRegistryFileRepository(d.configDir),
    repo: {
      isRepo: async (path) => {
        try {
          return (await Deno.stat(join(path, ".swamp.yaml"))).isFile;
        } catch {
          return false;
        }
      },
      init: async (path) => {
        await service.init(RepoPath.create(path), { tools: [] });
      },
    },
    now: () => new Date(),
    configuredParent: hostConfiguredParent(d.configDir),
    enrolledTools: () => Promise.resolve([]),
    isOpenInStart: () => Promise.resolve(false),
    withCreateLock: (name, fn) => withWorkspaceCreateLock(d.dataDir, name, fn),
  };
}

/** swamp workspace create in-process, counted */
function inProcessCreator(d: Dirs): RootWorkspaceCreator & { calls: number } {
  const creator = {
    calls: 0,
    async create(name: string): Promise<string> {
      creator.calls++;
      const [event] = await collect(
        workspaceCreate(createLibSwampContext(), workspaceDeps(d), { name }),
      );
      if (event.kind === "error") throw new Error(event.error.message);
      return event.data.path;
    },
  };
  return creator;
}

function resolveIn(d: Dirs, creator: RootWorkspaceCreator) {
  const store = hostWorkspaceStore({
    dataDir: d.dataDir,
    configDir: d.configDir,
  });
  return resolveRootWorkspace({
    stateDir: d.stateDir,
    store,
    location: rootWorkspaceLocation({
      dataDir: d.dataDir,
      configuredParent: hostConfiguredParent(d.configDir),
    }),
    creator,
  });
}

Deno.test("root workspace: the first start makes a registered repo in the workspace location, and a restart finds it again", async () => {
  await using d = await dirs();
  const creator = inProcessCreator(d);
  const first = await resolveIn(d, creator);
  const expected = join(d.dataDir, "workspaces", ROOT_WORKSPACE_NAME);
  assertEquals(first.created, true);
  assertPathEquals(first.folder, expected);
  assertEquals(
    (await Deno.stat(join(expected, ".swamp.yaml"))).isFile,
    true,
  );
  await assertRejects(
    () => Deno.stat(join(expected, ".swamp", "serve.yaml")),
    Deno.errors.NotFound,
  );
  const entry = (await new WorkspaceRegistryFileRepository(d.configDir).load())
    ?.get(ROOT_WORKSPACE_NAME);
  assertPathEquals(entry?.path ?? "", expected);
  assertEquals(entry?.origin, "created");

  const again = await resolveIn(d, creator);
  assertEquals(again.created, false);
  assertPathEquals(again.folder, expected);
  assertEquals(creator.calls, 1);
});

Deno.test("root workspace: after swamp workspace remove keeps its folder, the start says how to bring it back", async () => {
  await using d = await dirs();
  const creator = inProcessCreator(d);
  const { folder } = await resolveIn(d, creator);
  const [removed] = await collect(
    workspaceRemove(createLibSwampContext(), workspaceDeps(d), {
      name: ROOT_WORKSPACE_NAME,
    }),
  );
  assertEquals(removed.kind, "completed");
  const error = await assertRejects(() => resolveIn(d, creator), UserError);
  assertStringIncludes(error.message, "a folder is already there");
  assertStringIncludes(
    error.message,
    `swamp workspace import "${folder}" --name ${ROOT_WORKSPACE_NAME}`,
  );
  assertEquals(creator.calls, 1);

  // moved aside, as the message offers: the next start makes a new one
  await Deno.rename(folder, `${folder}-old`);
  const fresh = await resolveIn(d, creator);
  assertEquals(fresh.created, true);
  assertEquals(creator.calls, 2);
});

Deno.test("root workspace: a registered root whose folder is gone is reported, never re-created", async () => {
  await using d = await dirs();
  const creator = inProcessCreator(d);
  const { folder } = await resolveIn(d, creator);
  await Deno.remove(folder, { recursive: true });
  const error = await assertRejects(() => resolveIn(d, creator), UserError);
  assertStringIncludes(error.message, "that folder is gone");
  assertEquals(creator.calls, 1);
});

Deno.test("root workspace: the creator reads the folder from swamp workspace create's own --json output", () => {
  const printed: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => printed.push(args.join(" "));
  try {
    createWorkspaceCreateHandlers("json").completed({
      kind: "completed",
      data: { name: ROOT_WORKSPACE_NAME, path: "/data/workspaces/host-root" },
    });
  } finally {
    console.log = log;
  }
  assertEquals(
    parseWorkspaceCreateOutput(printed.join("\n")),
    "/data/workspaces/host-root",
  );
});
