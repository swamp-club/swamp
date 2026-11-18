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
import { hostRootWorkspaces } from "./host_root_workspaces.ts";

const ACCESS = () => ({
  mode: "none" as const,
  oauthProvider: null,
  allowedUsers: [],
  allowedCollectives: [],
  nameCache: {},
});

Deno.test("hostRootWorkspaces: a serve given neither flag is not a host's root", () => {
  assertEquals(hostRootWorkspaces({}, {}, ACCESS), undefined);
});

Deno.test("hostRootWorkspaces: the root's services work on the folder and name each workspace under the host's address", () => {
  const root = hostRootWorkspaces(
    {
      dir: "/host/workspaces",
      address: "https://serve.example",
    },
    {},
    ACCESS,
  );
  assertEquals(root?.services.workspacesDir, "/host/workspaces");
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
      () => hostRootWorkspaces(flags, {}, ACCESS),
      UserError,
      "together",
    );
  }
});
