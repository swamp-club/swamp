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
import { writeHostedWorkspaceStatus } from "../../infrastructure/persistence/hosted_workspace_status_file.ts";
import { assertCompletes, collect } from "../testing.ts";
import { hostedWorkspaceCreate } from "./create.ts";
import { hostedWorkspaceList, type HostedWorkspaceListEvent } from "./list.ts";
import {
  ALICE,
  ctx,
  hostFolder,
  OAUTH_ACCESS,
} from "./hosted_workspace_test_helpers.ts";

Deno.test("hostedWorkspaceList: lists folders and wanted files with their addresses and states", async () => {
  await using host = await hostFolder();
  const deps = host.deps();
  await collect(hostedWorkspaceCreate(ctx, deps, {
    name: "edge-dns",
    caller: ALICE,
    access: OAUTH_ACCESS,
  }));
  await writeHostedWorkspaceStatus(host.dir, "edge-dns", {
    state: "ready",
    wanted: "active",
    restarts: 1,
    reason: null,
    updatedAt: "2026-11-17T10:00:00.000Z",
  });
  // made by hand: a folder with no wanted file is active
  await Deno.mkdir(join(host.dir, "by-hand"));
  await Deno.writeTextFile(join(host.dir, "by-hand", ".swamp.yaml"), "");
  // created suspended before its folder appears
  await Deno.writeTextFile(
    join(host.dir, "pending.wanted.yaml"),
    "wanted: suspended\n",
  );
  await Deno.writeTextFile(join(host.dir, "broken.wanted.yaml"), "{");
  await Deno.mkdir(join(host.dir, "not-a-repo"));

  await assertCompletes<HostedWorkspaceListEvent>(
    hostedWorkspaceList(ctx, deps),
    {
      kind: "completed",
      data: {
        workspaces: [
          {
            name: "broken",
            address: "https://host.example/w/broken",
            wanted: null,
            state: null,
            restarts: null,
            reason:
              "Its wanted file cannot be read, so the host leaves it as it is.",
          },
          {
            name: "by-hand",
            address: "https://host.example/w/by-hand",
            wanted: "active",
            state: null,
            restarts: null,
            reason: null,
          },
          {
            name: "edge-dns",
            address: "https://host.example/w/edge-dns",
            wanted: "active",
            state: "ready",
            restarts: 1,
            reason: null,
          },
          {
            name: "pending",
            address: "https://host.example/w/pending",
            wanted: "suspended",
            state: null,
            restarts: null,
            reason: null,
          },
        ],
      },
    },
  );
});

Deno.test("hostedWorkspaceList: an empty host folder lists nothing", async () => {
  await using host = await hostFolder();
  await assertCompletes<HostedWorkspaceListEvent>(
    hostedWorkspaceList(ctx, host.deps()),
    { kind: "completed", data: { workspaces: [] } },
  );
});
