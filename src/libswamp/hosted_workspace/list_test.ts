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
import { dirname, join } from "@std/path";
import { writeHostedWorkspaceStatus } from "../../infrastructure/persistence/hosted_workspace_status_file.ts";
import { assertCompletes, collect } from "../testing.ts";
import { hostedWorkspaceCreate } from "./create.ts";
import {
  hostedWorkspaceList,
  type HostedWorkspaceListData,
  type HostedWorkspaceListEvent,
} from "./list.ts";
import {
  ALICE,
  ctx,
  OAUTH_ACCESS,
  testHost,
} from "./hosted_workspace_test_helpers.ts";

Deno.test("hostedWorkspaceList: lists workspaces and wanted files with their addresses and states", async () => {
  await using host = await testHost();
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
  // created suspended before its folder appears
  await Deno.writeTextFile(
    join(host.dir, "pending.wanted.yaml"),
    "wanted: suspended\n",
  );
  await Deno.writeTextFile(join(host.dir, "broken.wanted.yaml"), "{");

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
            name: "edge-dns",
            address: "https://host.example/w/edge-dns",
            wanted: "suspended",
            state: "ready",
            restarts: 1,
            reason: null,
            owner: "host",
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

Deno.test("hostedWorkspaceList: an empty state folder and registry list nothing", async () => {
  await using host = await testHost();
  await assertCompletes<HostedWorkspaceListEvent>(
    hostedWorkspaceList(ctx, host.deps()),
    { kind: "completed", data: { workspaces: [] } },
  );
});

Deno.test("hostedWorkspaceList: a repo no request created is listed as the operator's own, and a registry that cannot be read is answered from the wanted files", async () => {
  await using host = await testHost();
  const deps = host.deps();
  await collect(hostedWorkspaceCreate(ctx, deps, {
    name: "edge-dns",
    caller: ALICE,
    access: OAUTH_ACCESS,
  }));
  await Deno.writeTextFile(
    join(host.dir, "pending.wanted.yaml"),
    "wanted: suspended\n",
  );
  const outside = join(dirname(host.dir), "projects", "outside");
  await Deno.mkdir(outside, { recursive: true });
  await Deno.writeTextFile(join(outside, ".swamp.yaml"), "");
  await host.store.registry.update((registry) => {
    registry.register({
      name: "outside",
      path: outside,
      createdAt: "2026-11-17T10:00:00.000Z",
    });
  });
  const listed = async (): Promise<HostedWorkspaceListData> => {
    const events = await collect(hostedWorkspaceList(ctx, deps));
    const done = events.find((e) => e.kind === "completed");
    if (done?.kind !== "completed") throw new Error("list did not complete");
    return done.data;
  };
  const owners = async () =>
    (await listed()).workspaces.map((w) => [w.name, w.owner, w.wanted]);
  assertEquals(await owners(), [
    ["edge-dns", "host", "suspended"],
    ["outside", "operator", "suspended"],
    ["pending", undefined, "suspended"],
  ]);

  await Deno.writeTextFile(
    join(dirname(host.dir), "config", "workspaces.json"),
    "{not json",
  );
  assertEquals(await owners(), [
    ["edge-dns", undefined, "suspended"],
    ["pending", undefined, "suspended"],
  ]);
});

Deno.test("hostedWorkspaceList: lists only registered repos, never a folder in the state folder", async () => {
  await using host = await testHost();
  const deps = host.deps();
  await Deno.mkdir(join(host.dir, "stray"));
  await Deno.writeTextFile(join(host.dir, "stray", ".swamp.yaml"), "");
  const outside = join(dirname(host.dir), "projects", "outside");
  await Deno.mkdir(outside, { recursive: true });
  await Deno.writeTextFile(join(outside, ".swamp.yaml"), "");
  await host.store.registry.update((registry) => {
    registry.register({
      name: "outside",
      path: outside,
      createdAt: "2026-11-17T10:00:00.000Z",
    });
  });
  const events = await collect(hostedWorkspaceList(ctx, deps));
  const done = events.find((e) => e.kind === "completed");
  if (done?.kind !== "completed") throw new Error("list did not complete");
  assertEquals(
    done.data.workspaces.map((w) => [w.name, w.owner, w.wanted]),
    [["outside", "operator", "suspended"]],
  );
});
