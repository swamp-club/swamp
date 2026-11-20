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
import { parse as parseYaml } from "@std/yaml";
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
import { hostedWorkspaceLock } from "../src/infrastructure/persistence/hosted_workspace_file_repository.ts";
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

const inProcessProvisioner: HostedWorkspaceProvisioner = {
  provision: (dir, spec) => provisionHostedWorkspace(dir, spec),
};

interface Host extends AsyncDisposable {
  readonly root: string;
  /** the state folder: wanted, status and lock files only */
  readonly dir: string;
  readonly dataDir: string;
  readonly configDir: string;
  /** where a create puts the repo when workspaces.dir is not set */
  readonly location: string;
  readonly store: HostedRegistryDeps;
  readonly port: CountingPort;
  deps(overrides?: Partial<HostedWorkspaceDeps>): HostedWorkspaceDeps;
  /** one host rescan, as the folder watcher runs it */
  rescan(): Promise<void>;
  wanted(name: string): string | undefined;
  drain(): Promise<void>;
  /** workspaces.dir, as swamp config set writes it */
  setLocation(dir: string): Promise<void>;
}

async function host(
  created?: (base: CreatedWorkspaceRemoval) => CreatedWorkspaceRemoval,
  options: { readonly linkedDataDir?: boolean } = {},
): Promise<Host> {
  const root = await Deno.makeTempDir();
  const dir = join(root, "state");
  const dataDir = join(root, "data");
  const configDir = join(root, "config");
  await Deno.mkdir(dir);
  await Deno.mkdir(configDir);
  // a data dir reached through a link, as a temp dir is on macOS
  if (options.linkedDataDir) {
    await Deno.mkdir(join(root, "data-real"));
    await Deno.symlink(join(root, "data-real"), dataDir, { type: "dir" });
  }
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
    stateDir: dir,
  });
  const reconciler = createWorkspaceReconciler({
    workspacesDir: dir,
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
  });
  const roster = createWorkspaceRoster({
    rootRepo: null,
    store,
    problems,
  });
  return {
    root,
    dir,
    dataDir,
    configDir,
    location: join(dataDir, "workspaces"),
    store,
    port,
    deps: (overrides = {}) => ({
      ...createHostedWorkspaceDeps({
        workspacesDir: dir,
        placement: hostWorkspacePlacement({ dataDir, configDir }),
        provisioner: inProcessProvisioner,
        addressOf: (name) => `https://host.example/w/${name}`,
        workspaceStore: store,
      }),
      ...overrides,
    }),
    rescan: async () => {
      const scan = await scanWorkspaces(dir);
      const reads = await readWantedFiles(repository, scan);
      reconciler.reconcile(scan, reads, await roster.read(reads));
    },
    wanted: (name) => supervisor.lookup(workspaceServe(name))?.wanted,
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

async function listedNames(deps: HostedWorkspaceDeps): Promise<string[]> {
  const events = await collect(hostedWorkspaceList(ctx, deps));
  const last = events[events.length - 1];
  assert(last.kind === "completed");
  return last.data.workspaces.map((w) => w.name);
}

/** looks at the location and runs the host at each step of a create */
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
      folders: (await names(h.location)).filter((n) =>
        !n.startsWith(".") && !n.endsWith(".lock")
      ),
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
  assertEquals(await names(h.location), ["edge-dns"]);
  assertEquals(h.port.spawned, [], "a new workspace has no serve");
  assertEquals(h.wanted("edge-dns"), "suspended");
  const auth = loadServeConfig(undefined, join(h.location, "edge-dns"))?.auth;
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
  assertEquals(last.error.message.includes(h.root), false);
  assertEquals(await names(h.dir), []);
  assertEquals(await names(h.location), []);
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
  assertEquals(await names(h.dir), []);
  assertEquals(await names(h.location), []);
});

Deno.test("hosted workspace services: a folder, a link or a wanted file holding the name refuses create", async () => {
  for (
    const setup of [
      (h: Host) => Deno.mkdir(join(h.location, "edge-dns")),
      (h: Host) =>
        Deno.symlink(
          join(h.location, "elsewhere"),
          join(h.location, "edge-dns"),
          { type: "dir" },
        ),
      (h: Host) =>
        Deno.writeTextFile(
          join(h.dir, "edge-dns.wanted.yaml"),
          "wanted: active\n",
        ),
    ]
  ) {
    await using h = await host();
    await Deno.mkdir(h.location, { recursive: true });
    await setup(h);
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

  await deleteAndSettle(h, "edge-dns");
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
  const folder = await Deno.realPath(join(h.location, "gamma"));
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
  await h.drain();

  for (
    const [name, code] of [
      ["gamma", "not_found"],
      ["beta", "operator_workspace"],
    ]
  ) {
    const refused = await collect(hostedWorkspaceDelete(ctx, deps, { name }));
    const last = refused[refused.length - 1];
    assert(last.kind === "error", name);
    assertEquals(last.error.code, code, name);
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
  const team = await Deno.realPath(join(h.location, "delta"));
  await Deno.writeTextFile(join(team, "TEAM_DATA.txt"), "keep me");
  await h.rescan();
  await h.store.registry.update((registry) => registry.remove("delta"));
  await importOutside(h, "delta");
  await h.rescan();

  const registryFile = join(h.configDir, "workspaces.json");
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
  const folder = await Deno.realPath(join(h.location, "gamma"));
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
async function deleteAndSettle(h: Host, name: string): Promise<void> {
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

async function registeredNames(h: Host): Promise<string[]> {
  return ((await h.store.registry.load())?.list() ?? []).map((e) => e.name)
    .sort();
}

Deno.test("hosted workspace services: create makes the repo in the data dir's workspaces, registers it as created, and delete removes the folder, the entry and both files", async () => {
  await using h = await host();
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
  assertEquals(entry?.path, await Deno.realPath(folder));
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

Deno.test("hosted workspace services: with workspaces.dir set the folder is made there, and delete removes it from there", async () => {
  await using h = await host();
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

Deno.test("hosted workspace services: the first create adopts the repos already in the data dir's workspaces", async () => {
  await using h = await host();
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
  h: Host,
  name: string,
  stop: typeof CREATE_STOPS[number],
): Promise<void> {
  const location = join(h.dataDir, "workspaces");
  await Deno.mkdir(location, { recursive: true });
  const temp = join(location, creatingFolderName(name));
  await Deno.mkdir(temp);
  const repoId = crypto.randomUUID();
  await Deno.writeTextFile(join(temp, ".swamp.yaml"), `repoId: ${repoId}\n`);
  if (stop === "set-up") return;
  const target = join(location, name);
  await Deno.writeTextFile(
    join(h.dir, `${name}.wanted.yaml`),
    `creator: user:sub-alice\nwanted: suspended\nchangedAt: 2026-11-20T10:00:00.000Z\nfolder: ${target}\nrepoId: ${repoId}\n`,
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
  Deno.test(`hosted workspace services: a create stopped after ${stop} leaves a name that is free, with no folder, once deleted or created again`, async () => {
    await using h = await host();
    await leaveCreateStopped(h, "edge-dns", stop);
    await h.rescan();
    await h.drain();
    if (stop === "wanted file") {
      // no create holds the name, so the host removes what it left
      assert(!(await pathExists(join(h.dir, "edge-dns.wanted.yaml"))));
      assertEquals(await names(join(h.dataDir, "workspaces")), []);
      const refused = await collect(
        hostedWorkspaceDelete(ctx, h.deps(), { name: "edge-dns" }),
      );
      const error = refused.find((e) => e.kind === "error");
      assertEquals(
        error?.kind === "error" ? error.error.code : null,
        "not_found",
      );
      return;
    }
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
  Deno.test(`hosted workspace services: an import of the same name ${point} wins or loses whole, and its folder is never renamed or removed`, async () => {
    await using h = await host();
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
            const location = await Deno.realPath(join(h.dataDir, "workspaces"))
              .catch(() => null);
            const ours = location !== null &&
              (await registry.load())?.get("edge-dns")?.path ===
                join(location, "edge-dns");
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
      assertEquals(
        entry?.path,
        await Deno.realPath(join(location, "edge-dns")),
      );
    }
    assertEquals(
      await Deno.readTextFile(join(imported, ".swamp.yaml")),
      "kept: true\n",
    );
  });
}

Deno.test("hosted workspace services: a workspace swamp workspace create made in the same location is refused by delete, and a hand-written deleted leaves its folder", async () => {
  await using h = await host();
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

Deno.test("hosted workspace services: a repo made again at a created workspace's folder while the host was stopped is the operator's own, and delete leaves it whole", async () => {
  await using h = await host();
  await collect(
    hostedWorkspaceCreate(ctx, h.deps(), {
      name: "edge-dns",
      caller: ALICE,
      access: ACCESS,
    }),
  );
  await collect(
    hostedWorkspaceResume(ctx, h.deps(), { name: "edge-dns", rootAdmin: true }),
  );
  const folder = (await h.store.registry.load())?.get("edge-dns")?.path;
  assert(folder !== undefined);
  // with the host stopped: swamp workspace remove, the folder deleted by hand, and swamp workspace create again
  await h.store.registry.update((registry) => {
    registry.remove("edge-dns");
  });
  await Deno.remove(folder, { recursive: true });
  await Deno.mkdir(folder);
  await Deno.writeTextFile(
    join(folder, ".swamp.yaml"),
    `repoId: ${crypto.randomUUID()}\n`,
  );
  await h.store.registry.update((registry) => {
    registry.register({
      name: "edge-dns",
      path: folder,
      createdAt: "2026-11-20T11:00:00.000Z",
      origin: "created",
    });
  });

  await waitFor(async () => {
    await h.rescan();
    await h.drain();
    return !(await pathExists(join(h.dir, "edge-dns.wanted.yaml")));
  }, "the stale wanted file goes");
  const refused = await collect(
    hostedWorkspaceDelete(ctx, h.deps(), { name: "edge-dns" }),
  );
  const error = refused.find((e) => e.kind === "error");
  assertEquals(
    error?.kind === "error" ? error.error.code : null,
    "operator_workspace",
  );
  await h.rescan();
  await h.drain();
  assert(await pathExists(join(folder, ".swamp.yaml")));
  assertEquals(await registeredNames(h), ["edge-dns"]);
});

Deno.test("hosted workspace services: a host-created workspace that leaves the registry keeps its folder and loses its wanted file", async () => {
  await using h = await host();
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

Deno.test("hosted workspace services: a removal whose entry, read afresh, names another folder removes no folder and no entry", async () => {
  let other: string | null = null;
  await using h = await host((base) => ({
    ...base,
    registeredFolder: async (name) =>
      other === null
        ? await base.registeredFolder(name)
        : { path: other, real: other },
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

Deno.test("hosted workspace services: a removal whose folder, read afresh, holds another repo removes no folder and no entry", async () => {
  let replace = false;
  await using h = await host((base) => ({
    ...base,
    registeredFolder: async (name) => {
      const registered = await base.registeredFolder(name);
      // the repo is made again between the delete request and the removal
      if (replace && registered !== null) {
        await Deno.writeTextFile(
          join(registered.real, ".swamp.yaml"),
          `repoId: ${crypto.randomUUID()}\n`,
        );
      }
      return registered;
    },
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
  replace = true;
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

Deno.test("hosted workspace services: a removal whose folder's marker cannot be read for a moment is tried again and finishes", async () => {
  let marker: string | null = null;
  let text = "";
  await using h = await host((base) => ({
    ...base,
    registeredFolder: async (name) => {
      const registered = await base.registeredFolder(name);
      // a directory where the marker was reads as unreadable, at the first attempt only
      if (registered !== null && marker === null) {
        marker = join(registered.real, ".swamp.yaml");
        text = await Deno.readTextFile(marker);
        await Deno.remove(marker);
        await Deno.mkdir(marker);
      }
      return registered;
    },
  }));
  await collect(
    hostedWorkspaceCreate(ctx, h.deps(), {
      name: "edge-dns",
      caller: ALICE,
      access: ACCESS,
    }),
  );
  await h.rescan();
  const events = await collect(
    hostedWorkspaceDelete(ctx, h.deps(), { name: "edge-dns" }),
  );
  assertEquals(events.map((e) => e.kind), ["completed"]);
  await waitFor(async () => {
    await h.rescan();
    await h.drain();
    return marker !== null;
  }, "the first removal attempt reads the marker");
  assert(await pathExists(join(h.dir, "edge-dns.wanted.yaml")), "kept");
  assert(marker !== null);
  await Deno.remove(marker);
  await Deno.writeTextFile(marker, text);
  await waitFor(async () => {
    await h.rescan();
    await h.drain();
    return !(await pathExists(join(h.dir, "edge-dns.wanted.yaml")));
  }, "the removal finishes");
  assertEquals(await names(join(h.dataDir, "workspaces")), []);
  assertEquals(await registeredNames(h), []);
});

Deno.test("hosted workspace services: a stopped create's removal sweeps only the workspace location, never a folder its wanted file alone names", async () => {
  await using h = await host();
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

async function reimportElsewhere(
  h: Host,
  name: string,
): Promise<string> {
  const imported = join(h.root, "projects", name);
  await Deno.mkdir(imported, { recursive: true });
  await Deno.writeTextFile(join(imported, ".swamp.yaml"), "kept: true\n");
  const real = await Deno.realPath(imported);
  // swamp workspace remove, then swamp workspace import, between two rescans
  await h.store.registry.update((registry) => {
    registry.remove(name);
    registry.register({
      name,
      path: real,
      createdAt: "2026-11-20T11:00:00.000Z",
      origin: "imported",
    });
  });
  return real;
}

async function assertDeleteRefused(h: Host, name: string) {
  const refused = await collect(
    hostedWorkspaceDelete(ctx, h.deps(), { name }),
  );
  const error = refused.find((e) => e.kind === "error");
  assertEquals(
    error?.kind === "error" ? error.error.code : null,
    "operator_workspace",
  );
}

Deno.test("hosted workspace services: a root admin's resume of a repo imported under a host-created name keeps it the operator's own, and delete is refused", async () => {
  await using h = await host();
  await collect(
    hostedWorkspaceCreate(ctx, h.deps(), {
      name: "edge-dns",
      caller: ALICE,
      access: ACCESS,
    }),
  );
  await h.rescan();
  const imported = await reimportElsewhere(h, "edge-dns");
  // no rescan yet: the wanted file with the creator is still there
  const resumed = await collect(
    hostedWorkspaceResume(ctx, h.deps(), { name: "edge-dns", rootAdmin: true }),
  );
  assertEquals(resumed.map((e) => e.kind), ["completed"]);
  const wanted = parseYaml(
    await Deno.readTextFile(join(h.dir, "edge-dns.wanted.yaml")),
  ) as Record<string, unknown>;
  assertEquals(wanted.creator, null);
  assertEquals(wanted.folder, imported);
  await h.rescan();
  await h.drain();
  await assertDeleteRefused(h, "edge-dns");
  await h.rescan();
  await h.drain();
  assertEquals(
    await Deno.readTextFile(join(imported, ".swamp.yaml")),
    "kept: true\n",
  );
  assertEquals(
    (await h.store.registry.load())?.get("edge-dns")?.path,
    imported,
  );
});

Deno.test("hosted workspace services: a host-created wanted file whose name now holds another folder is removed, so writing that folder by hand starts it as the operator's own", async () => {
  await using h = await host();
  await collect(
    hostedWorkspaceCreate(ctx, h.deps(), {
      name: "edge-dns",
      caller: ALICE,
      access: ACCESS,
    }),
  );
  await h.rescan();
  const imported = await reimportElsewhere(h, "edge-dns");
  await waitFor(async () => {
    await h.rescan();
    await h.drain();
    return !(await pathExists(join(h.dir, "edge-dns.wanted.yaml")));
  }, "the stale wanted file goes");
  // as the host's log advises
  await Deno.writeTextFile(
    join(h.dir, "edge-dns.wanted.yaml"),
    `wanted: active\nfolder: ${imported}\n`,
  );
  await h.rescan();
  await assertDeleteRefused(h, "edge-dns");
  assert(await pathExists(join(imported, ".swamp.yaml")));
  assert(
    await pathExists(join(h.dataDir, "workspaces", "edge-dns", ".swamp.yaml")),
    "the created folder, no longer registered, is kept",
  );
});

Deno.test("hosted workspace services: with the data dir reached through a link, delete removes the folder and its entry, and the name can be created again", async () => {
  await using h = await host(undefined, { linkedDataDir: true });
  for (const round of [1, 2]) {
    const created = await collect(
      hostedWorkspaceCreate(ctx, h.deps(), {
        name: "edge-dns",
        caller: ALICE,
        access: ACCESS,
      }),
    );
    assertEquals(created.map((e) => e.kind), ["completed"], `round ${round}`);
    await h.rescan();
    await collect(hostedWorkspaceResume(ctx, h.deps(), { name: "edge-dns" }));
    await h.rescan();
    await deleteAndSettle(h, "edge-dns");
    assertEquals(await registeredNames(h), [], `round ${round}`);
    assertEquals(await names(join(h.root, "data-real", "workspaces")), []);
  }
});

Deno.test("hosted workspace services: a create stopped before it registered is settled by the host, so a later swamp workspace create of the name stays the operator's own", async () => {
  await using h = await host();
  await leaveCreateStopped(h, "edge-dns", "wanted file");
  // a create still holding the name is left alone
  const held = hostedWorkspaceLock(h.dir, "edge-dns", 1_000);
  await held.acquire();
  try {
    await h.rescan();
    await h.drain();
    assert(await pathExists(join(h.dir, "edge-dns.wanted.yaml")), "kept");
  } finally {
    await held.release();
  }
  await h.rescan();
  await h.drain();
  assert(!(await pathExists(join(h.dir, "edge-dns.wanted.yaml"))));
  assertEquals(await names(join(h.dataDir, "workspaces")), []);

  // as swamp workspace create does, at the folder the stopped create named
  const mine = join(h.dataDir, "workspaces", "edge-dns");
  await Deno.mkdir(mine, { recursive: true });
  await Deno.writeTextFile(join(mine, ".swamp.yaml"), "");
  await h.store.registry.update((registry) => {
    registry.register({
      name: "edge-dns",
      path: mine,
      createdAt: "2026-11-20T12:00:00.000Z",
      origin: "created",
    });
  });
  await h.rescan();
  await assertDeleteRefused(h, "edge-dns");
  assert(await pathExists(join(mine, ".swamp.yaml")));
});

Deno.test("hosted workspace services: a suspend or resume while the registry cannot be read keeps a host-created workspace the host's own", async () => {
  await using h = await host();
  await collect(
    hostedWorkspaceCreate(ctx, h.deps(), {
      name: "edge-dns",
      caller: ALICE,
      access: ACCESS,
    }),
  );
  await collect(hostedWorkspaceResume(ctx, h.deps(), { name: "edge-dns" }));
  await h.rescan();
  const registryFile = join(h.configDir, "workspaces.json");
  const good = await Deno.readTextFile(registryFile);
  await Deno.writeTextFile(registryFile, "{no");

  const refused = await collect(
    hostedWorkspaceSuspend(ctx, h.deps(), { name: "edge-dns" }),
  );
  const error = refused.find((e) => e.kind === "error");
  assert(error?.kind === "error");
  assertEquals(error.error.code, "operator_workspace");
  assertStringIncludes(
    error.error.message,
    "cannot read its workspace registry",
  );

  const suspended = await collect(
    hostedWorkspaceSuspend(ctx, h.deps(), {
      name: "edge-dns",
      rootAdmin: true,
    }),
  );
  assertEquals(suspended.map((e) => e.kind), ["completed"]);
  const wanted = parseYaml(
    await Deno.readTextFile(join(h.dir, "edge-dns.wanted.yaml")),
  ) as Record<string, unknown>;
  assertEquals(wanted.creator, ALICE.principal);

  await Deno.writeTextFile(registryFile, good);
  await h.rescan();
  await deleteAndSettle(h, "edge-dns");
  assertEquals(await registeredNames(h), []);
  assertEquals(await names(join(h.dataDir, "workspaces")), []);
});
