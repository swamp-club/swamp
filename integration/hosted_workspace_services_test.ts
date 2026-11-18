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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import { provisionHostedWorkspace } from "../src/cli/hosted_workspace_provision.ts";
import type {
  HostedWorkspace,
  HostedWorkspaceRepository,
} from "../src/domain/serve/hosted_workspace.ts";
import { workspaceServe } from "../src/domain/serve/managed_serve.ts";
import { HostedWorkspaceFileRepository } from "../src/infrastructure/persistence/hosted_workspace_file_repository.ts";
import { scanWorkspaces } from "../src/infrastructure/persistence/hosted_workspace_folder_scan.ts";
import { hostedWorkspaceCreate } from "../src/libswamp/hosted_workspace/create.ts";
import { hostedWorkspaceDelete } from "../src/libswamp/hosted_workspace/delete.ts";
import {
  createHostedWorkspaceDeps,
  type HostedWorkspaceDeps,
  type HostedWorkspaceProvisioner,
  type HostedWorkspaceRootAccess,
} from "../src/libswamp/hosted_workspace/deps.ts";
import { hostedWorkspaceGet } from "../src/libswamp/hosted_workspace/get.ts";
import { hostedWorkspaceList } from "../src/libswamp/hosted_workspace/list.ts";
import { hostedWorkspaceResume } from "../src/libswamp/hosted_workspace/resume.ts";
import { hostedWorkspaceSuspend } from "../src/libswamp/hosted_workspace/suspend.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { collect } from "../src/libswamp/testing.ts";
import type { ListenedServe } from "../src/serve/listening_line.ts";
import { loadServeConfig } from "../src/serve/serve_config.ts";
import type {
  ServeChild,
  ServeChildExit,
  ServeProcessPort,
} from "../src/serve/host/serve_process.ts";
import { createStatusWriter } from "../src/serve/host/status_writer.ts";
import { createServeSupervisor } from "../src/serve/host/supervisor.ts";
import { createWorkspaceReconciler } from "../src/serve/host/workspace_reconciler.ts";

const ctx = createLibSwampContext();
const ALICE = { principal: "user:sub-alice", username: "alice" };
const ACCESS: HostedWorkspaceRootAccess = {
  mode: "oauth",
  oauthProvider: "https://club.example",
  allowedUsers: ["bob"],
  allowedCollectives: [],
  nameCache: { "allowed:bob": "sub-bob" },
};

/** counts spawns; a spawned child is ready at once and exits when asked */
class CountingPort implements ServeProcessPort {
  spawned: string[] = [];
  spawn(spec: Parameters<ServeProcessPort["spawn"]>[0]): ServeChild {
    this.spawned.push(spec.id.kind === "workspace" ? spec.id.name : "root");
    const exited = Promise.withResolvers<ServeChildExit>();
    const exit = () => exited.resolve({ code: 0, stderrTail: [] });
    return {
      listening: Promise.resolve<ListenedServe>({
        port: 40_000,
        authMode: "oauth",
      }),
      ready: Promise.resolve(),
      exited: exited.promise,
      terminate: exit,
      reload: () => {},
      kill: exit,
      release: () => Promise.resolve(),
    };
  }
}

interface Host extends AsyncDisposable {
  readonly dir: string;
  readonly port: CountingPort;
  deps(overrides?: Partial<HostedWorkspaceDeps>): HostedWorkspaceDeps;
  /** one host rescan, as the folder watcher runs it */
  rescan(): Promise<void>;
  wanted(name: string): string | undefined;
}

const inProcessProvisioner: HostedWorkspaceProvisioner = {
  provision: (dir, spec) => provisionHostedWorkspace(dir, spec),
};

async function host(): Promise<Host> {
  const root = await Deno.makeTempDir();
  const dir = join(root, "workspaces");
  await Deno.mkdir(dir);
  const port = new CountingPort();
  const statusWriter = createStatusWriter({ workspacesDir: dir, retryMs: 10 });
  const supervisor = createServeSupervisor({
    processPort: port,
    onStatus: (status) => statusWriter.report(status),
  });
  const repository = new HostedWorkspaceFileRepository(dir);
  const reconciler = createWorkspaceReconciler({
    workspacesDir: dir,
    supervisor,
    specOf: (name) => ({
      id: workspaceServe(name),
      repoDir: join(dir, name),
      address: `https://host.example/w/${name}`,
      trustedHost: "host.example",
      env: {},
    }),
    repository,
    statusWriter,
  });
  return {
    dir,
    port,
    deps: (overrides = {}) => ({
      ...createHostedWorkspaceDeps({
        workspacesDir: dir,
        provisioner: inProcessProvisioner,
        addressOf: (name) => `https://host.example/w/${name}`,
      }),
      ...overrides,
    }),
    rescan: async () => await reconciler.reconcile(await scanWorkspaces(dir)),
    wanted: (name) => supervisor.lookup(workspaceServe(name))?.wanted,
    async [Symbol.asyncDispose]() {
      await supervisor.shutdown();
      await reconciler.drain();
      await statusWriter.drain();
      if (Deno.build.os === "windows") {
        await Deno.remove(root, { recursive: true }).catch(() => {});
      } else {
        await Deno.remove(root, { recursive: true });
      }
    },
  };
}

async function listedNames(deps: HostedWorkspaceDeps): Promise<string[]> {
  const events = await collect(hostedWorkspaceList(ctx, deps));
  const last = events[events.length - 1];
  assert(last.kind === "completed");
  return last.data.workspaces.map((w) => w.name);
}

/** scans the folder and runs the host at each step of a create */
function observing(
  h: Host,
  name: string,
  seen: {
    step: string;
    folders: string[];
    wanted: string[];
    listed: string[];
  }[],
): Partial<HostedWorkspaceDeps> {
  const base = h.deps();
  const look = async (step: string) => {
    const scan = await scanWorkspaces(h.dir);
    seen.push({
      step,
      folders: [...scan.workspaces],
      wanted: [...scan.wantedFiles],
      listed: await listedNames(base),
    });
    await h.rescan();
  };
  const repository: HostedWorkspaceRepository = {
    findByName: (n) => base.repository.findByName(n),
    remove: (n) => base.repository.remove(n),
    async save(workspace: HostedWorkspace) {
      await base.repository.save(workspace);
      if (workspace.name === name) await look("after the wanted file");
    },
  };
  return {
    repository,
    provisioner: {
      async provision(dir, spec, signal) {
        await look("before set-up");
        await inProcessProvisioner.provision(dir, spec, signal);
        await look("after set-up");
      },
    },
  };
}

Deno.test("hosted workspace services: no scan lists a workspace before it is whole, and the host starts it once renamed", async () => {
  await using h = await host();
  const seen: Parameters<typeof observing>[2] = [];
  await collect(
    hostedWorkspaceCreate(ctx, h.deps(observing(h, "edge-dns", seen)), {
      name: "edge-dns",
      caller: ALICE,
      access: ACCESS,
    }),
  );
  assertEquals(seen.map((s) => s.step), [
    "before set-up",
    "after set-up",
    "after the wanted file",
  ]);
  for (const s of seen) assertEquals(s.folders, [], s.step);
  assertEquals(seen[0].listed, []);
  assertEquals(seen[1].listed, []);
  assertEquals(seen[2].wanted, ["edge-dns"]);
  assertEquals(h.port.spawned, [], "nothing starts while the folder is hidden");

  await h.rescan();
  assertEquals(h.port.spawned, ["edge-dns"]);
  const auth = loadServeConfig(undefined, join(h.dir, "edge-dns"))?.auth;
  assertEquals(auth?.admins, ["alice"]);
  assertEquals(auth?.["allowed-users"], ["bob"]);
});

Deno.test("hosted workspace services: a workspace created suspended has its wanted file before its folder and is never started", async () => {
  await using h = await host();
  const seen: Parameters<typeof observing>[2] = [];
  await collect(
    hostedWorkspaceCreate(ctx, h.deps(observing(h, "edge-dns", seen)), {
      name: "edge-dns",
      caller: ALICE,
      access: ACCESS,
      suspended: true,
    }),
  );
  const beforeFolder = seen.find((s) => s.step === "after the wanted file")!;
  assertEquals(beforeFolder.wanted, ["edge-dns"]);
  assertEquals(beforeFolder.folders, []);
  assertEquals(beforeFolder.listed, ["edge-dns"]);

  await h.rescan();
  await h.rescan();
  assertEquals((await scanWorkspaces(h.dir)).workspaces, ["edge-dns"]);
  assertEquals(h.port.spawned, []);
  assertEquals(h.wanted("edge-dns"), "suspended");

  await collect(hostedWorkspaceResume(ctx, h.deps(), { name: "edge-dns" }));
  await h.rescan();
  assertEquals(h.port.spawned, ["edge-dns"]);
});

Deno.test("hosted workspace services: a failed set-up leaves no folder and no wanted file", async () => {
  await using h = await host();
  const events = await collect(hostedWorkspaceCreate(
    ctx,
    h.deps({
      provisioner: {
        async provision(dir, spec, signal) {
          await inProcessProvisioner.provision(dir, spec, signal);
          throw new Error(`disk full under ${dir}`);
        },
      },
    }),
    { name: "edge-dns", caller: ALICE, access: ACCESS },
  ));
  const last = events[events.length - 1];
  assert(last.kind === "error");
  assertEquals(last.error.code, "provision_failed");
  assertEquals(last.error.message.includes(h.dir), false);
  assertEquals([...Deno.readDirSync(h.dir)], []);
});

Deno.test("hosted workspace services: an oauth caller without a plain username is refused and leaves nothing", async () => {
  await using h = await host();
  const events = await collect(hostedWorkspaceCreate(ctx, h.deps(), {
    name: "edge-dns",
    caller: { ...ALICE, username: null },
    access: ACCESS,
  }));
  const last = events[events.length - 1];
  assert(last.kind === "error");
  assertEquals(last.error.code, "username_unknown");
  assertEquals([...Deno.readDirSync(h.dir)], []);
});

Deno.test("hosted workspace services: a folder, a link or a wanted file holding the name refuses create", async () => {
  for (
    const setup of [
      (dir: string) => Deno.mkdir(join(dir, "edge-dns")),
      (dir: string) =>
        Deno.symlink(join(dir, "elsewhere"), join(dir, "edge-dns"), {
          type: "dir",
        }),
      (dir: string) =>
        Deno.writeTextFile(
          join(dir, "edge-dns.wanted.yaml"),
          "wanted: active\n",
        ),
    ]
  ) {
    await using h = await host();
    await setup(h.dir);
    const events = await collect(hostedWorkspaceCreate(ctx, h.deps(), {
      name: "edge-dns",
      caller: ALICE,
      access: ACCESS,
    }));
    const last = events[events.length - 1];
    assert(last.kind === "error");
    assertEquals(last.error.code, "already_exists");
  }
});

Deno.test("hosted workspace services: suspend, resume, get and delete drive the host through the wanted file", async () => {
  await using h = await host();
  const deps = h.deps();
  await collect(hostedWorkspaceCreate(ctx, deps, {
    name: "edge-dns",
    caller: ALICE,
    access: ACCESS,
  }));
  await h.rescan();
  assertEquals(h.wanted("edge-dns"), "running");

  await collect(hostedWorkspaceSuspend(ctx, deps, { name: "edge-dns" }));
  await h.rescan();
  assertEquals(h.wanted("edge-dns"), "suspended");

  await collect(hostedWorkspaceResume(ctx, deps, { name: "edge-dns" }));
  await h.rescan();
  assertEquals(h.wanted("edge-dns"), "running");

  const got = await collect(
    hostedWorkspaceGet(ctx, deps, { name: "edge-dns" }),
  );
  const view = got[got.length - 1];
  assert(view.kind === "completed");
  assertEquals(view.data.address, "https://host.example/w/edge-dns");
  assertEquals(view.data.wanted, "active");

  await collect(hostedWorkspaceDelete(ctx, deps, { name: "edge-dns" }));
  await h.rescan();
  // the host removes a workspace in the background, wanted file last
  await waitFor(async () => {
    await h.rescan();
    return [...Deno.readDirSync(h.dir)].every((e) => e.name.startsWith("."));
  }, "the host removed the workspace");
  const missing = await collect(
    hostedWorkspaceGet(ctx, deps, { name: "edge-dns" }),
  );
  const last = missing[missing.length - 1];
  assert(last.kind === "error");
  assertStringIncludes(
    last.error.message,
    "No hosted workspace named edge-dns",
  );
});
