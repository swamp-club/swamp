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

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { UserError } from "../../domain/errors.ts";
import { assertErrors, collect } from "../testing.ts";
import { createHostedWorkspaceDeps, OPERATOR_WORKSPACE_CODE } from "./deps.ts";
import {
  hostedWorkspaceCreate,
  type HostedWorkspaceCreateEvent,
} from "./create.ts";
import {
  hostedWorkspaceDelete,
  type HostedWorkspaceDeleteEvent,
} from "./delete.ts";
import {
  ALICE,
  ctx,
  type HostFolder,
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

async function registerOutside(
  host: { dir: string; store: HostFolder["store"] },
  name: string,
): Promise<string> {
  const made = join(host.dir, "..", "projects", name);
  await Deno.mkdir(made, { recursive: true });
  await Deno.writeTextFile(join(made, ".swamp.yaml"), "");
  const folder = await Deno.realPath(made);
  await host.store.registry.update((registry) => {
    registry.register({
      name,
      path: folder,
      createdAt: "2026-11-17T10:00:00.000Z",
    });
  });
  return folder;
}

Deno.test("hostedWorkspaceSuspend/Resume: a registry that cannot be read still finds a folder", async () => {
  await using host = await hostFolder();
  await Deno.mkdir(join(host.dir, "by-hand"));
  await Deno.writeTextFile(join(host.dir, "by-hand", ".swamp.yaml"), "");
  await Deno.mkdir(join(host.dir, "..", "config"), { recursive: true });
  await Deno.writeTextFile(
    join(host.dir, "..", "config", "workspaces.json"),
    "{not json",
  );
  await collect(hostedWorkspaceSuspend(ctx, host.deps(), { name: "by-hand" }));
  assertEquals((await wantedFile(host.dir, "by-hand")).wanted, "suspended");
});

Deno.test("hostedWorkspaceSuspend/Resume: a root admin's resume and suspend of a registered repo name its folder; a workspace in workspaces/ names none", async () => {
  await using host = await hostFolder();
  const folder = await registerOutside(host, "outside");
  await Deno.mkdir(join(host.dir, "by-hand"));
  await Deno.writeTextFile(join(host.dir, "by-hand", ".swamp.yaml"), "");

  await collect(
    hostedWorkspaceResume(ctx, host.deps(), {
      name: "outside",
      rootAdmin: true,
    }),
  );
  assertEquals(await wantedFile(host.dir, "outside"), {
    wanted: "active",
    creator: null,
    changedAt: (await wantedFile(host.dir, "outside")).changedAt,
    folder,
  });
  await collect(
    hostedWorkspaceSuspend(ctx, host.deps(), {
      name: "outside",
      rootAdmin: true,
    }),
  );
  assertEquals((await wantedFile(host.dir, "outside")).wanted, "suspended");
  assertEquals((await wantedFile(host.dir, "outside")).folder, folder);

  // a folder left in a wanted file of the host's own is dropped by the next change
  await Deno.writeTextFile(
    join(host.dir, "by-hand.wanted.yaml"),
    `wanted: suspended\nfolder: ${folder}\n`,
  );
  await collect(hostedWorkspaceResume(ctx, host.deps(), { name: "by-hand" }));
  assertEquals("folder" in await wantedFile(host.dir, "by-hand"), false);
});

Deno.test("hostedWorkspaceSuspend/Resume/Delete: a registered repo refuses a caller who is not a root admin, and refuses delete to everyone, writing nothing", async () => {
  await using host = await hostFolder();
  await registerOutside(host, "outside");
  for (
    const events of [
      hostedWorkspaceResume(ctx, host.deps(), { name: "outside" }),
      hostedWorkspaceSuspend(ctx, host.deps(), {
        name: "outside",
        rootAdmin: false,
      }),
    ]
  ) {
    const error = await errorOf(events);
    assertEquals(error.code, OPERATOR_WORKSPACE_CODE);
    assert(error.message.includes("root's admins"), error.message);
  }
  const refused = await errorOf<HostedWorkspaceDeleteEvent>(
    hostedWorkspaceDelete(ctx, host.deps(), { name: "outside" }),
  );
  assertEquals(refused.code, OPERATOR_WORKSPACE_CODE);
  assert(
    refused.message.includes("swamp workspace remove outside"),
    refused.message,
  );
  assert(!refused.message.includes(host.dir), "names no host path");
  assertEquals(await exists(join(host.dir, "outside.wanted.yaml")), false);
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

Deno.test("createHostedWorkspaceDeps: a change that cannot get the lock says the workspace is busy and names no host path", async () => {
  await using host = await hostFolder();
  const deps = createHostedWorkspaceDeps({
    workspacesDir: host.dir,
    provisioner: { provision: () => Promise.resolve() },
    addressOf: (name) => name,
    workspaceStore: host.store,
    lockWaitMs: 50,
  });
  const held = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const holding = deps.withLock("edge-dns", () => {
    entered.resolve();
    return held.promise;
  });
  // racing holding fails the test, rather than hanging it, if the holder cannot lock
  await Promise.race([entered.promise, holding]);
  try {
    const error = await assertRejects(
      () => deps.withLock("edge-dns", () => Promise.resolve()),
      UserError,
    );
    assertEquals(error.code, "busy");
    assertEquals(
      error.message,
      "Workspace edge-dns is busy with another change. Retry in a moment.",
    );
  } finally {
    held.resolve();
    await holding;
  }
});

Deno.test("hostedWorkspaceSuspend/Create: a file-system error becomes an error event that names no host path", async () => {
  await using host = await hostFolder();
  const denied = () =>
    Promise.reject(
      new Deno.errors.PermissionDenied(
        `Permission denied (os error 13): open '${host.dir}/edge-dns.wanted.yaml'`,
      ),
    );
  const deps = host.deps({
    repository: {
      findByName: denied,
      save: denied,
      remove: denied,
    },
  });
  for (
    const error of [
      await assertErrors<HostedWorkspaceSuspendEvent>(
        hostedWorkspaceSuspend(ctx, deps, { name: "edge-dns" }),
        "host_error",
      ),
      await assertErrors<HostedWorkspaceCreateEvent>(
        hostedWorkspaceCreate(ctx, deps, {
          name: "edge-dns",
          caller: ALICE,
          access: OAUTH_ACCESS,
        }),
        "host_error",
      ),
    ]
  ) {
    assertEquals(
      error.message,
      "The host could not complete the request. The host's log has the details.",
    );
    assert(error.cause instanceof Deno.errors.PermissionDenied);
  }
});

async function errorOf<E extends { kind: string }>(
  events: AsyncIterable<E>,
): Promise<{ code: string; message: string }> {
  for (const event of await collect(events)) {
    if (event.kind === "error") {
      return (event as unknown as { error: { code: string; message: string } })
        .error;
    }
  }
  throw new Error("expected an error event");
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("hostedWorkspaceDelete: a name whose folder is registered under another name is refused, writing nothing", async () => {
  await using host = await hostFolder();
  await Deno.mkdir(join(host.dir, "gamma"));
  await Deno.writeTextFile(join(host.dir, "gamma", ".swamp.yaml"), "");
  await Deno.writeTextFile(
    join(host.dir, "gamma.wanted.yaml"),
    "wanted: active\n",
  );
  await host.store.registry.update((registry) => {
    registry.register({
      name: "beta",
      path: Deno.realPathSync(join(host.dir, "gamma")),
      createdAt: "2026-11-17T10:00:00.000Z",
    });
  });
  const refused = await errorOf<HostedWorkspaceDeleteEvent>(
    hostedWorkspaceDelete(ctx, host.deps(), { name: "gamma" }),
  );
  assertEquals(refused.code, OPERATOR_WORKSPACE_CODE);
  assert(refused.message.includes("registered as beta"), refused.message);
  assert(!refused.message.includes(host.dir), "names no host path");
  assertEquals((await wantedFile(host.dir, "gamma")).wanted, "active");
});

Deno.test("hostedWorkspaceSuspend/Resume/Delete: while the registry cannot be read, a name the host cannot place gets the operator's rules", async () => {
  await using host = await hostFolder();
  const folder = await registerOutside(host, "personal");
  await collect(
    hostedWorkspaceSuspend(ctx, host.deps(), {
      name: "personal",
      rootAdmin: true,
    }),
  );
  await Deno.writeTextFile(
    join(host.dir, "..", "config", "workspaces.json"),
    "{not json",
  );

  const refused = await errorOf<HostedWorkspaceDeleteEvent>(
    hostedWorkspaceDelete(ctx, host.deps(), { name: "personal" }),
  );
  assertEquals(refused.code, OPERATOR_WORKSPACE_CODE);
  assert(refused.message.includes("registry"), refused.message);
  const resume = await errorOf<HostedWorkspaceResumeEvent>(
    hostedWorkspaceResume(ctx, host.deps(), { name: "personal" }),
  );
  assertEquals(resume.code, OPERATOR_WORKSPACE_CODE);
  assertEquals((await wantedFile(host.dir, "personal")).wanted, "suspended");

  await collect(
    hostedWorkspaceResume(ctx, host.deps(), {
      name: "personal",
      rootAdmin: true,
    }),
  );
  assertEquals(await wantedFile(host.dir, "personal"), {
    wanted: "active",
    creator: null,
    changedAt: (await wantedFile(host.dir, "personal")).changedAt,
    folder,
  });
});

Deno.test("hostedWorkspaceResume: a root admin resumes a registered repo whose wanted file says deleted", async () => {
  await using host = await hostFolder();
  const folder = await registerOutside(host, "personal");
  await Deno.writeTextFile(
    join(host.dir, "personal.wanted.yaml"),
    `wanted: deleted\nfolder: ${folder}\n`,
  );
  await collect(
    hostedWorkspaceResume(ctx, host.deps(), {
      name: "personal",
      rootAdmin: true,
    }),
  );
  assertEquals((await wantedFile(host.dir, "personal")).wanted, "active");
});

Deno.test("hostedWorkspaceResume: a name a registered repo holds while a folder of that name is in workspaces/ is refused to everyone", async () => {
  await using host = await hostFolder();
  await Deno.mkdir(join(host.dir, "alpha"));
  await Deno.writeTextFile(join(host.dir, "alpha", ".swamp.yaml"), "");
  await registerOutside(host, "alpha");
  const refused = await errorOf<HostedWorkspaceResumeEvent>(
    hostedWorkspaceResume(ctx, host.deps(), { name: "alpha", rootAdmin: true }),
  );
  assertEquals(refused.code, OPERATOR_WORKSPACE_CODE);
  assert(
    refused.message.includes("swamp workspace remove alpha"),
    refused.message,
  );
  assert(!refused.message.includes(host.dir), "names no host path");
  assertEquals(await exists(join(host.dir, "alpha.wanted.yaml")), false);
  // a suspend writes nothing that could start anything, and is allowed
  await collect(
    hostedWorkspaceSuspend(ctx, host.deps(), {
      name: "alpha",
      rootAdmin: true,
    }),
  );
  assertEquals((await wantedFile(host.dir, "alpha")).wanted, "suspended");
});

Deno.test("hostedWorkspaceSuspend/Resume/Delete: a name with no entry whose wanted file names a folder gets the operator's rules", async () => {
  await using host = await hostFolder();
  const folder = await registerOutside(host, "personal");
  await collect(
    hostedWorkspaceSuspend(ctx, host.deps(), {
      name: "personal",
      rootAdmin: true,
    }),
  );
  // the registry file gone: a missing file reads as an empty registry
  await Deno.remove(join(host.dir, "..", "config", "workspaces.json"));
  const resume = await errorOf<HostedWorkspaceResumeEvent>(
    hostedWorkspaceResume(ctx, host.deps(), { name: "personal" }),
  );
  assertEquals(resume.code, OPERATOR_WORKSPACE_CODE);
  const refused = await errorOf<HostedWorkspaceDeleteEvent>(
    hostedWorkspaceDelete(ctx, host.deps(), { name: "personal" }),
  );
  assertEquals(refused.code, OPERATOR_WORKSPACE_CODE);
  assertEquals((await wantedFile(host.dir, "personal")).wanted, "suspended");
  assertEquals((await wantedFile(host.dir, "personal")).folder, folder);
});

Deno.test("hostedWorkspaceResume: a name with nothing is not found, whatever the registry", async () => {
  await using host = await hostFolder();
  await Deno.mkdir(join(host.dir, "..", "config"), { recursive: true });
  await Deno.writeTextFile(
    join(host.dir, "..", "config", "workspaces.json"),
    "{not json",
  );
  await assertErrors<HostedWorkspaceResumeEvent>(
    hostedWorkspaceResume(ctx, host.deps(), { name: "nothing" }),
    "not_found",
  );
});

Deno.test("hostedWorkspaceDelete: while the registry cannot be read, no workspace is deleted, the host's own included", async () => {
  await using host = await hostFolder();
  await Deno.mkdir(join(host.dir, "delta"));
  await Deno.writeTextFile(join(host.dir, "delta", ".swamp.yaml"), "");
  await Deno.mkdir(join(host.dir, "..", "config"), { recursive: true });
  await Deno.writeTextFile(
    join(host.dir, "..", "config", "workspaces.json"),
    "{not json",
  );
  const refused = await errorOf<HostedWorkspaceDeleteEvent>(
    hostedWorkspaceDelete(ctx, host.deps(), { name: "delta" }),
  );
  assertEquals(refused.code, OPERATOR_WORKSPACE_CODE);
  assert(refused.message.includes("registry"), refused.message);
  assertEquals(await exists(join(host.dir, "delta.wanted.yaml")), false);
});
