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

import { join } from "@std/path";
import { HostedWorkspaceFileRepository } from "../../infrastructure/persistence/hosted_workspace_file_repository.ts";
import { WorkspaceRegistryFileRepository } from "../../infrastructure/persistence/workspace_registry_file_repository.ts";
import type { HostedRegistryDeps } from "../workspace/hosted_registration.ts";
import { withWorkspaceCreateLock } from "../workspace/deps.ts";
import { createLibSwampContext } from "../context.ts";
import {
  createHostedWorkspaceDeps,
  type HostedWorkspaceCaller,
  type HostedWorkspaceDeps,
  type HostedWorkspaceProvisioner,
  type HostedWorkspaceRootAccess,
} from "./deps.ts";

export const ctx = createLibSwampContext();

export const ALICE: HostedWorkspaceCaller = {
  principal: "user:sub-alice",
  username: "alice",
};

export const OAUTH_ACCESS: HostedWorkspaceRootAccess = {
  mode: "oauth",
  oauthProvider: "https://club.example",
  allowedUsers: [],
  allowedCollectives: [],
  nameCache: {},
};

/** writes only the repo marker, which is what makes a folder a workspace, with a repoId as init writes */
export const markerProvisioner: HostedWorkspaceProvisioner = {
  async provision(dir) {
    await Deno.writeTextFile(
      join(dir, ".swamp.yaml"),
      `repoId: ${crypto.randomUUID()}\n`,
    );
  },
};

/** a registry and data dir of their own under `root`, never the user's */
export function tempWorkspaceStore(root: string): HostedRegistryDeps {
  return {
    dataDir: join(root, "data"),
    registry: new WorkspaceRegistryFileRepository(join(root, "config")),
    now: () => new Date("2026-11-17T10:00:00.000Z"),
    repo: {
      isRepo: async (path) => {
        try {
          return (await Deno.stat(join(path, ".swamp.yaml"))).isFile;
        } catch {
          return false;
        }
      },
    },
  };
}

export interface TestHost extends AsyncDisposable {
  readonly root: string;
  /** the state folder */
  readonly dir: string;
  /** where a create puts the repo when workspaces.dir is not set */
  readonly location: string;
  readonly store: HostedRegistryDeps;
  /** workspaces.dir as set; undefined for the data dir's own folder */
  configured: string | undefined;
  deps(overrides?: Partial<HostedWorkspaceDeps>): HostedWorkspaceDeps;
}

/** a host, its state folder, data and config dirs under one temp folder */
export async function testHost(): Promise<TestHost> {
  const root = await Deno.makeTempDir();
  const dir = join(root, "state");
  await Deno.mkdir(dir);
  const store = tempWorkspaceStore(root);
  let tick = Date.parse("2026-11-17T10:00:00.000Z");
  const host: TestHost = {
    root,
    dir,
    location: join(store.dataDir, "workspaces"),
    store,
    configured: undefined,
    deps: (overrides = {}) => ({
      ...createHostedWorkspaceDeps({
        workspacesDir: dir,
        placement: {
          configuredParent: () => Promise.resolve(host.configured),
          withCreateLock: (name, fn) =>
            withWorkspaceCreateLock(store.dataDir, name, fn),
        },
        provisioner: markerProvisioner,
        addressOf: (name) => `https://host.example/w/${name}`,
        workspaceStore: store,
      }),
      repository: new HostedWorkspaceFileRepository(dir),
      now: () => new Date(tick += 1000),
      ...overrides,
    }),
    async [Symbol.asyncDispose]() {
      if (Deno.build.os === "windows") {
        await Deno.remove(root, { recursive: true }).catch(() => {});
      } else {
        await Deno.remove(root, { recursive: true });
      }
    },
  };
  return host;
}

export async function entries(dir: string): Promise<string[]> {
  return (await Array.fromAsync(Deno.readDir(dir))).map((e) => e.name).sort();
}
