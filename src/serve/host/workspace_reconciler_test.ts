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
} from "../../infrastructure/persistence/hosted_workspace_folder_scan.ts";
import {
  createWorkspaceReconciler,
  readWantedFiles,
  ReasonMemo,
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

async function harness(
  rename?: (from: string, to: string) => Promise<void>,
): Promise<Harness> {
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
    specOf: (name) => ({
      id: workspaceServe(name),
      repoDir: join(dir, name),
      address: `http://127.0.0.1/w/${name}`,
      trustedHost: "127.0.0.1",
      env: {},
    }),
    repository,
    statusWriter,
    rename,
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
  // root ignores folder permissions, so the removal would not fail
  ignore: Deno.build.os === "windows" || Deno.uid() === 0,
  fn: async () => {
    await using h = await harness();
    await makeRepo(h.dir, "edge-dns");
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
  await h.begin();
  await waitFor(() => h.observed("edge-dns") === "ready", "ready");
  await want(h.dir, "edge-dns", "wanted: deleted\n");
  const stale = await scanWorkspaces(h.dir);

  await h.rescan();
  await h.reconciler.drain();
  assertEquals(await entries(h.dir), []);

  await h.reconciler.reconcile(stale);
  await h.reconciler.drain();
  await h.statusWriter.drain();
  assertEquals(h.port.of("edge-dns").length, 1, "not started again");
  assertEquals(h.supervisor.lookup(id("edge-dns"))?.wanted, "deleted");
  assertEquals(await entries(h.dir), [], "no status file comes back");

  await makeRepo(h.dir, "edge-dns");
  await h.rescan();
  await waitFor(
    () => h.observed("edge-dns") === "ready",
    "a new workspace starts",
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
  await h.reconciler.reconcile(listed);
  assertEquals(h.port.of("parked").length, 0, "not resumed mid-save");

  await want(h.dir, "parked", "wanted: suspended\n");
  await h.rescan();
  assertEquals(h.port.of("parked").length, 0);

  await Deno.remove(join(h.dir, "parked.wanted.yaml"));
  await h.rescan();
  await waitFor(
    () => h.observed("parked") === "ready",
    "a file gone from the listing too means active",
  );
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
  assertEquals(h.reconciler.begin(listed, vanished), []);
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
