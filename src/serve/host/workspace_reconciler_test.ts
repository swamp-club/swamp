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
import type { WorkspaceFolders } from "./workspace_roster.ts";

const CREATOR = "user:sub-alice";

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
  replaced?: boolean;
}

interface Harness extends AsyncDisposable {
  /** the state folder */
  readonly dir: string;
  /** where a create puts a workspace */
  readonly location: string;
  /** where the operator's own repos live */
  readonly outside: string;
  readonly port: Port;
  readonly supervisor: ServeSupervisor;
  readonly statusWriter: StatusWriter;
  readonly reconciler: WorkspaceReconciler;
  readonly repository: HostedWorkspaceFileRepository;
  /** the registry's entries; an entry is the host's own as the roster decides it */
  readonly registered: Map<string, Registered>;
  /** a wanted file's match as the roster would give it, where the default rule does not */
  readonly wantedMatch: Map<string, boolean>;
  /** names the registry holds though they are not listed */
  readonly stillRegistered: Set<string>;
  /** names a removal unregistered, in order */
  readonly unregistered: string[];
  onUnregister: (name: string) => Promise<void>;
  foldersOf(scan: WorkspaceScan, reads: WantedReads): WorkspaceFolders;
  begin(): Promise<readonly string[]>;
  rescan(): Promise<void>;
  /** reconciles a scan taken earlier, reading its wanted files now */
  reconcileScan(scan: WorkspaceScan): Promise<void>;
  observed(name: string): string | undefined;
}

async function realOrSelf(path: string): Promise<string> {
  try {
    return await Deno.realPath(path);
  } catch {
    return path;
  }
}

async function harness(
  options: {
    rename?: (from: string, to: string) => Promise<void>;
    holdsOAuthSecret?: (folder: string) => boolean;
  } = {},
): Promise<Harness> {
  const root = await Deno.realPath(await Deno.makeTempDir());
  const dir = join(root, "state");
  const location = join(root, "workspaces");
  const outside = join(root, "outside");
  for (const folder of [dir, location, outside]) await Deno.mkdir(folder);
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
  const registered = new Map<string, Registered>();
  const wantedMatch = new Map<string, boolean>();
  const stillRegistered = new Set<string>();
  const unregistered: string[] = [];
  const hooks = {
    onUnregister: (_name: string): Promise<void> => Promise.resolve(),
  };
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
    rename: options.rename,
    holdsOAuthSecret: options.holdsOAuthSecret,
    created: {
      async registeredFolder(name) {
        const entry = registered.get(name);
        if (entry === undefined) return null;
        return { path: entry.folder, real: await realOrSelf(entry.folder) };
      },
      async unregister(name, path) {
        unregistered.push(name);
        await hooks.onUnregister(name);
        if (registered.get(name)?.folder === path) registered.delete(name);
      },
      locations: () => Promise.resolve([location]),
      whileIdle: (_name, fn) => fn(),
    },
  });
  const foldersOf = (
    _scan: WorkspaceScan,
    reads: WantedReads,
  ): WorkspaceFolders => {
    const workspaces = new Map<string, HostedWorkspaceFolder>();
    const sorted = [...registered].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    );
    for (const [name, entry] of sorted) {
      const read = reads.get(name);
      const record = read?.kind === "found" ? read.workspace : null;
      const created = !entry.replaced && record !== null &&
        record.creator !== null && record.folder === entry.folder;
      workspaces.set(name, {
        name,
        folder: entry.folder,
        owner: created ? "host" : "operator",
        isRepo: entry.isRepo ?? true,
        fromWantedFile: entry.fromWantedFile ?? false,
        ...(entry.replaced ? { replaced: true } : {}),
      });
    }
    const wantedMatches = new Map<string, boolean>();
    for (const [name, read] of reads) {
      if (read.kind !== "found") continue;
      const listed = workspaces.get(name)?.folder ?? null;
      const { creator, folder } = read.workspace;
      wantedMatches.set(
        name,
        wantedMatch.get(name) ??
          (listed === null
            ? creator !== null && folder !== null
            : folder === listed),
      );
    }
    return {
      workspaces,
      wantedMatches,
      registered: new Set([...registered.keys(), ...stillRegistered]),
    };
  };
  const reconcileScan = async (scan: WorkspaceScan) => {
    const reads = await readWantedFiles(repository, scan);
    reconciler.reconcile(scan, reads, foldersOf(scan, reads));
  };
  return {
    dir,
    location,
    outside,
    port,
    supervisor,
    statusWriter,
    reconciler,
    repository,
    registered,
    wantedMatch,
    stillRegistered,
    unregistered,
    get onUnregister() {
      return hooks.onUnregister;
    },
    set onUnregister(fn: (name: string) => Promise<void>) {
      hooks.onUnregister = fn;
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
        await Deno.remove(root, { recursive: true }).catch(() => {});
      } else {
        await Deno.remove(root, { recursive: true });
      }
    },
  };
}

async function makeRepo(dir: string, name: string): Promise<void> {
  await Deno.mkdir(join(dir, name), { recursive: true });
  await Deno.writeTextFile(join(dir, name, REPO_MARKER_FILE), "");
}

const repoIdOf = (name: string) => `${name}-repo`;

/** a workspace a create made: its repo in the location and its entry */
async function own(h: Harness, name: string): Promise<string> {
  const folder = join(h.location, name);
  await makeCreatedRepo(folder, name);
  h.registered.set(name, { folder });
  return folder;
}

/** the repo a create provisions, which records its repoId */
async function makeCreatedRepo(folder: string, name: string): Promise<void> {
  await Deno.mkdir(folder, { recursive: true });
  await Deno.writeTextFile(
    join(folder, REPO_MARKER_FILE),
    `repoId: ${repoIdOf(name)}\n`,
  );
}

/** the wanted file a create writes, then as a request changes it */
async function wantOwn(
  h: Harness,
  name: string,
  wanted: string,
  extra = "",
): Promise<void> {
  await want(
    h.dir,
    name,
    `wanted: ${wanted}\ncreator: ${CREATOR}\nfolder: ${
      join(h.location, name)
    }\nrepoId: ${repoIdOf(name)}\n${extra}`,
  );
}

/** a registered repo no request created */
async function operatorRepo(h: Harness, name: string): Promise<string> {
  const folder = join(h.outside, name);
  await Deno.mkdir(folder, { recursive: true });
  await Deno.writeTextFile(join(folder, REPO_MARKER_FILE), "");
  h.registered.set(name, { folder });
  return folder;
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

async function statusOf(h: Harness, name: string): Promise<string> {
  await h.statusWriter.drain();
  return await Deno.readTextFile(join(h.dir, `${name}.status.yaml`));
}

// the writer folds a long reason across lines, so a phrase is searched in the parsed field
async function reasonOf(h: Harness, name: string): Promise<string> {
  const { reason } = parseYaml(await statusOf(h, name)) as {
    reason: string | null;
  };
  return reason ?? "";
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
  for (const name of ["running", "parked", "doomed"]) await own(h, name);
  await wantOwn(h, "running", "active");
  await wantOwn(h, "parked", "suspended");
  await wantOwn(h, "doomed", "deleted");
  await Deno.writeTextFile(join(h.dir, "doomed.status.yaml"), "state: ready\n");

  assertEquals(await h.begin(), ["parked", "running"]);
  assertEquals(h.port.of("running").length, 1);
  assertEquals(h.port.of("parked").length, 0);
  assertEquals(h.supervisor.lookup(id("parked"))?.wanted, "suspended");
  assertEquals(h.port.of("doomed").length, 0);
  await h.reconciler.drain();
  assertEquals(h.supervisor.lookup(id("doomed")), undefined);
  assertEquals(await entries(h.location), ["parked", "running"]);
  assert(!(await exists(join(h.dir, "doomed.status.yaml"))));
  assert(!(await exists(join(h.dir, "doomed.wanted.yaml"))));
  assertEquals(h.unregistered, ["doomed"]);
});

Deno.test("createWorkspaceReconciler: served leaves out a workspace being deleted while its folder is still there, and after", async () => {
  const gate = Promise.withResolvers<void>();
  const renameStarted = Promise.withResolvers<void>();
  await using h = await harness({
    rename: async (from, to) => {
      renameStarted.resolve();
      await gate.promise;
      await Deno.rename(from, to);
    },
  });
  await own(h, "never");
  await own(h, "running");
  await wantOwn(h, "never", "deleted");
  await wantOwn(h, "running", "active");

  assertEquals(await h.begin(), ["running"]);
  assertEquals(h.reconciler.served(), ["running"]);

  await wantOwn(h, "running", "deleted");
  await h.rescan();
  await renameStarted.promise;
  assert(await exists(join(h.location, "running")));
  assertEquals(h.reconciler.served(), [], "while its folder is there");

  gate.resolve();
  await h.reconciler.drain();
  assertEquals(h.supervisor.lookup(id("running"))?.wanted, "deleted");
  assertEquals(h.reconciler.served(), [], "after the removal");
});

Deno.test("createWorkspaceReconciler: editing the wanted file suspends and resumes a running workspace", async () => {
  await using h = await harness();
  await own(h, "edge-dns");
  await wantOwn(h, "edge-dns", "active");
  await h.begin();
  await waitFor(() => h.observed("edge-dns") === "ready", "ready");
  assertEquals(
    h.port.of("edge-dns")[0].spec.repoDir,
    join(h.location, "edge-dns"),
  );

  await wantOwn(h, "edge-dns", "suspended");
  await h.rescan();
  await waitFor(() => h.observed("edge-dns") === "stopped", "stopped");
  assertEquals(h.supervisor.lookup(id("edge-dns"))?.wanted, "suspended");

  await wantOwn(h, "edge-dns", "active");
  await h.rescan();
  await waitFor(() => h.observed("edge-dns") === "ready", "ready again");
  assertEquals(h.port.of("edge-dns").length, 2);
});

Deno.test("createWorkspaceReconciler: a failed workspace resumes when its active record changes, not on a rescan of the same record", async () => {
  await using h = await harness();
  await own(h, "edge-dns");
  await wantOwn(h, "edge-dns", "active");
  h.port.crashing.add("edge-dns");
  await h.begin();
  await waitFor(() => h.observed("edge-dns") === "failed", "failed");
  const spawns = h.port.of("edge-dns").length;

  await h.rescan();
  assertEquals(h.port.of("edge-dns").length, spawns, "unchanged: no resume");

  h.port.crashing.delete("edge-dns");
  await wantOwn(
    h,
    "edge-dns",
    "active",
    "changedAt: 2026-11-17T12:00:00.000Z\n",
  );
  await h.rescan();
  await waitFor(() => h.observed("edge-dns") === "ready", "resumed");
});

Deno.test("createWorkspaceReconciler: an unreadable wanted file leaves the workspace as it is and is reported", async () => {
  await using h = await harness();
  await own(h, "edge-dns");
  await operatorRepo(h, "fresh");
  await wantOwn(h, "edge-dns", "active");
  await want(h.dir, "fresh", "wanted: [\n");
  assertEquals(await h.begin(), ["edge-dns", "fresh"]);
  await waitFor(() => h.observed("edge-dns") === "ready", "ready");
  assertEquals(
    h.port.of("fresh").length,
    0,
    "unreadable with none read starts nothing",
  );
  const fresh = parseYaml(await statusOf(h, "fresh")) as {
    reason: string;
    wanted: string;
  };
  assert(fresh.reason.includes("cannot be read"), fresh.reason);
  assertEquals(fresh.wanted, "suspended");

  await want(h.dir, "edge-dns", "wanted: suspend\n");
  await h.rescan();
  assertEquals(h.observed("edge-dns"), "ready");
  const { reason } = parseYaml(await statusOf(h, "edge-dns")) as {
    reason: string;
  };
  assert(reason.includes("cannot be read"), reason);

  await wantOwn(h, "edge-dns", "suspended");
  await h.rescan();
  await waitFor(() => h.observed("edge-dns") === "stopped", "stopped");
});

Deno.test("createWorkspaceReconciler: a wanted file a create left with no entry is settled, and a stray one with no creator is left", async () => {
  await using h = await harness();
  const hidden = `.coming.creating-${crypto.randomUUID()}`;
  await Deno.mkdir(join(h.location, hidden));
  await wantOwn(h, "coming", "suspended");
  await want(
    h.dir,
    "stray",
    `wanted: active\nfolder: ${join(h.outside, "stray")}\n`,
  );
  assertEquals(await h.begin(), []);
  await h.reconciler.drain();
  assertEquals(h.supervisor.lookup(id("coming")), undefined);
  assertEquals(h.supervisor.lookup(id("stray")), undefined);
  assertEquals(await entries(h.dir), ["stray.wanted.yaml"]);
  assertEquals(await entries(h.location), []);
  assertEquals(h.unregistered, []);
});

Deno.test("createWorkspaceReconciler: a deleted workspace is stopped before its folder goes, an edit back is ignored, and nothing is left", async () => {
  await using h = await harness();
  const folder = await own(h, "edge-dns");
  await Deno.writeTextFile(join(folder, "data.txt"), "keep?");
  await wantOwn(h, "edge-dns", "active");
  h.port.ignoreTerminate = true;
  await h.begin();
  await waitFor(() => h.observed("edge-dns") === "ready", "ready");

  await wantOwn(h, "edge-dns", "deleted");
  await h.rescan();
  assertEquals(h.supervisor.lookup(id("edge-dns"))?.wanted, "deleted");
  assert(
    await exists(join(folder, "data.txt")),
    "kept while the serve drains",
  );

  await wantOwn(h, "edge-dns", "active");
  await h.rescan();
  h.port.of("edge-dns")[0].exit(0);
  await h.reconciler.drain();
  await h.statusWriter.drain();
  assertEquals(await entries(h.dir), []);
  assertEquals(await entries(h.location), []);
  assertEquals(h.supervisor.lookup(id("edge-dns"))?.wanted, "deleted");
  assertEquals(h.port.of("edge-dns").length, 1);
});

Deno.test({
  name:
    "createWorkspaceReconciler: a workspace folder that is a link loses only its link",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await using h = await harness();
    const elsewhere = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        join(elsewhere, REPO_MARKER_FILE),
        `repoId: ${repoIdOf("linked")}\n`,
      );
      await Deno.writeTextFile(join(elsewhere, "precious.txt"), "x");
      const link = join(h.location, "linked");
      await Deno.symlink(elsewhere, link, { type: "dir" });
      h.registered.set("linked", { folder: link });
      await wantOwn(h, "linked", "deleted");
      await h.begin();
      await h.reconciler.drain();
      assertEquals(await entries(h.dir), []);
      assertEquals(await entries(h.location), []);
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
    await own(h, "edge-dns");
    await wantOwn(h, "edge-dns", "active");
    await h.begin();
    await waitFor(() => h.observed("edge-dns") === "ready", "ready");

    await wantOwn(h, "edge-dns", "deleted");
    // a location that cannot be renamed out of makes the removal fail
    await Deno.chmod(h.location, 0o555);
    try {
      await h.rescan();
      await h.reconciler.drain();
    } finally {
      await Deno.chmod(h.location, 0o755);
    }
    assert(await exists(join(h.location, "edge-dns")), "the removal failed");

    await wantOwn(h, "edge-dns", "active");
    await h.rescan();
    await h.reconciler.drain();
    await h.statusWriter.drain();
    assertEquals(await entries(h.dir), []);
    assertEquals(await entries(h.location), []);
    assertEquals(h.port.of("edge-dns").length, 1, "never started again");
  },
});

Deno.test("createWorkspaceReconciler: a scan listed before a removal finished does not start the workspace again", async () => {
  await using h = await harness();
  await own(h, "edge-dns");
  await wantOwn(h, "edge-dns", "active");
  await h.begin();
  await waitFor(() => h.observed("edge-dns") === "ready", "ready");
  await wantOwn(h, "edge-dns", "deleted");
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

  await own(h, "edge-dns");
  await h.rescan();
  await h.reconciler.drain();
  assertEquals(h.port.of("edge-dns").length, 1, "a new entry is not started");
  await wantOwn(h, "edge-dns", "active");
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
    const folder = await own(h, "delta");
    await Deno.mkdir(join(folder, "locked"));
    await Deno.writeTextFile(join(folder, "locked", "data"), "x");
    await wantOwn(h, "delta", "active");
    await h.begin();
    await waitFor(() => h.observed("delta") === "ready", "ready");
    await Deno.chmod(join(folder, "locked"), 0o000);
    const hidden = async () =>
      (await entries(h.location)).filter((e) =>
        e.startsWith(".delta.deleting-")
      );
    try {
      await wantOwn(h, "delta", "deleted");
      const statuses: string[] = [];
      for (let attempt = 1; attempt <= 3; attempt++) {
        await h.rescan();
        await h.reconciler.drain();
        assertEquals(
          await entries(h.dir),
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
      assertEquals(h.unregistered, [], "the entry stays until the data goes");
    } finally {
      for (const entry of await hidden()) {
        await Deno.chmod(join(h.location, entry, "locked"), 0o755);
      }
    }
    await h.rescan();
    await h.reconciler.drain();
    await h.statusWriter.drain();
    assertEquals(await entries(h.dir), []);
    assertEquals(await entries(h.location), []);
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
  await own(h, "parked");
  await wantOwn(h, "parked", "suspended");
  await h.begin();
  assertEquals(h.supervisor.lookup(id("parked"))?.wanted, "suspended");

  const listed = await scanWorkspaces(h.dir);
  await Deno.remove(join(h.dir, "parked.wanted.yaml"));
  await h.reconcileScan(listed);
  assertEquals(h.port.of("parked").length, 0, "not resumed mid-save");

  await wantOwn(h, "parked", "suspended");
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
  await own(h, "edge-dns");
  await wantOwn(h, "edge-dns", "active");
  const listed = await scanWorkspaces(h.dir);
  const reads = await readWantedFiles(h.repository, listed);
  await Deno.remove(join(h.dir, "edge-dns.wanted.yaml"));
  const vanished = await readWantedFiles(h.repository, listed);
  assertEquals(reads.get("edge-dns")?.kind, "found");
  assertEquals(vanished.get("edge-dns")?.kind, "vanished");
  h.registered.delete("edge-dns");
  assertEquals(
    h.reconciler.begin(listed, vanished, h.foldersOf(listed, vanished)),
    [],
  );
  await own(h, "edge-dns");
  await wantOwn(h, "edge-dns", "active");
  await h.rescan();
  await waitFor(
    () => h.observed("edge-dns") === "ready",
    "started next rescan",
  );
});

Deno.test("createWorkspaceReconciler: a rename that keeps failing reuses one hidden name and writes its status once", async () => {
  const targets: string[] = [];
  let busy = true;
  await using h = await harness({
    rename: async (from, to) => {
      targets.push(to);
      // Deno names both paths in a rename error, as a busy mount point does
      if (busy) throw new Deno.errors.Busy(`rename '${from}' -> '${to}'`);
      await Deno.rename(from, to);
    },
  });
  await own(h, "edge-dns");
  await wantOwn(h, "edge-dns", "active");
  await h.begin();
  await waitFor(() => h.observed("edge-dns") === "ready", "ready");
  await wantOwn(h, "edge-dns", "deleted");

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
  assert(await exists(join(h.location, "edge-dns", REPO_MARKER_FILE)));

  busy = false;
  await h.rescan();
  await h.reconciler.drain();
  await h.statusWriter.drain();
  assertEquals(await entries(h.dir), []);
  assertEquals(await entries(h.location), []);
});

Deno.test({
  name:
    "createWorkspaceReconciler: a folder that reappears during a stuck removal is renamed apart and everything goes once it can",
  // root ignores folder permissions, so the removal would not fail
  ignore: Deno.build.os === "windows" || Deno.uid() === 0,
  fn: async () => {
    await using h = await harness();
    const folder = await own(h, "delta");
    await Deno.mkdir(join(folder, "locked"));
    await Deno.writeTextFile(join(folder, "locked", "data"), "x");
    await wantOwn(h, "delta", "active");
    await h.begin();
    await waitFor(() => h.observed("delta") === "ready", "ready");
    await Deno.chmod(join(folder, "locked"), 0o000);
    const hidden = async () =>
      (await entries(h.location)).filter((e) =>
        e.startsWith(".delta.deleting-")
      );
    try {
      await wantOwn(h, "delta", "deleted");
      await h.rescan();
      await h.reconciler.drain();
      assertEquals((await hidden()).length, 1);

      await makeCreatedRepo(folder, "delta");
      await h.rescan();
      await h.reconciler.drain();
      assertEquals((await hidden()).length, 1, "the new folder was removed");
      assert(!(await exists(folder)));
    } finally {
      for (const entry of await hidden()) {
        await Deno.chmod(join(h.location, entry, "locked"), 0o755).catch(
          () => {},
        );
      }
    }
    await h.rescan();
    await h.reconciler.drain();
    await h.statusWriter.drain();
    assertEquals(await entries(h.dir), []);
    assertEquals(await entries(h.location), []);
  },
});

Deno.test("createWorkspaceReconciler: at startup only a workspace whose wanted file says active is started", async () => {
  await using h = await harness();
  await own(h, "resumed");
  await operatorRepo(h, "never");
  await wantOwn(h, "resumed", "active");
  assertEquals(await h.begin(), ["never", "resumed"]);
  await waitFor(() => h.observed("resumed") === "ready", "resumed started");
  assertEquals(h.port.of("never").length, 0);
});

Deno.test("createWorkspaceReconciler: a running workspace whose wanted file is replaced, or stays absent, keeps running", async () => {
  await using h = await harness();
  await own(h, "edge-dns");
  await wantOwn(h, "edge-dns", "active");
  await h.begin();
  await waitFor(() => h.observed("edge-dns") === "ready", "ready");

  // removed after the listing, then listed while gone, then back
  const listed = await scanWorkspaces(h.dir);
  await Deno.remove(join(h.dir, "edge-dns.wanted.yaml"));
  await h.reconcileScan(listed);
  await h.rescan();
  await h.rescan();
  assertEquals(h.supervisor.lookup(id("edge-dns"))?.wanted, "running");
  await wantOwn(h, "edge-dns", "active");
  await h.rescan();
  assertEquals(h.observed("edge-dns"), "ready");
  assertEquals(h.port.of("edge-dns").length, 1, "never stopped");
});

Deno.test("createWorkspaceReconciler: a delete unregisters after the folder is gone and before the status and wanted files", async () => {
  await using h = await harness();
  await own(h, "alpha");
  await wantOwn(h, "alpha", "deleted");
  await Deno.writeTextFile(join(h.dir, "alpha.status.yaml"), "state: ready\n");
  const seen: string[][] = [];
  h.onUnregister = async () => {
    seen.push([...await entries(h.dir), ...await entries(h.location)]);
  };
  await h.begin();
  await h.reconciler.drain();
  assertEquals(h.unregistered, ["alpha"]);
  assertEquals(seen, [["alpha.status.yaml", "alpha.wanted.yaml"]]);
  assertEquals(await entries(h.dir), []);
});

Deno.test("createWorkspaceReconciler: a failed unregister keeps the wanted file and is tried again at the next rescan", async () => {
  await using h = await harness();
  await own(h, "alpha");
  await wantOwn(h, "alpha", "deleted");
  let fail = true;
  h.onUnregister = () =>
    fail ? Promise.reject(new Error("lock timed out")) : Promise.resolve();
  await h.begin();
  await h.reconciler.drain();
  assert(await exists(join(h.dir, "alpha.wanted.yaml")));
  assert(!(await exists(join(h.location, "alpha"))));

  fail = false;
  await h.rescan();
  await h.reconciler.drain();
  assertEquals(h.unregistered, ["alpha", "alpha"]);
  assertEquals(await entries(h.dir), []);
});

Deno.test("createWorkspaceReconciler: a workspace a create made that leaves the registry is stopped and loses its wanted file, never its folder", async () => {
  await using h = await harness();
  const folder = await own(h, "alpha");
  await wantOwn(h, "alpha", "active");
  await h.begin();
  await waitFor(() => h.observed("alpha") === "ready", "ready");

  h.registered.delete("alpha");
  await h.rescan();
  await h.reconciler.drain();
  await h.statusWriter.drain();
  assertEquals(h.supervisor.lookup(id("alpha"))?.wanted, "deleted");
  assertEquals(await entries(h.dir), []);
  assert(await exists(join(folder, REPO_MARKER_FILE)), "folder kept");
  assertEquals(h.unregistered, []);
});

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

Deno.test("createWorkspaceReconciler: a registered repo whose folder moves is stopped until its wanted file names the new one", async () => {
  await using h = await harness();
  const first = await operatorRepo(h, "mine");
  await want(h.dir, "mine", `wanted: active\nfolder: ${first}\n`);
  await h.begin();
  await waitFor(() => h.observed("mine") === "ready", "started");

  const second = join(h.outside, "moved");
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
  assert((await reasonOf(h, "mine")).includes("is not a swamp repo"));

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
  assertEquals(h.unregistered, []);
  assert((await reasonOf(h, "mine")).includes("nothing was removed"));

  await want(h.dir, "mine", `wanted: active\nfolder: ${folder}\n`);
  await h.rescan();
  await waitFor(() => h.observed("mine") === "ready", "resumed");
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
  assertEquals(h.unregistered, [], "nothing to unregister");

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

Deno.test("createWorkspaceReconciler: a workspace whose folder holds the OAuth client's secret file is not started, and says why", async () => {
  let secretHolder = "";
  await using h = await harness({
    holdsOAuthSecret: (folder) => folder === secretHolder,
  });
  const folder = await operatorRepo(h, "mine");
  const other = await operatorRepo(h, "other");
  secretHolder = folder;
  await want(h.dir, "mine", `wanted: active\nfolder: ${folder}\n`);
  await want(h.dir, "other", `wanted: active\nfolder: ${other}\n`);
  await h.begin();
  await waitFor(() => h.observed("other") === "ready", "other started");
  assertEquals(h.port.of("mine").length, 0);
  const { reason } = parseYaml(await statusOf(h, "mine")) as {
    reason: string;
  };
  assert(reason.includes("oauth-client.secret-file"), reason);
  assert(reason.includes(folder), reason);

  secretHolder = "";
  await h.rescan();
  await waitFor(() => h.observed("mine") === "ready", "started once moved");
});

Deno.test("createWorkspaceReconciler: a wanted file written for another folder starts nothing and says why", async () => {
  await using h = await harness();
  const folder = await operatorRepo(h, "mine");
  await want(
    h.dir,
    "mine",
    `wanted: active\nfolder: ${join(h.outside, "elsewhere")}\n`,
  );
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
  assert(!(await reasonOf(h, "mine")).includes("written for"));
});

Deno.test("createWorkspaceReconciler: a wanted file that names no folder starts nothing and says to name one", async () => {
  await using h = await harness();
  const folder = await operatorRepo(h, "mine");
  await want(h.dir, "mine", "wanted: active\n");
  await h.begin();
  assertEquals(h.port.of("mine").length, 0);
  const { reason } = parseYaml(await statusOf(h, "mine")) as {
    reason: string;
  };
  assert(reason.includes("names no folder"), reason);
  assert(reason.includes(`folder: ${folder}`), reason);
});

Deno.test("createWorkspaceReconciler: a removal under way when its entry, read afresh, names another folder is dropped, so the folder is kept", async () => {
  await using h = await harness();
  const folder = await own(h, "gamma");
  await Deno.writeTextFile(join(folder, "TEAM_DATA.txt"), "keep me");
  await wantOwn(h, "gamma", "active");
  await h.begin();
  await waitFor(() => h.observed("gamma") === "ready", "started");
  const child = h.port.of("gamma")[0];
  child.ignoresTerminate = true;

  await wantOwn(h, "gamma", "deleted", "changedAt: 2026-11-20T00:00:00.000Z\n");
  await h.rescan();
  const imported = await operatorRepo(h, "gamma");
  child.ignoresTerminate = false;
  child.exit(0);
  await h.reconciler.drain();
  assertEquals(await exists(join(h.dir, "gamma.wanted.yaml")), false);
  assertEquals(
    await Deno.readTextFile(join(folder, "TEAM_DATA.txt")),
    "keep me",
  );
  assert(await exists(join(imported, REPO_MARKER_FILE)));
  assertEquals(h.unregistered, []);

  await h.rescan();
  await h.reconciler.drain();
  assertEquals(h.supervisor.lookup(id("gamma"))?.wanted, "suspended");
});

Deno.test("createWorkspaceReconciler: a deleted written for a folder the entry does not name is dropped, so the entry naming it later deletes nothing", async () => {
  await using h = await harness();
  const written = join(h.location, "gamma");
  await makeRepo(h.location, "gamma");
  await Deno.writeTextFile(join(written, "TEAM_DATA.txt"), "keep me");
  await operatorRepo(h, "gamma");
  await wantOwn(h, "gamma", "deleted");
  await h.begin();
  await h.reconciler.drain();
  assertEquals(await exists(join(h.dir, "gamma.wanted.yaml")), false);

  h.registered.set("gamma", { folder: written });
  await h.rescan();
  await h.rescan();
  await h.reconciler.drain();
  assertEquals(
    await Deno.readTextFile(join(written, "TEAM_DATA.txt")),
    "keep me",
  );
  assertEquals(h.supervisor.lookup(id("gamma"))?.wanted, "suspended");
  assertEquals(h.unregistered, []);
});

Deno.test("createWorkspaceReconciler: a deleted held for a registered repo never removes a repo registered later under its name", async () => {
  await using h = await harness();
  const folder = await operatorRepo(h, "mine");
  await want(h.dir, "mine", `wanted: deleted\nfolder: ${folder}\n`);
  await h.begin();
  await h.rescan();
  await h.reconciler.drain();
  assert(await exists(join(h.dir, "mine.wanted.yaml")), "held, not removed");

  // in one rescan the entry moves to a new repo in the workspace location
  await makeRepo(h.location, "mine");
  await Deno.writeTextFile(
    join(h.location, "mine", "TEAM_DATA.txt"),
    "keep me",
  );
  h.registered.set("mine", { folder: join(h.location, "mine") });
  await h.rescan();
  await h.rescan();
  await h.reconciler.drain();
  assertEquals(
    await Deno.readTextFile(join(h.location, "mine", "TEAM_DATA.txt")),
    "keep me",
  );
  assertEquals(h.unregistered, []);
});

Deno.test("createWorkspaceReconciler: a deleted wanted file with no entry and no creator removes only its file, never a folder or an entry", async () => {
  await using h = await harness();
  await makeRepo(h.dir, "stray");
  await want(h.dir, "stray", "wanted: deleted\n");
  await h.begin();
  await waitFor(
    async () => !(await exists(join(h.dir, "stray.wanted.yaml"))),
    "wanted file removed",
  );
  await h.reconciler.drain();
  assert(await exists(join(h.dir, "stray", REPO_MARKER_FILE)), "folder kept");
  assertEquals(h.unregistered, []);
  assertEquals(
    (await entries(h.dir)).filter((e) => e.startsWith(".stray.deleting-")),
    [],
  );
});

Deno.test("createWorkspaceReconciler: a creator's wanted file over another repo at its folder is removed, and that repo is not started from it", async () => {
  await using h = await harness();
  const folder = await operatorRepo(h, "mine");
  h.registered.set("mine", { folder, replaced: true });
  await want(
    h.dir,
    "mine",
    `wanted: active\ncreator: user:sub-alice\nfolder: ${folder}\nrepoId: repo-old\n`,
  );
  await h.begin();
  await waitFor(
    async () => !(await exists(join(h.dir, "mine.wanted.yaml"))),
    "the stale wanted file is removed",
  );
  await h.rescan();
  await h.reconciler.drain();
  assertEquals(h.port.of("mine").length, 0);
  assert(await exists(join(folder, REPO_MARKER_FILE)), "folder kept");
  assertEquals(h.unregistered, []);
});

Deno.test("createWorkspaceReconciler: a creator's wanted file the roster cannot tell is replaced is kept", async () => {
  await using h = await harness();
  const folder = await operatorRepo(h, "mine");
  await want(
    h.dir,
    "mine",
    `wanted: suspended\ncreator: user:sub-alice\nfolder: ${folder}\nrepoId: repo-old\n`,
  );
  await h.begin();
  await h.rescan();
  await h.reconciler.drain();
  assert(await exists(join(h.dir, "mine.wanted.yaml")), "kept");
});

Deno.test("createWorkspaceReconciler: a deleted wanted file a create wrote for another repo at its folder removes no folder", async () => {
  await using h = await harness();
  const folder = await operatorRepo(h, "mine");
  h.registered.set("mine", { folder, replaced: true });
  await want(
    h.dir,
    "mine",
    `wanted: deleted\ncreator: user:sub-alice\nfolder: ${folder}\nrepoId: repo-old\n`,
  );
  await h.begin();
  await waitFor(
    async () => !(await exists(join(h.dir, "mine.wanted.yaml"))),
    "the stale wanted file is removed",
  );
  await h.reconciler.drain();
  assert(await exists(join(folder, REPO_MARKER_FILE)), "folder kept");
  assertEquals(h.unregistered, []);
});
