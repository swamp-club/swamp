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

Deno.test("hostedWorkspaceGet: reports the state, restarts and the host's reason", async () => {
  await using host = await hostFolder();
  const deps = host.deps();
  await collect(hostedWorkspaceCreate(ctx, deps, {
    name: "edge-dns",
    caller: ALICE,
    access: OAUTH_ACCESS,
  }));
  await writeHostedWorkspaceStatus(host.dir, "edge-dns", {
    state: "failed",
    wanted: "active",
    restarts: 5,
    reason: "exited with code 1",
    updatedAt: "2026-11-17T10:00:00.000Z",
  });
  await assertCompletes<HostedWorkspaceGetEvent>(
    hostedWorkspaceGet(ctx, deps, { name: "edge-dns" }),
    {
      kind: "completed",
      data: {
        name: "edge-dns",
        address: "https://host.example/w/edge-dns",
        wanted: "active",
        state: "failed",
        restarts: 5,
        reason: "exited with code 1",
      },
    },
  );
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
