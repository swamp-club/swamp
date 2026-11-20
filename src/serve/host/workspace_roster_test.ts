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
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { HostedWorkspace } from "../../domain/serve/hosted_workspace.ts";
import { scanWorkspaces } from "../../infrastructure/persistence/hosted_workspace_folder_scan.ts";
import { WorkspaceRegistryFileRepository } from "../../infrastructure/persistence/workspace_registry_file_repository.ts";
import type { HostedRegistryDeps } from "../../libswamp/workspace/hosted_registration.ts";
import {
  createWorkspaceRegistrar,
  RegistryProblemLog,
} from "./workspace_registration.ts";
import type { WantedRead } from "./workspace_reconciler.ts";
import {
  createWorkspaceRoster,
  type WorkspaceFolders,
} from "./workspace_roster.ts";

const REAL = join(Deno.cwd(), "real-folders");

interface Fixture {
  readonly workspacesDir: string;
  readonly configDir: string;
  readonly registry: WorkspaceRegistryFileRepository;
  readonly store: HostedRegistryDeps;
  makeRepo(name: string): Promise<void>;
  register(name: string, path: string): Promise<void>;
  corrupt(): Promise<void>;
  /** every scanned folder resolves under REAL, so an entry's folder differs from the scanned spelling */
  realPath(path: string): Promise<string>;
}

async function withFixture(fn: (f: Fixture) => Promise<void>): Promise<void> {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  const workspacesDir = join(dir, "workspaces");
  const configDir = join(dir, "config");
  await Deno.mkdir(workspacesDir);
  const registry = new WorkspaceRegistryFileRepository(configDir);
  const store: HostedRegistryDeps = {
    dataDir: join(dir, "data"),
    now: () => new Date("2026-11-19T00:00:00.000Z"),
    repo: { isRepo: () => Promise.resolve(true) },
    registry,
  };
  try {
    await fn({
      workspacesDir,
      configDir,
      registry,
      store,
      makeRepo: async (name) => {
        await Deno.mkdir(join(workspacesDir, name));
        await Deno.writeTextFile(join(workspacesDir, name, ".swamp.yaml"), "");
      },
      register: async (name, path) => {
        await registry.update((r) => {
          r.register({ name, path, createdAt: "2026-11-19T00:00:00.000Z" });
        });
      },
      corrupt: () =>
        Deno.writeTextFile(join(configDir, "workspaces.json"), "{not json"),
      realPath: (path) =>
        Promise.resolve(
          path.startsWith(workspacesDir)
            ? join(REAL, path.slice(workspacesDir.length))
            : path,
        ),
    });
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function captured(fn: () => Promise<void>): Promise<LogRecord[]> {
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
  return records;
}

function rows(folders: WorkspaceFolders): [string, string][] {
  return [...folders.workspaces].map(([name, w]) => [name, w.folder]);
}

function unreadableLines(records: readonly LogRecord[]): number {
  return records.filter((r) => String(r.rawMessage).includes("cannot be read"))
    .length;
}

Deno.test("createWorkspaceRoster: a registered folder is served from its entry's folder, and an entry outside workspaces/ is listed at its own", async () => {
  await withFixture(async (f) => {
    await f.makeRepo("alpha");
    await f.makeRepo("beta");
    await f.register("alpha", join(REAL, "alpha"));
    await f.register("outside", join(REAL, "..", "projects", "outside"));
    const roster = createWorkspaceRoster({
      workspacesDir: f.workspacesDir,
      rootRepo: null,
      store: f.store,
      problems: new RegistryProblemLog(),
      realPath: f.realPath,
    });
    const folders = await roster.read(
      await scanWorkspaces(f.workspacesDir),
      new Map(),
    );
    assertEquals(rows(folders), [
      ["alpha", join(REAL, "alpha")],
      ["beta", join(f.workspacesDir, "beta")],
      ["outside", join(REAL, "..", "projects", "outside")],
    ]);
    assertEquals(folders.workspaces.get("outside")?.owner, "operator");
  });
});

Deno.test("createWorkspaceRoster: a missing registry file is an empty registry, so no wanted file starts a folder outside workspaces/", async () => {
  await withFixture(async (f) => {
    const elsewhere = join(f.workspacesDir, "..", "elsewhere");
    await Deno.mkdir(elsewhere);
    await Deno.writeTextFile(join(elsewhere, ".swamp.yaml"), "");
    const roster = createWorkspaceRoster({
      workspacesDir: f.workspacesDir,
      rootRepo: null,
      store: f.store,
      problems: new RegistryProblemLog(),
    });
    const reads = new Map([[
      "elsewhere",
      {
        kind: "found" as const,
        workspace: HostedWorkspace.active("elsewhere").withFolder(elsewhere),
      },
    ]]);
    const folders = await roster.read(
      await scanWorkspaces(f.workspacesDir),
      reads,
    );
    assertEquals(rows(folders), []);
    assertEquals(await exists(join(f.configDir, "workspaces.json")), false);
  });
});

Deno.test("createWorkspaceRoster: a host started on an unreadable registry serves each active wanted file in the folder it names", async () => {
  await withFixture(async (f) => {
    await f.makeRepo("alpha");
    const elsewhere = join(f.workspacesDir, "..", "elsewhere");
    await Deno.mkdir(elsewhere);
    await Deno.writeTextFile(join(elsewhere, ".swamp.yaml"), "");
    await Deno.mkdir(f.configDir);
    await f.corrupt();
    const roster = createWorkspaceRoster({
      workspacesDir: f.workspacesDir,
      rootRepo: null,
      store: f.store,
      problems: new RegistryProblemLog(),
    });
    const reads = new Map([[
      "elsewhere",
      {
        kind: "found" as const,
        workspace: HostedWorkspace.active("elsewhere").withFolder(elsewhere),
      },
    ]]);
    await captured(async () => {
      const folders = await roster.read(
        await scanWorkspaces(f.workspacesDir),
        reads,
      );
      assertEquals(rows(folders), [
        ["alpha", join(f.workspacesDir, "alpha")],
        ["elsewhere", await Deno.realPath(elsewhere)],
      ]);
      assertEquals(folders.workspaces.get("elsewhere")?.fromWantedFile, true);
    });
  });
});

Deno.test("createWorkspaceRoster: a wanted file matches only the folder it was written for", async () => {
  await withFixture(async (f) => {
    await f.makeRepo("alpha");
    const outside = join(REAL, "..", "projects", "beta");
    await f.register("beta", outside);
    const roster = createWorkspaceRoster({
      workspacesDir: f.workspacesDir,
      rootRepo: null,
      store: f.store,
      problems: new RegistryProblemLog(),
      realPath: f.realPath,
      isRepo: () => Promise.resolve(true),
    });
    const found = (workspace: HostedWorkspace) => ({
      kind: "found" as const,
      workspace,
    });
    const reads = new Map<string, WantedRead>([
      ["alpha", found(HostedWorkspace.active("alpha"))],
      ["beta", found(HostedWorkspace.active("beta").withFolder(outside))],
      ["gamma", found(HostedWorkspace.active("gamma"))],
      [
        "delta",
        found(HostedWorkspace.active("delta").withFolder(outside)),
      ],
      ["epsilon", { kind: "unreadable", reason: "bad" }],
    ]);
    const left = await roster.read(
      await scanWorkspaces(f.workspacesDir),
      reads,
    );
    assertEquals(Object.fromEntries(left.wantedMatches), {
      alpha: true,
      beta: true,
      gamma: true,
      delta: false,
    });

    const plain = new Map<string, WantedRead>([
      ["beta", found(HostedWorkspace.active("beta"))],
    ]);
    const read = await roster.read(
      await scanWorkspaces(f.workspacesDir),
      plain,
    );
    assertEquals(read.wantedMatches.get("beta"), false);
  });
});

Deno.test("createWorkspaceRoster: a wanted file under a folder's name never matches when that folder is registered under another name", async () => {
  await withFixture(async (f) => {
    await f.makeRepo("gamma");
    await f.register("beta", join(f.workspacesDir, "gamma"));
    const roster = createWorkspaceRoster({
      workspacesDir: f.workspacesDir,
      rootRepo: null,
      store: f.store,
      problems: new RegistryProblemLog(),
    });
    const reads = new Map<string, WantedRead>([[
      "gamma",
      { kind: "found", workspace: HostedWorkspace.active("gamma") },
    ]]);
    const read = await roster.read(
      await scanWorkspaces(f.workspacesDir),
      reads,
    );
    assertEquals([...read.workspaces.keys()], ["beta"]);
    assertEquals(read.wantedMatches.get("gamma"), false);
  });
});

Deno.test("createWorkspaceRoster: a registry file that disappears while the host runs keeps the entries last read, and logs it once", async () => {
  await withFixture(async (f) => {
    const outside = join(REAL, "..", "projects", "personal");
    await f.register("personal", outside);
    const roster = createWorkspaceRoster({
      workspacesDir: f.workspacesDir,
      rootRepo: null,
      store: f.store,
      problems: new RegistryProblemLog(),
      realPath: f.realPath,
      isRepo: () => Promise.resolve(true),
    });
    const scan = () => scanWorkspaces(f.workspacesDir);
    assertEquals(rows(await roster.read(await scan(), new Map())), [
      ["personal", outside],
    ]);
    await Deno.remove(join(f.configDir, "workspaces.json"));
    const records = await captured(async () => {
      for (let i = 0; i < 3; i++) {
        assertEquals(rows(await roster.read(await scan(), new Map())), [
          ["personal", outside],
        ]);
      }
    });
    assertEquals(
      records.filter((r) => String(r.properties.reason).includes("is gone"))
        .length,
      1,
    );
  });
});

Deno.test("createWorkspaceRoster: a host that starts on an unreadable registry serves its folders, and logs it once", async () => {
  await withFixture(async (f) => {
    await f.makeRepo("alpha");
    await Deno.mkdir(f.configDir);
    await f.corrupt();
    const roster = createWorkspaceRoster({
      workspacesDir: f.workspacesDir,
      rootRepo: null,
      store: f.store,
      problems: new RegistryProblemLog(),
      realPath: f.realPath,
    });
    const records = await captured(async () => {
      for (let i = 0; i < 3; i++) {
        const folders = await roster.read(
          await scanWorkspaces(f.workspacesDir),
          new Map(),
        );
        assertEquals(rows(folders), [[
          "alpha",
          join(f.workspacesDir, "alpha"),
        ]]);
      }
    });
    assertEquals(unreadableLines(records), 1);
  });
});

Deno.test("createWorkspaceRoster: a registry that turns unreadable keeps the entries last read whole", async () => {
  await withFixture(async (f) => {
    await f.makeRepo("alpha");
    await f.register("alpha", join(REAL, "alpha"));
    const roster = createWorkspaceRoster({
      workspacesDir: f.workspacesDir,
      rootRepo: null,
      store: f.store,
      problems: new RegistryProblemLog(),
      realPath: f.realPath,
    });
    await roster.read(await scanWorkspaces(f.workspacesDir), new Map());
    await f.corrupt();
    await f.makeRepo("beta");
    await captured(async () => {
      const folders = await roster.read(
        await scanWorkspaces(f.workspacesDir),
        new Map(),
      );
      assertEquals(rows(folders), [
        ["alpha", join(REAL, "alpha")],
        ["beta", join(f.workspacesDir, "beta")],
      ]);
    });
  });
});

Deno.test("createWorkspaceRoster: a folder in place of the registry file is unreadable, not a failed rescan", async () => {
  await withFixture(async (f) => {
    await f.makeRepo("alpha");
    await Deno.mkdir(join(f.configDir, "workspaces.json"), { recursive: true });
    const roster = createWorkspaceRoster({
      workspacesDir: f.workspacesDir,
      rootRepo: null,
      store: f.store,
      problems: new RegistryProblemLog(),
      realPath: f.realPath,
    });
    const records = await captured(async () => {
      const folders = await roster.read(
        await scanWorkspaces(f.workspacesDir),
        new Map(),
      );
      assertEquals([...folders.workspaces.keys()], ["alpha"]);
    });
    assertEquals(unreadableLines(records), 1);
  });
});

Deno.test("createWorkspaceRoster: the roster and the registrar meeting one unreadable registry log one line", async () => {
  await withFixture(async (f) => {
    await f.makeRepo("alpha");
    await Deno.mkdir(f.configDir);
    await f.corrupt();
    const problems = new RegistryProblemLog();
    const roster = createWorkspaceRoster({
      workspacesDir: f.workspacesDir,
      rootRepo: null,
      store: f.store,
      problems,
      realPath: f.realPath,
    });
    const registrar = createWorkspaceRegistrar({
      workspacesDir: f.workspacesDir,
      store: f.store,
      problems,
    });
    const records = await captured(async () => {
      for (let i = 0; i < 2; i++) {
        await roster.read(await scanWorkspaces(f.workspacesDir), new Map());
        registrar.sync(() => ["alpha"]);
        await registrar.drain();
      }
    });
    assertEquals(unreadableLines(records), 1);
  });
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}
