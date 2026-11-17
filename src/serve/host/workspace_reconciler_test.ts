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

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import {
  type ServeId,
  serveIdKey,
  workspaceServe,
} from "../../domain/serve/managed_serve.ts";
import { HostedWorkspaceFileRepository } from "../../infrastructure/persistence/hosted_workspace_file_repository.ts";
import type { ListenedServe } from "../listening_line.ts";
import type {
  ServeChild,
  ServeChildExit,
  ServeChildSpec,
  ServeProcessPort,
} from "./serve_process.ts";
import { createStatusWriter, type StatusWriter } from "./status_writer.ts";
import { createServeSupervisor, type ServeSupervisor } from "./supervisor.ts";
import {
  deletingFolderName,
  REPO_MARKER_FILE,
  scanWorkspaces,
} from "./workspace_folder.ts";
import {
  createWorkspaceReconciler,
  readWantedFiles,
  type WorkspaceReconciler,
} from "./workspace_reconciler.ts";

class Child implements ServeChild {
  readonly listening: Promise<ListenedServe>;
  readonly ready: Promise<void>;
  readonly exited: Promise<ServeChildExit>;
  readonly #exited = Promise.withResolvers<ServeChildExit>();
  ignoresTerminate = false;

  constructor(readonly spec: ServeChildSpec, crashes: boolean) {
    this.listening = crashes
      ? Promise.reject(new Error("crashed"))
      : Promise.resolve({ port: 40_000, authMode: "token" });
    this.ready = crashes
      ? Promise.reject(new Error("crashed"))
      : Promise.resolve();
    this.listening.catch(() => {});
    this.ready.catch(() => {});
    this.exited = this.#exited.promise;
    if (crashes) this.exit(1);
  }

  exit(code: number): void {
    this.#exited.resolve({ code, stderrTail: [`exit ${code}`] });
  }

  terminate(): void {
    if (!this.ignoresTerminate) this.exit(0);
  }

  reload(): void {}

  kill(): void {
    this.exit(137);
  }

  release(): Promise<void> {
    return Promise.resolve();
  }
}

class Port implements ServeProcessPort {
  readonly children: Child[] = [];
  readonly crashing = new Set<string>();
  ignoreTerminate = false;

  spawn(spec: ServeChildSpec): ServeChild {
    const name = spec.id.kind === "workspace" ? spec.id.name : "root";
    const child = new Child(spec, this.crashing.has(name));
    child.ignoresTerminate = this.ignoreTerminate;
    this.children.push(child);
    return child;
  }

  of(name: string): Child[] {
    return this.children.filter((c) =>
      serveIdKey(c.spec.id) === `workspace:${name}`
    );
  }
}

interface Harness extends AsyncDisposable {
  readonly dir: string;
  readonly port: Port;
  readonly supervisor: ServeSupervisor;
  readonly statusWriter: StatusWriter;
  readonly reconciler: WorkspaceReconciler;
  readonly repository: HostedWorkspaceFileRepository;
  begin(): Promise<readonly string[]>;
  rescan(): Promise<void>;
  observed(name: string): string | undefined;
}

async function harness(): Promise<Harness> {
  const dir = await Deno.makeTempDir();
  const port = new Port();
  const statusWriter = createStatusWriter({ workspacesDir: dir });
  const supervisor = createServeSupervisor({
    processPort: port,
    onStatus: (status) => statusWriter.report(status),
    policy: {
      restartDelayMs: 1,
      initialBackoffMs: 1,
      maxBackoffMs: 1,
      crashWindowMs: 600_000,
      maxCrashesInWindow: 2,
    },
  });
  const repository = new HostedWorkspaceFileRepository(dir);
  const reconciler = createWorkspaceReconciler({
    workspacesDir: dir,
    supervisor,
    specOf: (name) => ({
      id: workspaceServe(name),
      repoDir: join(dir, name),
      address: `http://127.0.0.1/w/${name}`,
      trustedHost: "127.0.0.1",
      env: {},
    }),
    repository,
    statusWriter,
  });
  return {
    dir,
    port,
    supervisor,
    statusWriter,
    reconciler,
    repository,
    async begin() {
      const scan = await scanWorkspaces(dir);
      return reconciler.begin(scan, await readWantedFiles(repository, scan));
    },
    async rescan() {
      await reconciler.reconcile(await scanWorkspaces(dir));
    },
    observed(name) {
      return supervisor.lookup(workspaceServe(name))?.observed;
    },
    async [Symbol.asyncDispose]() {
      for (const child of port.children) child.ignoresTerminate = false;
      await supervisor.shutdown();
      await reconciler.drain();
      await statusWriter.drain();
      if (Deno.build.os === "windows") {
        await Deno.remove(dir, { recursive: true }).catch(() => {});
      } else {
        await Deno.remove(dir, { recursive: true });
      }
    },
  };
}

async function makeRepo(dir: string, name: string): Promise<void> {
  await Deno.mkdir(join(dir, name), { recursive: true });
  await Deno.writeTextFile(join(dir, name, REPO_MARKER_FILE), "");
}

async function want(dir: string, name: string, yaml: string): Promise<void> {
  await Deno.writeTextFile(join(dir, `${name}.wanted.yaml`), yaml);
}

async function entries(dir: string): Promise<string[]> {
  return (await Array.fromAsync(Deno.readDir(dir))).map((e) => e.name).sort();
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

const id = (name: string): ServeId => workspaceServe(name);

Deno.test("createWorkspaceReconciler: at startup a suspended workspace is not started and a deleted one is removed", async () => {
  await using h = await harness();
  await makeRepo(h.dir, "running");
  await makeRepo(h.dir, "parked");
  await makeRepo(h.dir, "doomed");
  await want(h.dir, "parked", "wanted: suspended\n");
  await want(h.dir, "doomed", "wanted: deleted\n");
  await Deno.writeTextFile(join(h.dir, "doomed.status.yaml"), "state: ready\n");

  assertEquals(await h.begin(), ["parked", "running"]);
  assertEquals(h.port.of("running").length, 1);
  assertEquals(h.port.of("parked").length, 0);
  assertEquals(h.supervisor.lookup(id("parked"))?.wanted, "suspended");
  assertEquals(h.port.of("doomed").length, 0);
  await h.reconciler.drain();
  assertEquals(h.supervisor.lookup(id("doomed")), undefined);
  assert(!(await exists(join(h.dir, "doomed"))));
  assert(!(await exists(join(h.dir, "doomed.status.yaml"))));
  assert(!(await exists(join(h.dir, "doomed.wanted.yaml"))));
});

Deno.test("createWorkspaceReconciler: editing the wanted file suspends and resumes a running workspace", async () => {
  await using h = await harness();
  await makeRepo(h.dir, "edge-dns");
  await h.begin();
  await waitFor(() => h.observed("edge-dns") === "ready", "ready");

  await want(h.dir, "edge-dns", "wanted: suspended\n");
  await h.rescan();
  await waitFor(() => h.observed("edge-dns") === "stopped", "stopped");
  assertEquals(h.supervisor.lookup(id("edge-dns"))?.wanted, "suspended");

  await want(h.dir, "edge-dns", "wanted: active\n");
  await h.rescan();
  await waitFor(() => h.observed("edge-dns") === "ready", "ready again");
  assertEquals(h.port.of("edge-dns").length, 2);
});

Deno.test("createWorkspaceReconciler: a failed workspace resumes when its active record changes, not on a rescan of the same record", async () => {
  await using h = await harness();
  await makeRepo(h.dir, "edge-dns");
  await want(h.dir, "edge-dns", "wanted: active\n");
  h.port.crashing.add("edge-dns");
  await h.begin();
  await waitFor(() => h.observed("edge-dns") === "failed", "failed");
  const spawns = h.port.of("edge-dns").length;

  await h.rescan();
  assertEquals(h.port.of("edge-dns").length, spawns, "unchanged: no resume");

  h.port.crashing.delete("edge-dns");
  await want(
    h.dir,
    "edge-dns",
    "wanted: active\nchangedAt: 2026-11-17T12:00:00.000Z\n",
  );
  await h.rescan();
  await waitFor(() => h.observed("edge-dns") === "ready", "resumed");
});

Deno.test("createWorkspaceReconciler: an unreadable wanted file leaves the workspace as it is and is reported", async () => {
  await using h = await harness();
  await makeRepo(h.dir, "edge-dns");
  await makeRepo(h.dir, "fresh");
  await want(h.dir, "fresh", "wanted: [\n");
  assertEquals(
    await h.begin(),
    ["edge-dns", "fresh"],
    "unreadable at start counts as no file",
  );
  await waitFor(() => h.observed("edge-dns") === "ready", "ready");

  await want(h.dir, "edge-dns", "wanted: suspend\n");
  await h.rescan();
  await h.statusWriter.drain();
  assertEquals(h.observed("edge-dns"), "ready");
  const status = await Deno.readTextFile(join(h.dir, "edge-dns.status.yaml"));
  assert(status.includes("cannot be read"), status);

  await want(h.dir, "edge-dns", "wanted: suspended\n");
  await h.rescan();
  await waitFor(() => h.observed("edge-dns") === "stopped", "stopped");
});

Deno.test("createWorkspaceReconciler: an active wanted file without a folder is left alone until the folder appears", async () => {
  await using h = await harness();
  await want(h.dir, "coming", "wanted: active\ncreator: alice\n");
  assertEquals(await h.begin(), []);
  await h.rescan();
  await h.reconciler.drain();
  assertEquals(h.supervisor.lookup(id("coming")), undefined);
  assertEquals(await entries(h.dir), ["coming.wanted.yaml"]);

  await makeRepo(h.dir, "coming");
  await h.rescan();
  await waitFor(() => h.observed("coming") === "ready", "started");
});

Deno.test("createWorkspaceReconciler: a folder removed by hand stops its serve and leaves no status file", async () => {
  await using h = await harness();
  await makeRepo(h.dir, "edge-dns");
  await h.begin();
  await waitFor(() => h.observed("edge-dns") === "ready", "ready");
  await h.statusWriter.drain();
  assert(await exists(join(h.dir, "edge-dns.status.yaml")));

  await Deno.remove(join(h.dir, "edge-dns"), { recursive: true });
  await h.rescan();
  await h.reconciler.drain();
  await h.statusWriter.drain();
  assertEquals(h.supervisor.lookup(id("edge-dns"))?.wanted, "deleted");
  assertEquals(await entries(h.dir), []);

  await makeRepo(h.dir, "edge-dns");
  await h.rescan();
  await waitFor(() => h.observed("edge-dns") === "ready", "re-added");
  await h.statusWriter.drain();
  assert(await exists(join(h.dir, "edge-dns.status.yaml")));
});

Deno.test("createWorkspaceReconciler: a deleted workspace is stopped before its folder goes, an edit back is ignored, and nothing is left", async () => {
  await using h = await harness();
  await makeRepo(h.dir, "edge-dns");
  await Deno.writeTextFile(join(h.dir, "edge-dns", "data.txt"), "keep?");
  h.port.ignoreTerminate = true;
  await h.begin();
  await waitFor(() => h.observed("edge-dns") === "ready", "ready");

  await want(h.dir, "edge-dns", "wanted: deleted\n");
  await h.rescan();
  assertEquals(h.supervisor.lookup(id("edge-dns"))?.wanted, "deleted");
  assert(
    await exists(join(h.dir, "edge-dns", "data.txt")),
    "kept while the serve drains",
  );

  await want(h.dir, "edge-dns", "wanted: active\n");
  await h.rescan();
  h.port.of("edge-dns")[0].exit(0);
  await h.reconciler.drain();
  await h.statusWriter.drain();
  assertEquals(await entries(h.dir), []);
  assertEquals(h.supervisor.lookup(id("edge-dns"))?.wanted, "deleted");
  assertEquals(h.port.of("edge-dns").length, 1);
});

Deno.test("createWorkspaceReconciler: a leftover hidden folder from an interrupted removal is swept", async () => {
  await using h = await harness();
  const leftover = deletingFolderName("edge-dns");
  await makeRepo(h.dir, leftover);
  await h.begin();
  await h.reconciler.drain();
  assertEquals(await entries(h.dir), []);
});

Deno.test({
  name:
    "createWorkspaceReconciler: a workspace folder that is a link loses only its link",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await using h = await harness();
    const elsewhere = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(elsewhere, REPO_MARKER_FILE), "");
      await Deno.writeTextFile(join(elsewhere, "precious.txt"), "x");
      await Deno.symlink(elsewhere, join(h.dir, "linked"), { type: "dir" });
      await want(h.dir, "linked", "wanted: deleted\n");
      await h.begin();
      await h.reconciler.drain();
      assertEquals(await entries(h.dir), []);
      assert(await exists(join(elsewhere, "precious.txt")));
    } finally {
      await Deno.remove(elsewhere, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "createWorkspaceReconciler: a removal that failed is tried again at the next rescan, even after the file is edited back",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await using h = await harness();
    await makeRepo(h.dir, "edge-dns");
    await h.begin();
    await waitFor(() => h.observed("edge-dns") === "ready", "ready");

    await want(h.dir, "edge-dns", "wanted: deleted\n");
    // a folder that cannot be renamed out of makes the removal fail
    await Deno.chmod(h.dir, 0o555);
    try {
      await h.rescan();
      await h.reconciler.drain();
    } finally {
      await Deno.chmod(h.dir, 0o755);
    }
    assert(await exists(join(h.dir, "edge-dns")), "the removal failed");

    await want(h.dir, "edge-dns", "wanted: active\n");
    await h.rescan();
    await h.reconciler.drain();
    await h.statusWriter.drain();
    assertEquals(await entries(h.dir), []);
    assertEquals(h.port.of("edge-dns").length, 1, "never started again");
  },
});
