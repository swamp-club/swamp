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
import {
  creatingFolderName,
  scanWorkspaces,
} from "../src/infrastructure/persistence/hosted_workspace_folder_scan.ts";
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
  type CreatedWorkspaceRemoval,
  createWorkspaceReconciler,
  readWantedFiles,
} from "../src/serve/host/workspace_reconciler.ts";
import {
  createWorkspaceRegistrar,
  hostConfiguredParent,
  hostWorkspaceStore,
  RegistryProblemLog,
} from "../src/serve/host/workspace_registration.ts";
import { createdWorkspaceRemoval } from "../src/serve/host/serve_host.ts";
import { hostWorkspacePlacement } from "../src/serve/host_root_workspaces.ts";
import { importWorkspace } from "../src/libswamp/workspace/workspace_store.ts";
import { UserError } from "../src/domain/errors.ts";
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

interface NoFolderHost extends AsyncDisposable {
  readonly root: string;
  /** the state folder: wanted, status and lock files only */
  readonly dir: string;
  readonly dataDir: string;
  readonly configDir: string;
  readonly store: HostedRegistryDeps;
  deps(overrides?: Partial<HostedWorkspaceDeps>): HostedWorkspaceDeps;
  rescan(): Promise<void>;
  drain(): Promise<void>;
  /** workspaces.dir, as swamp config set writes it */
  setLocation(dir: string): Promise<void>;
}

async function noFolderHost(
  created?: (base: CreatedWorkspaceRemoval) => CreatedWorkspaceRemoval,
): Promise<NoFolderHost> {
  const root = await Deno.makeTempDir();
  const dir = join(root, "state");
  const dataDir = join(root, "data");
  const configDir = join(root, "config");
  await Deno.mkdir(dir);
  await Deno.mkdir(configDir);
  const port = new CountingPort();
  const statusWriter = createStatusWriter({ workspacesDir: dir, retryMs: 10 });
  const supervisor = createServeSupervisor({
    processPort: port,
    onStatus: (status) => statusWriter.report(status),
  });
  const repository = new HostedWorkspaceFileRepository(dir);
  const store = hostWorkspaceStore({ dataDir, configDir });
  const problems = new RegistryProblemLog();
  const removal = createdWorkspaceRemoval({
    workspaceStore: store,
    configuredParent: hostConfiguredParent(configDir),
  });
  const reconciler = createWorkspaceReconciler({
    workspacesDir: dir,
    hostFolder: false,
    created: created?.(removal) ?? removal,
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
    hostFolder: false,
    rootRepo: null,
    store,
    problems,
  });
  return {
    root,
    dir,
    dataDir,
    configDir,
    store,
    deps: (overrides = {}) => ({
      ...createHostedWorkspaceDeps({
        workspacesDir: dir,
        hostFolder: false,
        placement: hostWorkspacePlacement({ dataDir, configDir }),
        provisioner: inProcessProvisioner,
        addressOf: (name) => `https://host.example/w/${name}`,
        workspaceStore: store,
      }),
      ...overrides,
    }),
    rescan: async () => {
      const scan = await scanWorkspaces(dir, { repos: false });
      const reads = await readWantedFiles(repository, scan);
      reconciler.reconcile(scan, reads, await roster.read(scan, reads));
    },
    drain: () => reconciler.drain(),
    setLocation: (location) =>
      Deno.writeTextFile(
        join(configDir, "workspaces.yaml"),
        `dir: ${location}\n`,
      ),
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function names(dir: string): Promise<string[]> {
  try {
    return (await Array.fromAsync(Deno.readDir(dir))).map((e) => e.name)
      .sort();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
}

/** deletes, and runs the host until the wanted file, removed last, is gone */
async function deleteAndSettle(h: NoFolderHost, name: string): Promise<void> {
  const events = await collect(
    hostedWorkspaceDelete(ctx, h.deps(), { name }),
  );
  assertEquals(events.map((e) => e.kind), ["completed"]);
  await waitFor(async () => {
    await h.rescan();
    await h.drain();
    return !(await pathExists(join(h.dir, `${name}.wanted.yaml`)));
  }, "the removal finishes");
}

async function registeredNames(h: NoFolderHost): Promise<string[]> {
  return ((await h.store.registry.load())?.list() ?? []).map((e) => e.name)
    .sort();
}

Deno.test("hosted workspace services, no host folder: create makes the repo in the data dir's workspaces, registers it as created, and delete removes the folder, the entry and both files", async () => {
  await using h = await noFolderHost();
  const created = await collect(
    hostedWorkspaceCreate(ctx, h.deps(), {
      name: "edge-dns",
      caller: ALICE,
      access: ACCESS,
    }),
  );
  assertEquals(created.map((e) => e.kind), ["completed"]);
  const folder = join(h.dataDir, "workspaces", "edge-dns");
  assert(await pathExists(join(folder, ".swamp.yaml")), "a repo");
  const entry = (await h.store.registry.load())?.get("edge-dns");
  assertEquals(entry?.path, folder);
  assertEquals(entry?.origin, "created");
  assertEquals(entry?.trustedAt, undefined);
  // the registry file keeps the keys it has today
  const raw = JSON.parse(
    await Deno.readTextFile(join(h.configDir, "workspaces.json")),
  );
  assertEquals(
    Object.keys(raw.workspaces[0]).sort(),
    ["createdAt", "name", "origin", "path"],
  );
  assertEquals(await names(h.dir), ["edge-dns.wanted.yaml"]);

  await h.rescan();
  const got = await collect(
    hostedWorkspaceGet(ctx, h.deps(), { name: "edge-dns" }),
  );
  const done = got.find((e) => e.kind === "completed");
  assert(done?.kind === "completed");
  assertEquals(done.data.owner, "host");
  assertEquals(done.data.wanted, "suspended");
  assert(!JSON.stringify(done.data).includes(h.root), "names no host path");

  await collect(hostedWorkspaceResume(ctx, h.deps(), { name: "edge-dns" }));
  await h.rescan();
  await collect(hostedWorkspaceSuspend(ctx, h.deps(), { name: "edge-dns" }));
  await h.rescan();
  const afterSuspend = await collect(
    hostedWorkspaceGet(ctx, h.deps(), { name: "edge-dns" }),
  );
  const suspended = afterSuspend.find((e) => e.kind === "completed");
  assert(suspended?.kind === "completed");
  assertEquals(suspended.data.owner, "host", "a change keeps it the host's");

  await deleteAndSettle(h, "edge-dns");
  assertEquals(await names(join(h.dataDir, "workspaces")), []);
  assertEquals(await registeredNames(h), []);
  assertEquals(
    (await names(h.dir)).filter((n) => !n.startsWith(".")),
    [],
  );
});

Deno.test("hosted workspace services, no host folder: with workspaces.dir set the folder is made there, and delete removes it from there", async () => {
  await using h = await noFolderHost();
  const location = join(h.root, "projects");
  await Deno.mkdir(location);
  const real = await Deno.realPath(location);
  await h.setLocation(real);
  await collect(
    hostedWorkspaceCreate(ctx, h.deps(), {
      name: "edge-dns",
      caller: ALICE,
      access: ACCESS,
    }),
  );
  assert(await pathExists(join(real, "edge-dns", ".swamp.yaml")));
  assertEquals(await names(join(h.dataDir, "workspaces")), []);
  await h.rescan();
  await deleteAndSettle(h, "edge-dns");
  assertEquals(await names(real), []);
  assertEquals(await registeredNames(h), []);
});

Deno.test("hosted workspace services, no host folder: the first create adopts the repos already in the data dir's workspaces", async () => {
  await using h = await noFolderHost();
  const older = join(h.dataDir, "workspaces", "older");
  await Deno.mkdir(older, { recursive: true });
  await Deno.writeTextFile(join(older, ".swamp.yaml"), "");
  await collect(
    hostedWorkspaceCreate(ctx, h.deps(), {
      name: "edge-dns",
      caller: ALICE,
      access: ACCESS,
    }),
  );
  assertEquals(await registeredNames(h), ["edge-dns", "older"]);
});

/** what create leaves on disk when it stops after each of its steps */
const CREATE_STOPS = [
  "set-up",
  "wanted file",
  "registered",
  "renamed",
] as const;

async function leaveCreateStopped(
  h: NoFolderHost,
  name: string,
  stop: typeof CREATE_STOPS[number],
): Promise<void> {
  const location = join(h.dataDir, "workspaces");
  await Deno.mkdir(location, { recursive: true });
  const temp = join(location, creatingFolderName(name));
  await Deno.mkdir(temp);
  await Deno.writeTextFile(join(temp, ".swamp.yaml"), "");
  if (stop === "set-up") return;
  const target = join(location, name);
  await Deno.writeTextFile(
    join(h.dir, `${name}.wanted.yaml`),
    `creator: user:sub-alice\nwanted: suspended\nchangedAt: 2026-11-20T10:00:00.000Z\nfolder: ${target}\n`,
  );
  if (stop === "wanted file") return;
  await h.store.registry.update((registry) => {
    registry.register({
      name,
      path: target,
      createdAt: "2026-11-20T10:00:00.000Z",
      origin: "created",
    });
  });
  if (stop === "registered") return;
  await Deno.rename(temp, target);
}

for (const stop of CREATE_STOPS) {
  Deno.test(`hosted workspace services, no host folder: a create stopped after ${stop} leaves a name that is free, with no folder, once deleted or created again`, async () => {
    await using h = await noFolderHost();
    await leaveCreateStopped(h, "edge-dns", stop);
    await h.rescan();
    if (stop === "set-up") {
      // nothing names it, so delete finds nothing and the next create sweeps the hidden folder
      const refused = await collect(
        hostedWorkspaceDelete(ctx, h.deps(), { name: "edge-dns" }),
      );
      const error = refused.find((e) => e.kind === "error");
      assertEquals(
        error?.kind === "error" ? error.error.code : null,
        "not_found",
      );
      await collect(
        hostedWorkspaceCreate(ctx, h.deps(), {
          name: "edge-dns",
          caller: ALICE,
          access: ACCESS,
        }),
      );
      await h.rescan();
    }
    await deleteAndSettle(h, "edge-dns");
    assertEquals(await names(join(h.dataDir, "workspaces")), []);
    assertEquals(await registeredNames(h), []);
    assertEquals(
      (await names(h.dir)).filter((n) => !n.startsWith(".")),
      [],
    );
  });
}

/** where an import can land while a create runs, and who wins: the first to register */
const IMPORT_POINTS = {
  "before set-up": "imported",
  "after set-up": "imported",
  "after the wanted file": "imported",
  "after the entry": "refused",
  "before the rename": "refused",
} as const;

for (const [point, winner] of Object.entries(IMPORT_POINTS)) {
  Deno.test(`hosted workspace services, no host folder: an import of the same name ${point} wins or loses whole, and its folder is never renamed or removed`, async () => {
    await using h = await noFolderHost();
    const imported = join(h.root, "projects", "edge-dns");
    await Deno.mkdir(imported, { recursive: true });
    await Deno.writeTextFile(join(imported, ".swamp.yaml"), "kept: true\n");
    const importDeps = {
      ...h.store,
      os: Deno.build.os,
      repo: {
        isRepo: h.store.repo.isRepo,
        init: () => Promise.reject(new Error("an import makes no repo")),
      },
    };
    let importResult: "imported" | "refused" | null = null;
    const runImport = async (at: string) => {
      if (at !== point) return;
      try {
        await importWorkspace(importDeps, { path: imported, name: "edge-dns" });
        importResult = "imported";
      } catch (error) {
        if (!(error instanceof UserError)) throw error;
        importResult = "refused";
      }
    };
    const base = h.deps();
    const registry = h.store.registry;
    let entryWritten = false;
    const deps = h.deps({
      provisioner: {
        async provision(dir, spec, signal) {
          await runImport("before set-up");
          await inProcessProvisioner.provision(dir, spec, signal);
          await runImport("after set-up");
        },
      },
      repository: {
        findByName: (n) => base.repository.findByName(n),
        remove: (n) => base.repository.remove(n),
        async save(workspace: HostedWorkspace) {
          await base.repository.save(workspace);
          await runImport("after the wanted file");
        },
      },
      workspaceStore: {
        ...h.store,
        registry: {
          load: () => registry.load(),
          async update(fn) {
            const result = await registry.update(fn);
            // the adopting first read writes too; this is the create's own entry
            const ours = (await registry.load())?.get("edge-dns")?.path ===
              join(h.dataDir, "workspaces", "edge-dns");
            if (ours && !entryWritten) {
              entryWritten = true;
              await runImport("after the entry");
            }
            return result;
          },
        },
      },
      rename: async (from, to) => {
        await runImport("before the rename");
        await Deno.rename(from, to);
      },
    });
    const events = await collect(
      hostedWorkspaceCreate(ctx, deps, {
        name: "edge-dns",
        caller: ALICE,
        access: ACCESS,
      }),
    );
    const location = join(h.dataDir, "workspaces");
    const entry = (await h.store.registry.load())?.get("edge-dns");
    assertEquals(importResult, winner);
    if (importResult === "imported") {
      const error = events.find((e) => e.kind === "error");
      assertEquals(
        error?.kind === "error" ? error.error.code : null,
        "already_exists",
      );
      assertEquals(entry?.path, await Deno.realPath(imported));
      assertEquals(await names(location), []);
      assertEquals(
        (await names(h.dir)).filter((n) => !n.startsWith(".")),
        [],
      );
    } else {
      assertEquals(events.map((e) => e.kind), ["completed"]);
      assertEquals(entry?.path, join(location, "edge-dns"));
    }
    assertEquals(
      await Deno.readTextFile(join(imported, ".swamp.yaml")),
      "kept: true\n",
    );
  });
}

Deno.test("hosted workspace services, no host folder: a workspace swamp workspace create made in the same location is refused by delete, and a hand-written deleted leaves its folder", async () => {
  await using h = await noFolderHost();
  const mine = join(h.dataDir, "workspaces", "mine");
  await Deno.mkdir(mine, { recursive: true });
  await Deno.writeTextFile(join(mine, ".swamp.yaml"), "");
  await h.store.registry.update((registry) => {
    registry.register({
      name: "mine",
      path: mine,
      createdAt: "2026-11-20T10:00:00.000Z",
      origin: "created",
    });
  });
  await h.rescan();
  const refused = await collect(
    hostedWorkspaceDelete(ctx, h.deps(), { name: "mine" }),
  );
  const error = refused.find((e) => e.kind === "error");
  assertEquals(
    error?.kind === "error" ? error.error.code : null,
    "operator_workspace",
  );

  // a creator and a folder written by hand for another folder make it no more the host's
  for (
    const yaml of [
      "wanted: deleted\n",
      `wanted: deleted\nfolder: ${mine}\n`,
      `creator: user:sub-alice\nwanted: deleted\nfolder: ${
        join(h.root, "elsewhere")
      }\n`,
    ]
  ) {
    await Deno.writeTextFile(join(h.dir, "mine.wanted.yaml"), yaml);
    await h.rescan();
    await h.drain();
    assert(await pathExists(join(mine, ".swamp.yaml")), `kept for ${yaml}`);
    assertEquals(await registeredNames(h), ["mine"]);
  }
});

Deno.test("hosted workspace services, no host folder: a host-created workspace that leaves the registry keeps its folder and loses its wanted file", async () => {
  await using h = await noFolderHost();
  await collect(
    hostedWorkspaceCreate(ctx, h.deps(), {
      name: "edge-dns",
      caller: ALICE,
      access: ACCESS,
    }),
  );
  await h.rescan();
  // as swamp workspace remove does
  await h.store.registry.update((registry) => {
    registry.remove("edge-dns");
  });
  await waitFor(async () => {
    await h.rescan();
    await h.drain();
    return !(await pathExists(join(h.dir, "edge-dns.wanted.yaml")));
  }, "the wanted file goes");
  assert(
    await pathExists(join(h.dataDir, "workspaces", "edge-dns", ".swamp.yaml")),
  );
});

Deno.test("hosted workspace services, no host folder: a removal whose entry, read afresh, names another folder removes no folder and no entry", async () => {
  let other: string | null = null;
  await using h = await noFolderHost((base) => ({
    ...base,
    registeredFolder: async (name) =>
      other ?? await base.registeredFolder(name),
  }));
  await collect(
    hostedWorkspaceCreate(ctx, h.deps(), {
      name: "edge-dns",
      caller: ALICE,
      access: ACCESS,
    }),
  );
  await h.rescan();
  await collect(hostedWorkspaceDelete(ctx, h.deps(), { name: "edge-dns" }));
  other = join(h.root, "projects", "edge-dns");
  await waitFor(async () => {
    await h.rescan();
    await h.drain();
    return !(await pathExists(join(h.dir, "edge-dns.wanted.yaml")));
  }, "the deleted wanted file is dropped");
  assert(
    await pathExists(join(h.dataDir, "workspaces", "edge-dns", ".swamp.yaml")),
  );
  assertEquals(await registeredNames(h), ["edge-dns"]);
});

Deno.test("hosted workspace services, no host folder: a stopped create's removal sweeps only the workspace location, never a folder its wanted file alone names", async () => {
  await using h = await noFolderHost();
  const elsewhere = join(h.root, "elsewhere");
  await Deno.mkdir(elsewhere);
  const decoy = join(elsewhere, creatingFolderName("edge-dns"));
  await Deno.mkdir(decoy);
  const leftover = join(
    h.dataDir,
    "workspaces",
    creatingFolderName("edge-dns"),
  );
  await Deno.mkdir(leftover, { recursive: true });
  await Deno.writeTextFile(
    join(h.dir, "edge-dns.wanted.yaml"),
    `creator: user:sub-alice\nwanted: deleted\nfolder: ${
      join(elsewhere, "edge-dns")
    }\n`,
  );
  await waitFor(async () => {
    await h.rescan();
    await h.drain();
    return !(await pathExists(join(h.dir, "edge-dns.wanted.yaml")));
  }, "the files go");
  assert(await pathExists(decoy), "a folder outside the location is kept");
  assert(!(await pathExists(leftover)), "the location's own leftover is swept");
});
