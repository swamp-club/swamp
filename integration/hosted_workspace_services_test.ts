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
import {
  createWorkspaceReconciler,
  readWantedFiles,
} from "../src/serve/host/workspace_reconciler.ts";
import {
  createWorkspaceRegistrar,
  hostWorkspaceStore,
  RegistryProblemLog,
} from "../src/serve/host/workspace_registration.ts";
import { createWorkspaceRoster } from "../src/serve/host/workspace_roster.ts";
import type { HostedRegistryDeps } from "../src/libswamp/workspace/hosted_registration.ts";

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
  readonly store: HostedRegistryDeps;
  readonly port: CountingPort;
  deps(overrides?: Partial<HostedWorkspaceDeps>): HostedWorkspaceDeps;
  /** one host rescan, as the folder watcher runs it */
  rescan(): Promise<void>;
  wanted(name: string): string | undefined;
  /** waits for every removal the host started */
  drain(): Promise<void>;
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
  const store = hostWorkspaceStore({
    dataDir: join(root, "data"),
    configDir: join(root, "config"),
  });
  const problems = new RegistryProblemLog();
  const reconciler = createWorkspaceReconciler({
    workspacesDir: dir,
    supervisor,
    specOf: (name, folder) => ({
      id: workspaceServe(name),
      repoDir: folder,
      address: `https://host.example/w/${name}`,
      trustedHost: "host.example",
      env: {},
    }),
    repository,
    statusWriter,
    registrar: createWorkspaceRegistrar({
      workspacesDir: dir,
      store,
      problems,
    }),
  });
  const roster = createWorkspaceRoster({
    workspacesDir: dir,
    rootRepo: null,
    store,
    problems,
  });
  return {
    dir,
    store,
    port,
    deps: (overrides = {}) => ({
      ...createHostedWorkspaceDeps({
        workspacesDir: dir,
        provisioner: inProcessProvisioner,
        addressOf: (name) => `https://host.example/w/${name}`,
        workspaceStore: store,
      }),
      ...overrides,
    }),
    rescan: async () => {
      const scan = await scanWorkspaces(dir);
      const reads = await readWantedFiles(repository, scan);
      reconciler.reconcile(scan, reads, await roster.read(scan, reads));
    },
    wanted: (name) => supervisor.lookup(workspaceServe(name))?.wanted,
    drain: () => reconciler.drain(),
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

Deno.test("hosted workspace services: no scan lists a workspace before it is whole, and the host starts it only once resumed", async () => {
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
  assertEquals(seen[2].listed, ["edge-dns"]);
  assertEquals(h.port.spawned, [], "nothing starts while the folder is hidden");

  await h.rescan();
  await h.rescan();
  assertEquals((await scanWorkspaces(h.dir)).workspaces, ["edge-dns"]);
  assertEquals(h.port.spawned, [], "a new workspace has no serve");
  assertEquals(h.wanted("edge-dns"), "suspended");
  const auth = loadServeConfig(undefined, join(h.dir, "edge-dns"))?.auth;
  assertEquals(auth?.admins, ["alice"]);
  assertEquals(auth?.["allowed-users"], ["bob"]);

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
  await collect(hostedWorkspaceResume(ctx, deps, { name: "edge-dns" }));
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

Deno.test("hosted workspace services: create registers the workspace and delete removes its folder and its entry", async () => {
  await using h = await host();
  await collect(
    hostedWorkspaceCreate(ctx, h.deps(), {
      name: "edge-dns",
      caller: ALICE,
      access: ACCESS,
    }),
  );
  const folder = await Deno.realPath(join(h.dir, "edge-dns"));
  assertEquals(
    (await h.store.registry.load())?.list().map((e) => [e.name, e.path]),
    [["edge-dns", folder]],
  );

  await h.rescan();
  await collect(hostedWorkspaceDelete(ctx, h.deps(), { name: "edge-dns" }));
  await h.rescan();
  await waitFor(
    async () => (await scanWorkspaces(h.dir)).wantedFiles.length === 0,
    "the removal finishes",
  );
  assertEquals((await h.store.registry.load())?.list(), []);
  assertEquals((await scanWorkspaces(h.dir)).workspaces, []);
});

Deno.test("hosted workspace services: the host's own replies the same whatever the registry holds, and an entry outside workspaces/ is listed as the operator's own", async () => {
  await using h = await host();
  const deps = h.deps();
  await collect(hostedWorkspaceCreate(ctx, deps, {
    name: "edge-dns",
    caller: ALICE,
    access: ACCESS,
  }));
  await Deno.mkdir(join(h.dir, "by-hand"));
  await Deno.writeTextFile(join(h.dir, "by-hand", ".swamp.yaml"), "");
  // what reaches a caller: an error's cause stays on the host
  const shown = (events: { kind: string }[]) =>
    events.map((e) =>
      "error" in e && typeof e.error === "object" && e.error !== null
        ? { ...e, error: { ...e.error, cause: undefined } }
        : e
    );
  const replies = async () => ({
    list: shown(await collect(hostedWorkspaceList(ctx, deps))),
    get: shown(
      await collect(hostedWorkspaceGet(ctx, deps, { name: "edge-dns" })),
    ),
    outside: shown(
      await collect(hostedWorkspaceGet(ctx, deps, { name: "outside" })),
    ),
  });
  const registryFile = join(h.dir, "..", "config", "workspaces.json");
  await Deno.remove(registryFile);
  const baseline = await replies();
  assertEquals(await listedNames(deps), ["by-hand", "edge-dns"]);

  const outside = join(h.dir, "..", "projects", "outside");
  await Deno.mkdir(outside, { recursive: true });
  await Deno.writeTextFile(join(outside, ".swamp.yaml"), "");
  await h.store.registry.update((registry) => {
    registry.register({
      name: "edge-dns",
      path: join(h.dir, "edge-dns"),
      createdAt: "2026-11-19T00:00:00.000Z",
    });
    registry.register({
      name: "outside",
      path: outside,
      createdAt: "2026-11-19T00:00:00.000Z",
    });
  });
  const registered = await replies();
  assertEquals(registered.get, baseline.get);
  assertEquals(await listedNames(deps), ["by-hand", "edge-dns", "outside"]);
  const view = registered.outside[registered.outside.length - 1];
  assert(view.kind === "completed" && "data" in view);
  assertEquals((view.data as { owner?: string }).owner, "operator");

  // answered as a host started on that registry serves: from the folders
  await Deno.writeTextFile(registryFile, "{nope");
  assertEquals(await replies(), baseline);
});

async function importOutside(h: Host, name: string): Promise<string> {
  const made = join(h.dir, "..", "projects", name);
  await Deno.mkdir(made, { recursive: true });
  await Deno.writeTextFile(join(made, ".swamp.yaml"), "");
  const folder = await Deno.realPath(made);
  await h.store.registry.update((registry) => {
    registry.register({
      name,
      path: folder,
      createdAt: "2026-11-20T00:00:00.000Z",
    });
  });
  return folder;
}

Deno.test("hosted workspace services: a root admin's resume serves an imported repo from its folder, a suspend stops it, and delete is refused leaving it whole", async () => {
  await using h = await host();
  const folder = await importOutside(h, "outside");
  await h.rescan();
  assertEquals(h.wanted("outside"), "suspended");
  assertEquals(h.port.spawned, []);

  await collect(
    hostedWorkspaceResume(ctx, h.deps(), { name: "outside", rootAdmin: true }),
  );
  await h.rescan();
  assertEquals(h.wanted("outside"), "running");
  await waitFor(() => h.port.spawned.includes("outside"), "outside started");

  await collect(
    hostedWorkspaceSuspend(ctx, h.deps(), { name: "outside", rootAdmin: true }),
  );
  await h.rescan();
  assertEquals(h.wanted("outside"), "suspended");

  const refused = await collect(
    hostedWorkspaceDelete(ctx, h.deps(), { name: "outside" }),
  );
  const last = refused[refused.length - 1];
  assert(last.kind === "error");
  assertEquals(last.error.code, "operator_workspace");
  await h.rescan();
  assertEquals(h.wanted("outside"), "suspended");
  assert((await Deno.stat(join(folder, ".swamp.yaml"))).isFile);
});

Deno.test("hosted workspace services: a hand-written deleted for an imported repo stops it and leaves its folder and entry", async () => {
  await using h = await host();
  const folder = await importOutside(h, "outside");
  await Deno.writeTextFile(
    join(h.dir, "outside.wanted.yaml"),
    `wanted: active\nfolder: ${folder}\n`,
  );
  await h.rescan();
  assertEquals(h.wanted("outside"), "running");

  await Deno.writeTextFile(
    join(h.dir, "outside.wanted.yaml"),
    `wanted: deleted\nfolder: ${folder}\n`,
  );
  await h.rescan();
  await h.rescan();
  assertEquals(h.wanted("outside"), "suspended");
  assert((await Deno.stat(join(folder, ".swamp.yaml"))).isFile);
  assertEquals(
    (await h.store.registry.load())?.get("outside")?.path,
    folder,
  );
});

Deno.test("hosted workspace services: an active wanted file left behind under a name starts nothing for a repo imported later under it", async () => {
  await using h = await host();
  // left by a workspace in workspaces/ that was removed by hand
  await Deno.writeTextFile(
    join(h.dir, "edge-dns.wanted.yaml"),
    "wanted: active\n",
  );
  await h.rescan();
  await importOutside(h, "edge-dns");
  await h.rescan();
  await h.rescan();
  assertEquals(h.wanted("edge-dns"), "suspended");
  assertEquals(h.port.spawned, []);
});

Deno.test("hosted workspace services: a folder registered under another name is never deleted through its folder's name", async () => {
  await using h = await host();
  const deps = h.deps();
  await collect(hostedWorkspaceCreate(ctx, deps, {
    name: "gamma",
    caller: ALICE,
    access: ACCESS,
  }));
  const folder = await Deno.realPath(join(h.dir, "gamma"));
  await Deno.writeTextFile(join(folder, "TEAM_DATA.txt"), "keep me");
  await h.rescan();
  // the host's user imports the folder under another name
  await h.store.registry.update((registry) => {
    registry.remove("gamma");
    registry.register({
      name: "beta",
      path: folder,
      createdAt: "2026-11-20T00:00:00.000Z",
    });
  });
  await h.rescan();

  for (const name of ["gamma", "beta"]) {
    const refused = await collect(hostedWorkspaceDelete(ctx, deps, { name }));
    const last = refused[refused.length - 1];
    assert(last.kind === "error", name);
    assertEquals(last.error.code, "operator_workspace", name);
  }

  // a deleted written by hand under the folder's name removes nothing either
  await Deno.writeTextFile(
    join(h.dir, "gamma.wanted.yaml"),
    "wanted: deleted\n",
  );
  for (let i = 0; i < 3; i++) await h.rescan();
  await h.drain();
  assertEquals(
    await Deno.readTextFile(join(folder, "TEAM_DATA.txt")),
    "keep me",
  );
  assertEquals((await h.store.registry.load())?.get("beta")?.path, folder);
});

Deno.test("hosted workspace services: a clash a request cannot see, with the registry unreadable, deletes nothing once the name is freed", async () => {
  await using h = await host();
  const deps = h.deps();
  await collect(hostedWorkspaceCreate(ctx, deps, {
    name: "delta",
    caller: ALICE,
    access: ACCESS,
  }));
  const team = await Deno.realPath(join(h.dir, "delta"));
  await Deno.writeTextFile(join(team, "TEAM_DATA.txt"), "keep me");
  await h.rescan();
  // the host's user gives the name to another repo
  await h.store.registry.update((registry) => registry.remove("delta"));
  await importOutside(h, "delta");
  await h.rescan();

  const registryFile = join(h.dir, "..", "config", "workspaces.json");
  const saved = await Deno.readTextFile(registryFile);
  await Deno.writeTextFile(registryFile, "{nope");
  const refused = await collect(
    hostedWorkspaceDelete(ctx, deps, { name: "delta" }),
  );
  const last = refused[refused.length - 1];
  assert(last.kind === "error");
  assertEquals(last.error.code, "operator_workspace");

  // a deleted written by hand while the name is held is dropped by the host
  await Deno.writeTextFile(registryFile, saved);
  await Deno.writeTextFile(
    join(h.dir, "delta.wanted.yaml"),
    "wanted: deleted\n",
  );
  await h.rescan();
  await h.drain();
  await h.store.registry.update((registry) => registry.remove("delta"));
  for (let i = 0; i < 3; i++) await h.rescan();
  await h.drain();
  assertEquals(await Deno.readTextFile(join(team, "TEAM_DATA.txt")), "keep me");
});

Deno.test("hosted workspace services: a hand-written deleted under a folder's name, while the folder is registered under another, deletes nothing once that entry goes", async () => {
  await using h = await host();
  const deps = h.deps();
  await collect(hostedWorkspaceCreate(ctx, deps, {
    name: "gamma",
    caller: ALICE,
    access: ACCESS,
  }));
  const folder = await Deno.realPath(join(h.dir, "gamma"));
  await Deno.writeTextFile(join(folder, "TEAM_DATA.txt"), "keep me");
  await h.rescan();
  await h.store.registry.update((registry) => {
    registry.remove("gamma");
    registry.register({
      name: "beta",
      path: folder,
      createdAt: "2026-11-20T00:00:00.000Z",
    });
  });
  await h.rescan();
  await Deno.writeTextFile(
    join(h.dir, "gamma.wanted.yaml"),
    "wanted: deleted\n",
  );
  await h.rescan();
  await h.drain();
  await h.store.registry.update((registry) => registry.remove("beta"));
  for (let i = 0; i < 3; i++) await h.rescan();
  await h.drain();
  assertEquals(
    await Deno.readTextFile(join(folder, "TEAM_DATA.txt")),
    "keep me",
  );
});
