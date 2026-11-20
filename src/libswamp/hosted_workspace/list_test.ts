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
import { dirname, join, SEPARATOR } from "@std/path";
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
            owner: "host",
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

Deno.test("hostedWorkspaceList: an empty host folder lists nothing", async () => {
  await using host = await hostFolder();
  await assertCompletes<HostedWorkspaceListEvent>(
    hostedWorkspaceList(ctx, host.deps()),
    { kind: "completed", data: { workspaces: [] } },
  );
});

Deno.test("hostedWorkspaceList: a repo registered outside workspaces/ is listed as the operator's own, and a registry that cannot be read is answered from the folders", async () => {
  await using host = await hostFolder();
  const deps = host.deps();
  for (const name of ["alpha", "beta"]) {
    await Deno.mkdir(join(host.dir, name));
    await Deno.writeTextFile(join(host.dir, name, ".swamp.yaml"), "");
  }
  await Deno.writeTextFile(
    join(host.dir, "pending.wanted.yaml"),
    "wanted: suspended\n",
  );
  const listed = async (): Promise<HostedWorkspaceListData> => {
    const events = await collect(hostedWorkspaceList(ctx, deps));
    const done = events.find((e) => e.kind === "completed");
    if (done?.kind !== "completed") throw new Error("list did not complete");
    return done.data;
  };
  const baseline = await listed();

  const outside = join(dirname(host.dir), "projects", "outside");
  await Deno.mkdir(outside, { recursive: true });
  await Deno.writeTextFile(join(outside, ".swamp.yaml"), "");
  const real = await Deno.realPath(host.dir);
  await host.store.registry.update((registry) => {
    for (
      const [name, path] of [
        ["outside", outside],
        // one folder by another spelling, and one name registered elsewhere
        ["alpha", [real, "..", "workspaces", "alpha"].join(SEPARATOR)],
        ["beta", outside + SEPARATOR + ".."],
      ]
    ) {
      registry.register({
        name,
        path,
        createdAt: "2026-11-17T10:00:00.000Z",
      });
    }
  });
  const owners = (await listed()).workspaces.map((w) => [w.name, w.owner]);
  assertEquals(owners, [
    ["alpha", "host"],
    ["beta", "operator"],
    ["outside", "operator"],
    ["pending", undefined],
  ]);
  const outsideSummary = (await listed()).workspaces.find((w) =>
    w.name === "outside"
  );
  assertEquals(outsideSummary?.wanted, "suspended");

  await Deno.writeTextFile(
    join(dirname(host.dir), "config", "workspaces.json"),
    "{not json",
  );
  assertEquals(await listed(), baseline);
});

Deno.test("hostedWorkspaceList: a name whose folder is registered under another name says so", async () => {
  await using host = await hostFolder();
  await Deno.mkdir(join(host.dir, "gamma"));
  await Deno.writeTextFile(join(host.dir, "gamma", ".swamp.yaml"), "");
  await Deno.writeTextFile(
    join(host.dir, "gamma.wanted.yaml"),
    "wanted: active\n",
  );
  const real = await Deno.realPath(join(host.dir, "gamma"));
  await host.store.registry.update((registry) => {
    registry.register({
      name: "beta",
      path: real,
      createdAt: "2026-11-17T10:00:00.000Z",
    });
  });
  const events = await collect(hostedWorkspaceList(ctx, host.deps()));
  const done = events.find((e) => e.kind === "completed");
  if (done?.kind !== "completed") throw new Error("list did not complete");
  const gamma = done.data.workspaces.find((w) => w.name === "gamma");
  assertEquals(gamma?.owner, undefined);
  assertEquals(
    gamma?.reason,
    "Its folder is registered under another name, so it is listed under that name, not this one.",
  );
  assertEquals(
    done.data.workspaces.find((w) => w.name === "beta")?.owner,
    "operator",
  );
});
