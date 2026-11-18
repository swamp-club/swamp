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

/** writes only the repo marker, which is what makes a folder a workspace */
export const markerProvisioner: HostedWorkspaceProvisioner = {
  async provision(dir) {
    await Deno.writeTextFile(join(dir, ".swamp.yaml"), "");
  },
};

export interface HostFolder extends AsyncDisposable {
  readonly dir: string;
  deps(overrides?: Partial<HostedWorkspaceDeps>): HostedWorkspaceDeps;
}

export async function hostFolder(): Promise<HostFolder> {
  const root = await Deno.makeTempDir();
  const dir = join(root, "workspaces");
  await Deno.mkdir(dir);
  let tick = Date.parse("2026-11-17T10:00:00.000Z");
  return {
    dir,
    deps: (overrides = {}) => ({
      ...createHostedWorkspaceDeps({
        workspacesDir: dir,
        provisioner: markerProvisioner,
        addressOf: (name) => `https://host.example/w/${name}`,
      }),
      repository: new HostedWorkspaceFileRepository(dir),
      // each call a second later, so every write has its own changedAt
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
}

export async function entries(dir: string): Promise<string[]> {
  return (await Array.fromAsync(Deno.readDir(dir))).map((e) => e.name).sort();
}
