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
import { assertEquals } from "@std/assert";
import type { HostedWorkspaceWanted } from "../../domain/serve/hosted_workspace.ts";
import type { ObservedServeState } from "../../domain/serve/managed_serve.ts";
import { writeHostedWorkspaceStatus } from "../../infrastructure/persistence/hosted_workspace_status_file.ts";
import { assertCompletes, assertErrors, collect } from "../testing.ts";
import { hostedWorkspaceCreate } from "./create.ts";
import { hostedWorkspaceGet, type HostedWorkspaceGetEvent } from "./get.ts";
import {
  ALICE,
  ctx,
  hostFolder,
  OAUTH_ACCESS,
} from "./hosted_workspace_test_helpers.ts";

Deno.test("hostedWorkspaceGet: reports the state and restarts, and describes the host's reason without repeating it", async () => {
  await using host = await hostFolder();
  const deps = host.deps();
  await collect(hostedWorkspaceCreate(ctx, deps, {
    name: "edge-dns",
    caller: ALICE,
    access: OAUTH_ACCESS,
  }));
  const raw = "error: cannot open /srv/host/workspaces/edge-dns/secret.yaml";
  const cases: Array<{
    state: ObservedServeState;
    wanted: HostedWorkspaceWanted;
    reason: string | null;
    shown: string | null;
  }> = [
    {
      state: "failed",
      wanted: "active",
      reason: raw,
      shown:
        "Its serve kept exiting, so the host stopped restarting it. Resume it to try again; the host's status file for it has the details.",
    },
    {
      state: "backoff",
      wanted: "active",
      reason: raw,
      shown: "Its serve exited, and the host starts it again shortly.",
    },
    {
      state: "stopped",
      wanted: "deleted",
      reason: raw,
      shown:
        "Removing it failed, and the host tries again at every rescan. The host's status file for it has the details.",
    },
    {
      state: "starting",
      wanted: "active",
      reason: raw,
      shown:
        "The host reported a problem with it. The host's status file for it has the details.",
    },
    { state: "ready", wanted: "active", reason: null, shown: null },
  ];
  for (const { state, wanted, reason, shown } of cases) {
    await writeHostedWorkspaceStatus(host.dir, "edge-dns", {
      state,
      wanted,
      restarts: 5,
      reason,
      updatedAt: "2026-11-17T10:00:00.000Z",
    });
    await assertCompletes<HostedWorkspaceGetEvent>(
      hostedWorkspaceGet(ctx, deps, { name: "edge-dns" }),
      {
        kind: "completed",
        data: {
          name: "edge-dns",
          address: "https://host.example/w/edge-dns",
          wanted: "suspended",
          state,
          restarts: 5,
          reason: shown,
          owner: "host",
        },
      },
    );
  }
});

Deno.test("hostedWorkspaceGet: a name with neither a folder nor a wanted file is not found", async () => {
  await using host = await hostFolder();
  const error = await assertErrors<HostedWorkspaceGetEvent>(
    hostedWorkspaceGet(ctx, host.deps(), { name: "edge-dns" }),
    "not_found",
  );
  assertEquals(error.message, "No hosted workspace named edge-dns.");
  await assertErrors<HostedWorkspaceGetEvent>(
    hostedWorkspaceGet(ctx, host.deps(), { name: "../x" }),
    "user_error",
  );
});

Deno.test("hostedWorkspaceGet: a repo registered outside workspaces/ is the operator's own, stopped until resumed", async () => {
  await using host = await hostFolder();
  const outside = join(host.dir, "..", "projects", "outside");
  await Deno.mkdir(outside, { recursive: true });
  await Deno.writeTextFile(join(outside, ".swamp.yaml"), "");
  await host.store.registry.update((registry) => {
    registry.register({
      name: "outside",
      path: outside,
      createdAt: "2026-11-17T10:00:00.000Z",
    });
  });
  await assertCompletes<HostedWorkspaceGetEvent>(
    hostedWorkspaceGet(ctx, host.deps(), { name: "outside" }),
    {
      kind: "completed",
      data: {
        name: "outside",
        address: "https://host.example/w/outside",
        wanted: "suspended",
        state: null,
        restarts: null,
        reason: null,
        owner: "operator",
      },
    },
  );
});

Deno.test("hostedWorkspaceGet: the root's repo is never one of the workspaces, though registered", async () => {
  await using host = await hostFolder();
  const root = join(host.dir, "..", "root");
  await Deno.mkdir(root);
  await Deno.writeTextFile(join(root, ".swamp.yaml"), "");
  await host.store.registry.update((registry) => {
    registry.register({
      name: "main",
      path: root,
      createdAt: "2026-11-17T10:00:00.000Z",
    });
  });
  await assertErrors<HostedWorkspaceGetEvent>(
    hostedWorkspaceGet(ctx, host.deps({ rootRepo: root }), { name: "main" }),
    "not_found",
  );
});
