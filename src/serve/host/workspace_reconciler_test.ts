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

import { configure, type LogRecord, reset } from "@logtape/logtape";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { waitFor } from "@swamp-club/swamp-testing";
import {
  type ServeId,
  serveIdKey,
  workspaceServe,
} from "../../domain/serve/managed_serve.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
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
  type WorkspaceScan,
} from "../../infrastructure/persistence/hosted_workspace_folder_scan.ts";
import {
  createWorkspaceReconciler,
  readWantedFiles,
  ReasonMemo,
  type WantedReads,
  type WorkspaceReconciler,
} from "./workspace_reconciler.ts";
import type { HostedWorkspaceFolder } from "../../libswamp/workspace/hosted_roster.ts";
import type { WorkspaceRegistrar } from "./workspace_registration.ts";
import type { WorkspaceFolders } from "./workspace_roster.ts";

/** records what the reconciler asks of the registry; writes nothing */
class RecordingRegistrar implements WorkspaceRegistrar {
  readonly calls: string[] = [];
  served: () => readonly string[] = () => [];
  onUnregister: (name: string) => Promise<void> = () => Promise.resolve();

  sync(served: () => readonly string[]): void {
    this.served = served;
  }

  async unregister(name: string): Promise<void> {
    this.calls.push(`unregister:${name}`);
    await this.onUnregister(name);
  }

  forget(name: string): void {
    this.calls.push(`forget:${name}`);
  }

  close(): void {}

  drain(): Promise<void> {
    return Promise.resolve();
  }
}

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

interface Registered {
  folder: string;
  isRepo?: boolean;
  fromWantedFile?: boolean;
  shadows?: boolean;
}

interface Harness extends AsyncDisposable {
  readonly dir: string;
  readonly port: Port;
  readonly supervisor: ServeSupervisor;
  readonly statusWriter: StatusWriter;
  readonly reconciler: WorkspaceReconciler;
  readonly repository: HostedWorkspaceFileRepository;
  readonly registrar: RecordingRegistrar;
  /** a workspace's folder when it is not the scanned one, as a registry entry gives */
  readonly moved: Map<string, string>;
  /** registry entries outside the folder: the operator's own, at these folders */
  readonly registered: Map<string, Registered>;
  gone: string[];
  /** a wanted file's match as the roster would give it, where the default rule does not */
  readonly wantedMatch: Map<string, boolean>;
  /** names the registry holds though they are not listed */
  readonly stillRegistered: Set<string>;
  foldersOf(scan: WorkspaceScan, reads: WantedReads): WorkspaceFolders;
  begin(): Promise<readonly string[]>;
  rescan(): Promise<void>;
  /** reconciles a scan taken earlier, reading its wanted files now */
  reconcileScan(scan: WorkspaceScan): Promise<void>;
  observed(name: string): string | undefined;
}

async function harness(
  rename?: (from: string, to: string) => Promise<void>,
  freshClaim?: (name: string) => Promise<string | null>,
): Promise<Harness> {
  const registrar = new RecordingRegistrar();
  const dir = await Deno.makeTempDir();
  const port = new Port();
  // a short retry, since one test makes status writes fail on purpose
  const statusWriter = createStatusWriter({ workspacesDir: dir, retryMs: 10 });
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
    specOf: (name, folder) => ({
      id: workspaceServe(name),
      repoDir: folder,
      address: `http://127.0.0.1/w/${name}`,
      trustedHost: "127.0.0.1",
      env: {},
    }),
    repository,
    statusWriter,
    registrar,
    rename,
    freshClaim,
  });
  const moved = new Map<string, string>();
  const registered = new Map<string, Registered>();
  const wantedMatch = new Map<string, boolean>();
  const stillRegistered = new Set<string>();
  const state = { gone: [] as string[] };
  const foldersOf = (
    scan: WorkspaceScan,
    reads: WantedReads,
  ): WorkspaceFolders => {
    const workspaces = new Map<string, HostedWorkspaceFolder>();
    for (const [name, entry] of registered) {
      workspaces.set(name, {
        name,
        folder: entry.folder,
        owner: "operator",
        isRepo: entry.isRepo ?? true,
        fromWantedFile: entry.fromWantedFile ?? false,
        shadows: entry.shadows ?? false,
      });
    }
    const claimed = new Set([...registered.values()].map((r) => r.folder));
    for (const name of scan.workspaces) {
      if (workspaces.has(name) || claimed.has(join(dir, name))) continue;
      workspaces.set(name, {
        name,
        folder: moved.get(name) ?? join(dir, name),
        owner: "host",
        isRepo: true,
        fromWantedFile: false,
        shadows: false,
      });
    }
    const wantedMatches = new Map<string, boolean>();
    for (const [name, read] of reads) {
      if (read.kind !== "found") continue;
      const listing = workspaces.get(name);
      wantedMatches.set(
        name,
        wantedMatch.get(name) ??
          (read.workspace.folder === null
            ? listing?.owner !== "operator"
            : read.workspace.folder === (listing?.folder ?? join(dir, name))),
      );
    }
    const passedOver = scan.workspaces.filter((name) =>
      workspaces.get(name)?.owner === "operator" || claimed.has(join(dir, name))
    );
    return {
      workspaces,
      wantedMatches,
      gone: state.gone,
      passedOver,
      registered: new Set([...registered.keys(), ...stillRegistered]),
    };
  };
  const reconcileScan = async (scan: WorkspaceScan) => {
    const reads = await readWantedFiles(repository, scan);
    reconciler.reconcile(scan, reads, foldersOf(scan, reads));
  };
  return {
    dir,
    port,
    supervisor,
    statusWriter,
    reconciler,
    repository,
    registrar,
    moved,
    registered,
    wantedMatch,
    stillRegistered,
    get gone() {
      return state.gone;
    },
    set gone(names: string[]) {
      state.gone = names;
    },
    foldersOf,
    reconcileScan,
    async begin() {
      const scan = await scanWorkspaces(dir);
      const reads = await readWantedFiles(repository, scan);
      return reconciler.begin(scan, reads, foldersOf(scan, reads));
    },
    async rescan() {
      await reconcileScan(await scanWorkspaces(dir));
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

async function notStartedLines(fn: () => Promise<void>): Promise<string[]> {
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => records.push(record) },
    loggers: [
      {
        category: ["serve", "host", "workspaces"],
        lowestLevel: "info",
        sinks: ["capture"],
      },
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
    ],
    reset: true,
  });
  try {
    await fn();
  } finally {
    await reset();
    await initializeLogging({});
  }
  return records
    .map((record) => record.message.map(String).join(""))
    .filter((message) => message.includes("is listed and not started"));
}

Deno.test("createWorkspaceReconciler: at startup a suspended workspace is not started and a deleted one is removed", async () => {
  await using h = await harness();
  await makeRepo(h.dir, "running");
  await makeRepo(h.dir, "parked");
  await makeRepo(h.dir, "doomed");
  await want(h.dir, "running", "wanted: active\n");
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

Deno.test("createWorkspaceReconciler: served leaves out a workspace being deleted while its folder is still listed, and after", async () => {
  const gate = Promise.withResolvers<void>();
  const renameStarted = Promise.withResolvers<void>();
  await using h = await harness(async (from, to) => {
    renameStarted.resolve();
    await gate.promise;
    await Deno.rename(from, to);
  });
  await makeRepo(h.dir, "never");
  await makeRepo(h.dir, "running");
  await want(h.dir, "never", "wanted: deleted\n");
  await want(h.dir, "running", "wanted: active\n");

  assertEquals(await h.begin(), ["running"]);
  assertEquals(h.reconciler.served(), ["running"]);

  await want(h.dir, "running", "wanted: deleted\n");
  await h.rescan();
  await renameStarted.promise;
  const stale = await scanWorkspaces(h.dir);
  assertEquals(stale.workspaces, ["never", "running"]);
  assertEquals(h.reconciler.served(), [], "both folders are listed");

  gate.resolve();
  await h.reconciler.drain();
  assertEquals(h.supervisor.lookup(id("running"))?.wanted, "deleted");
  assertEquals(h.reconciler.served(), [], "after the removal");
  assertEquals(h.reconciler.served(), []);
});

Deno.test("createWorkspaceReconciler: a workspace's folder that changes is used at its next start, and a running serve is left alone", async () => {
  await using h = await harness();
  await makeRepo(h.dir, "edge-dns");
  await want(h.dir, "edge-dns", "wanted: active\n");
  await h.begin();
  await waitFor(() => h.observed("edge-dns") === "ready", "ready");
  assertEquals(h.port.of("edge-dns")[0].spec.repoDir, join(h.dir, "edge-dns"));

  const elsewhere = join(h.dir, "..", "registered", "edge-dns");
  h.moved.set("edge-dns", elsewhere);
  await h.rescan();
  assertEquals(h.port.of("edge-dns").length, 1, "not restarted");
  assertEquals(h.observed("edge-dns"), "ready");

  await want(h.dir, "edge-dns", "wanted: suspended\n");
  await h.rescan();
  await waitFor(() => h.observed("edge-dns") === "stopped", "stopped");
  await want(h.dir, "edge-dns", "wanted: active\n");
  await h.rescan();
  await waitFor(() => h.observed("edge-dns") === "ready", "ready again");
  assertEquals(h.port.of("edge-dns").length, 2);
  assertEquals(h.port.of("edge-dns")[1].spec.repoDir, elsewhere);
});

Deno.test("createWorkspaceReconciler: editing the wanted file suspends and resumes a running workspace", async () => {
  await using h = await harness();
  await makeRepo(h.dir, "edge-dns");
  await want(h.dir, "edge-dns", "wanted: active\n");
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
  await want(h.dir, "edge-dns", "wanted: active\n");
  await want(h.dir, "fresh", "wanted: [\n");
  assertEquals(await h.begin(), ["edge-dns", "fresh"]);
  await waitFor(() => h.observed("edge-dns") === "ready", "ready");
  assertEquals(
    h.port.of("fresh").length,
    0,
    "unreadable with none read starts nothing",
  );
  await h.statusWriter.drain();
  const fresh = await Deno.readTextFile(join(h.dir, "fresh.status.yaml"));
  assert(fresh.includes("cannot be read"), fresh);
  assert(fresh.includes("wanted: suspended"), fresh);

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
  await want(h.dir, "edge-dns", "wanted: active\n");
  await h.begin();
  await waitFor(() => h.observed("edge-dns") === "ready", "ready");
  await h.statusWriter.drain();
  assert(await exists(join(h.dir, "edge-dns.status.yaml")));

  await Deno.remove(join(h.dir, "edge-dns"), { recursive: true });
  await h.rescan();
  await h.reconciler.drain();
  await h.statusWriter.drain();
  assertEquals(h.supervisor.lookup(id("edge-dns"))?.wanted, "deleted");
  assertEquals(await entries(h.dir), ["edge-dns.wanted.yaml"]);

  await makeRepo(h.dir, "edge-dns");
  await h.rescan();
  await waitFor(() => h.observed("edge-dns") === "ready", "re-added");
  await h.statusWriter.drain();
  assert(await exists(join(h.dir, "edge-dns.status.yaml")));
});

Deno.test("createWorkspaceReconciler: a folder added back by hand after its folder and wanted file were removed is not started", async () => {
  await using h = await harness();
  await makeRepo(h.dir, "edge-dns");
  await want(h.dir, "edge-dns", "wanted: active\n");
  await h.begin();
  await waitFor(() => h.observed("edge-dns") === "ready", "ready");

  await Deno.remove(join(h.dir, "edge-dns"), { recursive: true });
  await Deno.remove(join(h.dir, "edge-dns.wanted.yaml"));
  await h.rescan();
  await h.reconciler.drain();
  assertEquals(h.supervisor.lookup(id("edge-dns"))?.wanted, "deleted");

  await makeRepo(h.dir, "edge-dns");
  await h.rescan();
  await h.reconciler.drain();
  await h.statusWriter.drain();
  assertEquals(h.supervisor.lookup(id("edge-dns"))?.wanted, "suspended");
  assertEquals(h.port.of("edge-dns").length, 1, "not started again");
});

Deno.test("createWorkspaceReconciler: a deleted workspace is stopped before its folder goes, an edit back is ignored, and nothing is left", async () => {
  await using h = await harness();
  await makeRepo(h.dir, "edge-dns");
  await Deno.writeTextFile(join(h.dir, "edge-dns", "data.txt"), "keep?");
  await want(h.dir, "edge-dns", "wanted: active\n");
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
  // root ignores folder permissions, so the removal would not fail
  ignore: Deno.build.os === "windows" || Deno.uid() === 0,
  fn: async () => {
    await using h = await harness();
    await makeRepo(h.dir, "edge-dns");
    await want(h.dir, "edge-dns", "wanted: active\n");
    await h.begin();
    await waitFor(() => h.observed("edge-dns") === "ready", "ready");

    await want(h.dir, "edge-dns", "wanted: deleted\n");
    // a write in flight when the folder turns read-only would leave its temp file
    await h.statusWriter.drain();
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

Deno.test("createWorkspaceReconciler: a scan listed before a removal finished does not start the workspace again", async () => {
  await using h = await harness();
  await makeRepo(h.dir, "edge-dns");
  await want(h.dir, "edge-dns", "wanted: active\n");
  await h.begin();
  await waitFor(() => h.observed("edge-dns") === "ready", "ready");
  await want(h.dir, "edge-dns", "wanted: deleted\n");
  const stale = await scanWorkspaces(h.dir);

  await h.rescan();
  await h.reconciler.drain();
  assertEquals(await entries(h.dir), []);

  await h.reconcileScan(stale);
  await h.reconciler.drain();
  await h.statusWriter.drain();
  assertEquals(h.port.of("edge-dns").length, 1, "not started again");
  assertEquals(h.supervisor.lookup(id("edge-dns"))?.wanted, "deleted");
  assertEquals(await entries(h.dir), [], "no status file comes back");

  await makeRepo(h.dir, "edge-dns");
  await h.rescan();
  await h.reconciler.drain();
  assertEquals(h.port.of("edge-dns").length, 1, "a new folder is not started");
  await want(h.dir, "edge-dns", "wanted: active\n");
  await h.rescan();
  await waitFor(
    () => h.observed("edge-dns") === "ready",
    "a new workspace starts once it is wanted active",
  );
});

Deno.test({
  name:
    "createWorkspaceReconciler: a removal that fails after the rename keeps the wanted and status files until the data is gone",
  // root ignores folder permissions, so the removal would not fail
  ignore: Deno.build.os === "windows" || Deno.uid() === 0,
  fn: async () => {
    await using h = await harness();
    await makeRepo(h.dir, "delta");
    await Deno.mkdir(join(h.dir, "delta", "locked"));
    await Deno.writeTextFile(join(h.dir, "delta", "locked", "data"), "x");
    await want(h.dir, "delta", "wanted: active\n");
    await h.begin();
    await waitFor(() => h.observed("delta") === "ready", "ready");
    await Deno.chmod(join(h.dir, "delta", "locked"), 0o000);
    const hidden = async () =>
      (await entries(h.dir)).filter((e) => e.startsWith(".delta.deleting-"));
    try {
      await want(h.dir, "delta", "wanted: deleted\n");
      const statuses: string[] = [];
      for (let attempt = 1; attempt <= 3; attempt++) {
        await h.rescan();
        await h.reconciler.drain();
        assertEquals(
          (await entries(h.dir)).filter((e) => !e.startsWith(".")),
          ["delta.status.yaml", "delta.wanted.yaml"],
          `attempt ${attempt} keeps both files while data is left`,
        );
        assertEquals((await hidden()).length, 1);
        const status = await Deno.readTextFile(
          join(h.dir, "delta.status.yaml"),
        );
        assert(status.includes("Removing the workspace failed"), status);
        assert(status.includes("wanted: deleted"), status);
        statuses.push(status);
      }
      // a write would wake the folder watcher and retry at once, forever
      assertEquals(
        new Set(statuses).size,
        1,
        "a retry failing the same way writes nothing",
      );
    } finally {
      for (const entry of await hidden()) {
        await Deno.chmod(join(h.dir, entry, "locked"), 0o755);
      }
    }
    await h.rescan();
    await h.reconciler.drain();
    await h.statusWriter.drain();
    assertEquals(await entries(h.dir), []);
    assertEquals(h.port.of("delta").length, 1, "never started again");
  },
});

Deno.test("ReasonMemo: reports a key's reason once, again only when it changes or after a clear", () => {
  const memo = new ReasonMemo();
  assertEquals(memo.changed("a", "denied"), true);
  assertEquals(memo.changed("a", "denied"), false);
  assertEquals(memo.changed("a", "busy"), true);
  assertEquals(memo.changed("b", "busy"), true);
  memo.clear("a");
  assertEquals(memo.changed("a", "busy"), true);
  memo.retain(new Set(["a"]));
  assertEquals(memo.changed("a", "busy"), false);
  assertEquals(memo.changed("b", "busy"), true, "b was forgotten");
});

Deno.test("createWorkspaceReconciler: a wanted file listed by the scan but gone by the read leaves the workspace as it is", async () => {
  await using h = await harness();
  await makeRepo(h.dir, "parked");
  await want(h.dir, "parked", "wanted: suspended\n");
  await h.begin();
  assertEquals(h.supervisor.lookup(id("parked"))?.wanted, "suspended");

  const listed = await scanWorkspaces(h.dir);
  await Deno.remove(join(h.dir, "parked.wanted.yaml"));
  await h.reconcileScan(listed);
  assertEquals(h.port.of("parked").length, 0, "not resumed mid-save");

  await want(h.dir, "parked", "wanted: suspended\n");
  await h.rescan();
  assertEquals(h.port.of("parked").length, 0);

  await Deno.remove(join(h.dir, "parked.wanted.yaml"));
  await h.rescan();
  await h.rescan();
  assertEquals(h.port.of("parked").length, 0, "a removed file keeps suspended");
  assertEquals(h.supervisor.lookup(id("parked"))?.wanted, "suspended");
});

Deno.test("createWorkspaceReconciler: begin names only the workspaces it handed to the supervisor", async () => {
  await using h = await harness();
  await makeRepo(h.dir, "edge-dns");
  await want(h.dir, "edge-dns", "wanted: active\n");
  const listed = await scanWorkspaces(h.dir);
  const reads = await readWantedFiles(h.repository, listed);
  await Deno.remove(join(h.dir, "edge-dns.wanted.yaml"));
  const vanished = await readWantedFiles(h.repository, listed);
  assertEquals(reads.get("edge-dns")?.kind, "found");
  assertEquals(vanished.get("edge-dns")?.kind, "vanished");
  assertEquals(
    h.reconciler.begin(listed, vanished, h.foldersOf(listed, vanished)),
    [],
  );
  await want(h.dir, "edge-dns", "wanted: active\n");
  await h.rescan();
  await waitFor(
    () => h.observed("edge-dns") === "ready",
    "started next rescan",
  );
});

Deno.test("createWorkspaceReconciler: a rename that keeps failing reuses one hidden name and writes its status once", async () => {
  const targets: string[] = [];
  let busy = true;
  await using h = await harness(async (from, to) => {
    targets.push(to);
    // Deno names both paths in a rename error, as a busy mount point does
    if (busy) throw new Deno.errors.Busy(`rename '${from}' -> '${to}'`);
    await Deno.rename(from, to);
  });
  await makeRepo(h.dir, "edge-dns");
  await want(h.dir, "edge-dns", "wanted: active\n");
  await h.begin();
  await waitFor(() => h.observed("edge-dns") === "ready", "ready");
  await want(h.dir, "edge-dns", "wanted: deleted\n");

  const statuses: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    await h.rescan();
    await h.reconciler.drain();
    statuses.push(
      await Deno.readTextFile(join(h.dir, "edge-dns.status.yaml")),
    );
  }
  assertEquals(new Set(targets).size, 1, "one hidden name for every try");
  assertEquals(new Set(statuses).size, 1, "the status is written once");
  assert(statuses[0].includes("Removing the workspace failed"), statuses[0]);
  assert(await exists(join(h.dir, "edge-dns", REPO_MARKER_FILE)));

  busy = false;
  await h.rescan();
  await h.reconciler.drain();
  await h.statusWriter.drain();
  assertEquals(await entries(h.dir), []);
});

Deno.test({
  name:
    "createWorkspaceReconciler: a folder that reappears during a stuck removal is renamed apart and everything goes once it can",
  // root ignores folder permissions, so the removal would not fail
  ignore: Deno.build.os === "windows" || Deno.uid() === 0,
  fn: async () => {
    await using h = await harness();
    await makeRepo(h.dir, "delta");
    await Deno.mkdir(join(h.dir, "delta", "locked"));
    await Deno.writeTextFile(join(h.dir, "delta", "locked", "data"), "x");
    await want(h.dir, "delta", "wanted: active\n");
    await h.begin();
    await waitFor(() => h.observed("delta") === "ready", "ready");
    await Deno.chmod(join(h.dir, "delta", "locked"), 0o000);
    const hidden = async () =>
      (await entries(h.dir)).filter((e) => e.startsWith(".delta.deleting-"));
    try {
      await want(h.dir, "delta", "wanted: deleted\n");
      await h.rescan();
      await h.reconciler.drain();
      assertEquals((await hidden()).length, 1);

      await makeRepo(h.dir, "delta");
      await h.rescan();
      await h.reconciler.drain();
      assertEquals((await hidden()).length, 1, "the new folder was removed");
      assert(!(await exists(join(h.dir, "delta"))));
    } finally {
      for (const entry of await hidden()) {
        await Deno.chmod(join(h.dir, entry, "locked"), 0o755).catch(() => {});
      }
    }
    await h.rescan();
    await h.reconciler.drain();
    await h.statusWriter.drain();
    assertEquals(await entries(h.dir), []);
  },
});

Deno.test("createWorkspaceReconciler: a folder made by hand is listed and stopped until its wanted file says active, and says how to start it once", async () => {
  await using h = await harness();
  await makeRepo(h.dir, "edge-dns");
  let listed: readonly string[] = [];
  const lines = await notStartedLines(async () => {
    listed = await h.begin();
    await h.rescan();
    await h.rescan();
  });
  assertEquals(listed, ["edge-dns"]);
  assertEquals(h.port.of("edge-dns").length, 0);
  assertEquals(h.supervisor.lookup(id("edge-dns"))?.wanted, "suspended");
  assertEquals(lines.length, 1, lines.join("\n"));
  assert(lines[0].includes("edge-dns.wanted.yaml"), lines[0]);
  await h.statusWriter.drain();
  const status = await Deno.readTextFile(join(h.dir, "edge-dns.status.yaml"));
  assert(status.includes("state: stopped"), status);
  assert(status.includes("wanted: suspended"), status);

  await want(h.dir, "edge-dns", "wanted: active\n");
  await h.rescan();
  await waitFor(() => h.observed("edge-dns") === "ready", "started");
});

Deno.test("createWorkspaceReconciler: at startup only a workspace whose wanted file says active is started", async () => {
  await using h = await harness();
  await makeRepo(h.dir, "resumed");
  await makeRepo(h.dir, "never");
  await want(h.dir, "resumed", "wanted: active\n");
  assertEquals(await h.begin(), ["never", "resumed"]);
  await waitFor(() => h.observed("resumed") === "ready", "resumed started");
  assertEquals(h.port.of("never").length, 0);
});

Deno.test("createWorkspaceReconciler: a running workspace whose wanted file is replaced, or stays absent, keeps running", async () => {
  await using h = await harness();
  await makeRepo(h.dir, "edge-dns");
  await want(h.dir, "edge-dns", "wanted: active\n");
  await h.begin();
  await waitFor(() => h.observed("edge-dns") === "ready", "ready");

  // removed after the listing, then listed while gone, then back
  const listed = await scanWorkspaces(h.dir);
  await Deno.remove(join(h.dir, "edge-dns.wanted.yaml"));
  await h.reconcileScan(listed);
  await h.rescan();
  await h.rescan();
  assertEquals(h.supervisor.lookup(id("edge-dns"))?.wanted, "running");
  await want(h.dir, "edge-dns", "wanted: active\n");
  await h.rescan();
  assertEquals(h.observed("edge-dns"), "ready");
  assertEquals(h.port.of("edge-dns").length, 1, "never stopped");
});

Deno.test("createWorkspaceReconciler: begin and each rescan ask the registrar to register the served workspaces of the latest scan", async () => {
  await using h = await harness();
  await makeRepo(h.dir, "alpha");
  await makeRepo(h.dir, "doomed");
  await want(h.dir, "doomed", "wanted: deleted\n");
  await h.begin();
  assertEquals(h.registrar.served(), ["alpha"]);
  await makeRepo(h.dir, "beta");
  await h.rescan();
  assertEquals(h.registrar.served(), ["alpha", "beta"]);
});

Deno.test("createWorkspaceReconciler: a delete unregisters after the folder is gone and before the status and wanted files", async () => {
  await using h = await harness();
  await makeRepo(h.dir, "alpha");
  await want(h.dir, "alpha", "wanted: deleted\n");
  await Deno.writeTextFile(join(h.dir, "alpha.status.yaml"), "state: ready\n");
  const seen: string[][] = [];
  h.registrar.onUnregister = async () => {
    seen.push(await entries(h.dir));
  };
  await h.begin();
  await h.reconciler.drain();
  assertEquals(h.registrar.calls, ["unregister:alpha"]);
  assertEquals(seen, [["alpha.status.yaml", "alpha.wanted.yaml"]]);
  assertEquals(await entries(h.dir), []);
});

Deno.test("createWorkspaceReconciler: a failed unregister keeps the wanted file and is tried again at the next rescan", async () => {
  await using h = await harness();
  await makeRepo(h.dir, "alpha");
  await want(h.dir, "alpha", "wanted: deleted\n");
  let fail = true;
  h.registrar.onUnregister = () =>
    fail ? Promise.reject(new Error("lock timed out")) : Promise.resolve();
  await h.begin();
  await h.reconciler.drain();
  assert(await exists(join(h.dir, "alpha.wanted.yaml")));
  assert(!(await exists(join(h.dir, "alpha"))));

  fail = false;
  await h.rescan();
  await h.reconciler.drain();
  assertEquals(h.registrar.calls, ["unregister:alpha", "unregister:alpha"]);
  assertEquals(await entries(h.dir), []);
});

Deno.test("createWorkspaceReconciler: a folder removed by hand loses its entry once its serve has stopped and its status file is gone", async () => {
  await using h = await harness();
  await makeRepo(h.dir, "alpha");
  await want(h.dir, "alpha", "wanted: active\n");
  await h.begin();
  await waitFor(() => h.observed("alpha") === "ready", "ready");
  await h.statusWriter.drain();

  await Deno.remove(join(h.dir, "alpha"), { recursive: true });
  await h.rescan();
  await h.reconciler.drain();
  assertEquals(h.registrar.calls, ["forget:alpha"]);
  assert(!(await exists(join(h.dir, "alpha.status.yaml"))));
  assertEquals(h.registrar.served(), []);
});

/** a registered repo outside the workspaces folder; hidden, so the scan passes it over */
async function operatorRepo(h: Harness, name: string): Promise<string> {
  const folder = join(h.dir, ".outside", name);
  await Deno.mkdir(folder, { recursive: true });
  await Deno.writeTextFile(join(folder, REPO_MARKER_FILE), "");
  h.registered.set(name, { folder });
  return folder;
}

async function statusOf(h: Harness, name: string): Promise<string> {
  await h.statusWriter.drain();
  return await Deno.readTextFile(join(h.dir, `${name}.status.yaml`));
}

Deno.test("createWorkspaceReconciler: a registered repo is listed and not started, and says to name its folder", async () => {
  await using h = await harness();
  const folder = await operatorRepo(h, "mine");
  let listed: readonly string[] = [];
  const lines = await notStartedLines(async () => {
    listed = await h.begin();
  });
  assertEquals(listed, ["mine"]);
  assertEquals(h.port.of("mine").length, 0);
  assertEquals(h.supervisor.lookup(id("mine"))?.wanted, "suspended");
  assertEquals(lines.length, 1, lines.join("\n"));
  assert(lines[0].includes(folder), lines[0]);
  assert((await statusOf(h, "mine")).includes("state: stopped"));
});

Deno.test("createWorkspaceReconciler: a registered repo resumed with its folder is served there, and suspended is stopped", async () => {
  await using h = await harness();
  const folder = await operatorRepo(h, "mine");
  await h.begin();
  await want(h.dir, "mine", `wanted: active\nfolder: ${folder}\n`);
  await h.rescan();
  await waitFor(() => h.observed("mine") === "ready", "started");
  assertEquals(h.port.of("mine").map((c) => c.spec.repoDir), [folder]);

  await want(h.dir, "mine", `wanted: suspended\nfolder: ${folder}\n`);
  await h.rescan();
  await waitFor(() => h.observed("mine") === "stopped", "stopped");
});

Deno.test("createWorkspaceReconciler: a wanted file written for another folder starts nothing and says why", async () => {
  await using h = await harness();
  const folder = await operatorRepo(h, "mine");
  await want(h.dir, "mine", "wanted: active\n");
  await h.begin();
  await h.rescan();
  assertEquals(h.port.of("mine").length, 0);
  const { reason } = parseYaml(await statusOf(h, "mine")) as {
    reason: string;
  };
  assert(reason.includes("written for"), reason);
  assert(reason.includes(`folder: ${folder}`), reason);

  await want(h.dir, "mine", `wanted: active\nfolder: ${folder}\n`);
  await h.rescan();
  await waitFor(() => h.observed("mine") === "ready", "started once named");
  assert(!(await statusOf(h, "mine")).includes("written for"));
});

Deno.test("createWorkspaceReconciler: a registered repo whose folder moves is stopped until its wanted file names the new one", async () => {
  await using h = await harness();
  const first = await operatorRepo(h, "mine");
  await want(h.dir, "mine", `wanted: active\nfolder: ${first}\n`);
  await h.begin();
  await waitFor(() => h.observed("mine") === "ready", "started");

  const second = join(h.dir, ".outside", "moved");
  await Deno.mkdir(second);
  h.registered.set("mine", { folder: second });
  await h.rescan();
  await waitFor(() => h.observed("mine") === "stopped", "stopped");

  await want(h.dir, "mine", `wanted: active\nfolder: ${second}\n`);
  await h.rescan();
  await waitFor(() => h.observed("mine") === "ready", "started again");
  assertEquals(h.port.of("mine").at(-1)?.spec.repoDir, second);
});

Deno.test("createWorkspaceReconciler: a registered folder that is no repo is held stopped until it is one again", async () => {
  await using h = await harness();
  const folder = await operatorRepo(h, "mine");
  h.registered.set("mine", { folder, isRepo: false });
  await want(h.dir, "mine", `wanted: active\nfolder: ${folder}\n`);
  await h.begin();
  assertEquals(h.port.of("mine").length, 0);
  assert((await statusOf(h, "mine")).includes("is not a swamp repo"));

  h.registered.set("mine", { folder });
  await h.rescan();
  await waitFor(() => h.observed("mine") === "ready", "started");
});

Deno.test("createWorkspaceReconciler: deleted for a registered repo stops it, removes nothing and says why", async () => {
  await using h = await harness();
  const folder = await operatorRepo(h, "mine");
  await want(h.dir, "mine", `wanted: active\nfolder: ${folder}\n`);
  await h.begin();
  await waitFor(() => h.observed("mine") === "ready", "started");

  await want(h.dir, "mine", `wanted: deleted\nfolder: ${folder}\n`);
  await h.rescan();
  await waitFor(() => h.observed("mine") === "stopped", "stopped");
  await h.reconciler.drain();
  assert(await exists(join(folder, REPO_MARKER_FILE)), "folder untouched");
  assert(await exists(join(h.dir, "mine.wanted.yaml")), "wanted file kept");
  assertEquals(h.registrar.calls, []);
  assert((await statusOf(h, "mine")).includes("nothing was removed"));

  await want(h.dir, "mine", `wanted: active\nfolder: ${folder}\n`);
  await h.rescan();
  await waitFor(() => h.observed("mine") === "ready", "resumed");
});

Deno.test("createWorkspaceReconciler: a folder in workspaces/ whose name is registered elsewhere is never removed by a deleted wanted file", async () => {
  await using h = await harness();
  await makeRepo(h.dir, "mine");
  await operatorRepo(h, "mine");
  await want(h.dir, "mine", "wanted: deleted\n");
  await h.begin();
  await h.rescan();
  await h.reconciler.drain();
  assert(await exists(join(h.dir, "mine", REPO_MARKER_FILE)));
  assertEquals(h.port.of("mine").length, 0);
  assertEquals(h.registrar.calls, []);
});

Deno.test("createWorkspaceReconciler: a registered repo leaving the registry is stopped and loses its files, never its folder, and a later import starts nothing", async () => {
  await using h = await harness();
  const folder = await operatorRepo(h, "mine");
  await want(h.dir, "mine", `wanted: active\nfolder: ${folder}\n`);
  await h.begin();
  await waitFor(() => h.observed("mine") === "ready", "started");

  h.registered.delete("mine");
  await h.rescan();
  await h.reconciler.drain();
  await h.statusWriter.drain();
  assertEquals(h.supervisor.lookup(id("mine"))?.wanted, "deleted");
  assertEquals(
    (await entries(h.dir)).filter((e) => e.startsWith("mine.")),
    [],
  );
  assert(await exists(join(folder, REPO_MARKER_FILE)), "folder untouched");
  assertEquals(h.registrar.calls, [], "nothing to unregister");

  h.registered.set("mine", { folder });
  await h.rescan();
  await h.rescan();
  assertEquals(h.port.of("mine").length, 1, "not started again");
  assertEquals(h.supervisor.lookup(id("mine"))?.wanted, "suspended");
});

Deno.test("createWorkspaceReconciler: a registered repo re-imported before its files are removed keeps a wanted file written meanwhile", async () => {
  await using h = await harness();
  const folder = await operatorRepo(h, "mine");
  await want(h.dir, "mine", `wanted: active\nfolder: ${folder}\n`);
  await h.begin();
  await waitFor(() => h.observed("mine") === "ready", "started");
  const child = h.port.of("mine")[0];
  child.ignoresTerminate = true;

  h.registered.delete("mine");
  await h.rescan();
  h.registered.set("mine", { folder });
  await want(
    h.dir,
    "mine",
    `wanted: active\nfolder: ${folder}\nchangedAt: 2026-11-20T00:00:00.000Z\n`,
  );
  await h.rescan();
  child.ignoresTerminate = false;
  child.exit(0);
  await h.reconciler.drain();
  assert(await exists(join(h.dir, "mine.wanted.yaml")), "kept");
  await waitFor(() => h.observed("mine") === "ready", "served again");
});

Deno.test("createWorkspaceReconciler: a workspace listed only from its wanted file keeps its files when the registry lacks it", async () => {
  await using h = await harness();
  const folder = await operatorRepo(h, "mine");
  h.registered.set("mine", { folder, fromWantedFile: true });
  await want(h.dir, "mine", `wanted: active\nfolder: ${folder}\n`);
  await h.begin();
  await waitFor(() => h.observed("mine") === "ready", "started");

  h.registered.delete("mine");
  await h.rescan();
  await h.reconciler.drain();
  assertEquals(h.supervisor.lookup(id("mine"))?.wanted, "deleted");
  assert(await exists(join(h.dir, "mine.wanted.yaml")), "wanted file kept");
});

Deno.test("createWorkspaceReconciler: the registrar is asked to register the host's own and the folders an entry passed over, and to forget entries reported gone", async () => {
  await using h = await harness();
  await makeRepo(h.dir, "alpha");
  await makeRepo(h.dir, "clashing");
  await operatorRepo(h, "mine");
  await operatorRepo(h, "clashing");
  h.gone = ["vanished"];
  await h.begin();
  assertEquals(h.reconciler.served().slice().sort(), [
    "alpha",
    "clashing",
    "mine",
  ]);
  assertEquals(h.registrar.served(), ["alpha", "clashing"]);
  assertEquals(h.registrar.calls, ["forget:vanished"]);
});

Deno.test("createWorkspaceReconciler: a removal that finds its folder is another workspace's is dropped, never retried", async () => {
  await using h = await harness();
  await makeRepo(h.dir, "gamma");
  await Deno.writeTextFile(join(h.dir, "gamma", "TEAM_DATA.txt"), "keep me");
  h.registered.set("beta", { folder: join(h.dir, "gamma") });
  await want(h.dir, "gamma", "wanted: deleted\n");
  await h.begin();
  await h.reconciler.drain();
  await h.rescan();
  await h.reconciler.drain();
  assertEquals(
    await Deno.readTextFile(join(h.dir, "gamma", "TEAM_DATA.txt")),
    "keep me",
  );
  assertEquals(h.registrar.calls, []);
  assertEquals(await exists(join(h.dir, "gamma.wanted.yaml")), false);
});

Deno.test("createWorkspaceReconciler: an entry shadowing a folder of its name is never started, and says to free the name, not to name its folder", async () => {
  await using h = await harness();
  await makeRepo(h.dir, "alpha");
  const folder = await operatorRepo(h, "alpha");
  h.registered.set("alpha", { folder, shadows: true });
  await want(h.dir, "alpha", `wanted: active\nfolder: ${folder}\n`);
  await h.begin();
  await h.rescan();
  assertEquals(h.port.of("alpha").length, 0);
  const { reason } = parseYaml(await statusOf(h, "alpha")) as {
    reason: string;
  };
  assert(reason.includes("swamp workspace remove alpha"), reason);
  assert(!reason.includes("Write folder"), reason);

  h.registered.delete("alpha");
  await want(h.dir, "alpha", "wanted: active\n");
  await h.rescan();
  await waitFor(() => h.observed("alpha") === "ready", "served again");
  assertEquals(h.port.of("alpha")[0].spec.repoDir, join(h.dir, "alpha"));
});

Deno.test("createWorkspaceReconciler: a deleted for a folder another workspace has is dropped, so freeing the name later deletes nothing", async () => {
  await using h = await harness();
  await makeRepo(h.dir, "gamma");
  await Deno.writeTextFile(join(h.dir, "gamma", "TEAM_DATA.txt"), "keep me");
  h.registered.set("beta", { folder: join(h.dir, "gamma") });
  h.wantedMatch.set("gamma", false);
  await want(h.dir, "gamma", "wanted: deleted\n");
  await h.begin();
  await h.reconciler.drain();
  assertEquals(await exists(join(h.dir, "gamma.wanted.yaml")), false);

  h.registered.delete("beta");
  h.wantedMatch.delete("gamma");
  await h.rescan();
  await h.rescan();
  await h.reconciler.drain();
  assertEquals(
    await Deno.readTextFile(join(h.dir, "gamma", "TEAM_DATA.txt")),
    "keep me",
  );
  assertEquals(h.supervisor.lookup(id("gamma"))?.wanted, "suspended");
});

Deno.test("createWorkspaceReconciler: a deleted for a name in a clash is dropped, so freeing the name later deletes nothing", async () => {
  await using h = await harness();
  await makeRepo(h.dir, "delta");
  await Deno.writeTextFile(join(h.dir, "delta", "TEAM_DATA.txt"), "keep me");
  const folder = await operatorRepo(h, "delta");
  h.registered.set("delta", { folder, shadows: true });
  await want(h.dir, "delta", "wanted: deleted\n");
  await h.begin();
  await h.reconciler.drain();
  assertEquals(await exists(join(h.dir, "delta.wanted.yaml")), false);

  h.registered.delete("delta");
  await h.rescan();
  await h.rescan();
  await h.reconciler.drain();
  assertEquals(
    await Deno.readTextFile(join(h.dir, "delta", "TEAM_DATA.txt")),
    "keep me",
  );
  assert(await exists(join(folder, REPO_MARKER_FILE)));
  assertEquals(h.supervisor.lookup(id("delta"))?.wanted, "suspended");
});

Deno.test("createWorkspaceReconciler: a registered repo no longer listed but still registered is stopped and keeps its files", async () => {
  await using h = await harness();
  const folder = await operatorRepo(h, "mine");
  await want(h.dir, "mine", `wanted: active\nfolder: ${folder}\n`);
  await h.begin();
  await waitFor(() => h.observed("mine") === "ready", "started");

  h.registered.delete("mine");
  h.stillRegistered.add("mine");
  await h.rescan();
  await h.reconciler.drain();
  assertEquals(h.supervisor.lookup(id("mine"))?.wanted, "deleted");
  assert(await exists(join(h.dir, "mine.wanted.yaml")), "wanted file kept");
});

Deno.test("createWorkspaceReconciler: a removal stops when the registry, read afresh, gives the folder to another name", async () => {
  const asked: string[] = [];
  await using h = await harness(undefined, (name) => {
    asked.push(name);
    return Promise.resolve("it is registered as beta");
  });
  await makeRepo(h.dir, "gamma");
  await want(h.dir, "gamma", "wanted: deleted\n");
  await h.begin();
  await h.reconciler.drain();
  assertEquals(asked, ["gamma"]);
  assert(await exists(join(h.dir, "gamma", REPO_MARKER_FILE)));
  assertEquals(await exists(join(h.dir, "gamma.wanted.yaml")), false);
});

Deno.test("createWorkspaceReconciler: a removal under way when its folder is registered under another name is dropped, so freeing that name deletes nothing", async () => {
  await using h = await harness();
  await makeRepo(h.dir, "gamma");
  await Deno.writeTextFile(join(h.dir, "gamma", "TEAM_DATA.txt"), "keep me");
  await want(h.dir, "gamma", "wanted: active\n");
  await h.begin();
  await waitFor(() => h.observed("gamma") === "ready", "started");
  const child = h.port.of("gamma")[0];
  child.ignoresTerminate = true;

  await want(
    h.dir,
    "gamma",
    "wanted: deleted\nchangedAt: 2026-11-20T00:00:00.000Z\n",
  );
  await h.rescan();
  h.registered.set("beta", { folder: join(h.dir, "gamma") });
  await h.rescan();
  child.ignoresTerminate = false;
  child.exit(0);
  await h.reconciler.drain();
  assertEquals(await exists(join(h.dir, "gamma.wanted.yaml")), false);

  h.registered.delete("beta");
  await h.rescan();
  await h.rescan();
  await h.reconciler.drain();
  assertEquals(
    await Deno.readTextFile(join(h.dir, "gamma", "TEAM_DATA.txt")),
    "keep me",
  );
  assertEquals(h.supervisor.lookup(id("gamma"))?.wanted, "suspended");
});
