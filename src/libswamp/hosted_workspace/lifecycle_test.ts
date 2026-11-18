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

import { assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { assertErrors, collect } from "../testing.ts";
import { hostedWorkspaceCreate } from "./create.ts";
import {
  hostedWorkspaceDelete,
  type HostedWorkspaceDeleteEvent,
} from "./delete.ts";
import {
  ALICE,
  ctx,
  hostFolder,
  OAUTH_ACCESS,
} from "./hosted_workspace_test_helpers.ts";
import {
  hostedWorkspaceResume,
  type HostedWorkspaceResumeEvent,
} from "./resume.ts";
import {
  hostedWorkspaceSuspend,
  type HostedWorkspaceSuspendEvent,
} from "./suspend.ts";

async function wantedFile(
  dir: string,
  name: string,
): Promise<Record<string, unknown>> {
  return parseYaml(
    await Deno.readTextFile(join(dir, `${name}.wanted.yaml`)),
  ) as Record<string, unknown>;
}

Deno.test("hostedWorkspaceSuspend/Resume/Delete: each writes the wanted file with a new changedAt and keeps the creator", async () => {
  await using host = await hostFolder();
  const deps = host.deps();
  await collect(hostedWorkspaceCreate(ctx, deps, {
    name: "edge-dns",
    caller: ALICE,
    access: OAUTH_ACCESS,
  }));
  const seen: unknown[] = [(await wantedFile(host.dir, "edge-dns")).changedAt];
  for (
    const [run, wanted] of [
      [
        () => hostedWorkspaceSuspend(ctx, deps, { name: "edge-dns" }),
        "suspended",
      ],
      [() => hostedWorkspaceResume(ctx, deps, { name: "edge-dns" }), "active"],
      // resuming what is active is how a failed workspace starts again
      [() => hostedWorkspaceResume(ctx, deps, { name: "edge-dns" }), "active"],
      [() => hostedWorkspaceDelete(ctx, deps, { name: "edge-dns" }), "deleted"],
    ] as const
  ) {
    const events = await collect<
      | HostedWorkspaceSuspendEvent
      | HostedWorkspaceResumeEvent
      | HostedWorkspaceDeleteEvent
    >(run());
    const last = events[events.length - 1];
    assertEquals(last.kind, "completed");
    const file = await wantedFile(host.dir, "edge-dns");
    assertEquals(file.wanted, wanted);
    assertEquals(file.creator, "user:sub-alice");
    assertEquals(seen.includes(file.changedAt), false);
    seen.push(file.changedAt);
  }
});

Deno.test("hostedWorkspaceSuspend: a folder made by hand gets a wanted file with no creator", async () => {
  await using host = await hostFolder();
  await Deno.mkdir(join(host.dir, "by-hand"));
  await Deno.writeTextFile(join(host.dir, "by-hand", ".swamp.yaml"), "");
  await collect(hostedWorkspaceSuspend(ctx, host.deps(), { name: "by-hand" }));
  const file = await wantedFile(host.dir, "by-hand");
  assertEquals(file.wanted, "suspended");
  assertEquals(file.creator, null);
  assertNotEquals(file.changedAt, null);
});

Deno.test("hostedWorkspaceResume: refuses a workspace being deleted, an unknown name and an unreadable wanted file", async () => {
  await using host = await hostFolder();
  const deps = host.deps();
  await Deno.writeTextFile(
    join(host.dir, "going.wanted.yaml"),
    "wanted: deleted\n",
  );
  const deleting = await assertErrors<HostedWorkspaceResumeEvent>(
    hostedWorkspaceResume(ctx, deps, { name: "going" }),
    "user_error",
  );
  assertEquals(deleting.message.includes("being deleted"), true);
  await assertErrors<HostedWorkspaceResumeEvent>(
    hostedWorkspaceResume(ctx, deps, { name: "missing" }),
    "not_found",
  );
  await Deno.writeTextFile(join(host.dir, "broken.wanted.yaml"), "{");
  const unreadable = await assertErrors<HostedWorkspaceSuspendEvent>(
    hostedWorkspaceSuspend(ctx, deps, { name: "broken" }),
    "wanted_unreadable",
  );
  assertEquals(unreadable.message.includes(host.dir), false);
  assertEquals(
    await Deno.readTextFile(join(host.dir, "broken.wanted.yaml")),
    "{",
  );
});
