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

import { assertEquals, assertThrows } from "@std/assert";
import { UserError } from "../domain/errors.ts";
import { hostRootWorkspaces, provisionEnv } from "./host_root_workspaces.ts";
import { hostWorkspaceStore } from "./host/workspace_registration.ts";

// paths only: nothing in these tests writes the registry
const STORE = () =>
  hostWorkspaceStore({ dataDir: "/host/data", configDir: "/host/config" });
const NEVER = () => {
  throw new Error("a serve that is not a host's root builds no registry store");
};

const ACCESS = () => ({
  mode: "none" as const,
  oauthProvider: null,
  allowedUsers: [],
  allowedCollectives: [],
  nameCache: {},
});

Deno.test("hostRootWorkspaces: a serve given neither flag is not a host's root", () => {
  assertEquals(hostRootWorkspaces({}, {}, ACCESS, NEVER), undefined);
});

Deno.test("hostRootWorkspaces: the root's services work on the folder and name each workspace under the host's address", () => {
  const root = hostRootWorkspaces(
    {
      dir: "/host/workspaces",
      address: "https://serve.example",
    },
    {},
    ACCESS,
    STORE,
  );
  assertEquals(root?.services.workspacesDir, "/host/workspaces");
  assertEquals(root?.services.hostFolder, true);
  assertEquals(root?.services.workspaceStore.dataDir, "/host/data");
  assertEquals(
    root?.services.addressOf("edge-dns"),
    "https://serve.example/w/edge-dns",
  );
  assertEquals(root?.rootAccess(), ACCESS());
});

Deno.test("hostRootWorkspaces: one flag without the other refuses to start", () => {
  for (
    const flags of [
      { dir: "/host/workspaces" },
      { address: "https://serve.example" },
      { dir: "", address: "https://serve.example" },
    ]
  ) {
    assertThrows(
      () => hostRootWorkspaces(flags, {}, ACCESS, NEVER),
      UserError,
      "together",
    );
  }
});

Deno.test("hostRootWorkspaces: a root told the host has no host folder gets services that create no workspace", () => {
  const root = hostRootWorkspaces(
    {
      dir: "/home/op/.swamp/host",
      address: "https://serve.example",
      noFolder: true,
    },
    {},
    ACCESS,
    STORE,
  );
  assertEquals(root?.services.workspacesDir, "/home/op/.swamp/host");
  assertEquals(root?.services.hostFolder, false);
});

Deno.test("hostRootWorkspaces: the no-folder flag alone refuses to start", () => {
  assertThrows(
    () => hostRootWorkspaces({ noFolder: true }, {}, ACCESS, NEVER),
    UserError,
    "--host-no-folder",
  );
});

Deno.test("provisionEnv: drops the repo and datastore names, in any case, and keeps the rest", () => {
  assertEquals(
    provisionEnv({
      SWAMP_REPO_DIR: "/operator/repo",
      swamp_datastore: "s3://bucket",
      SWAMP_HOME: "/pinned/home",
      PATH: "/usr/bin",
    }),
    { SWAMP_HOME: "/pinned/home", PATH: "/usr/bin" },
  );
});
