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
import { scanWorkspaces } from "../../infrastructure/persistence/hosted_workspace_folder_scan.ts";
import { WorkspaceRegistryFileRepository } from "../../infrastructure/persistence/workspace_registry_file_repository.ts";
import type { HostedRegistryDeps } from "../../libswamp/workspace/hosted_registration.ts";
import {
  createWorkspaceRegistrar,
  RegistryProblemLog,
} from "./workspace_registration.ts";
import { createWorkspaceRoster } from "./workspace_roster.ts";

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

function unreadableLines(records: readonly LogRecord[]): number {
  return records.filter((r) => String(r.rawMessage).includes("cannot be read"))
    .length;
}

Deno.test("createWorkspaceRoster: a registered folder is served from its entry's folder, and an entry outside workspaces/ is passed over", async () => {
  await withFixture(async (f) => {
    await f.makeRepo("alpha");
    await f.makeRepo("beta");
    await f.register("alpha", join(REAL, "alpha"));
    await f.register("outside", join(REAL, "..", "projects", "outside"));
    const roster = createWorkspaceRoster({
      workspacesDir: f.workspacesDir,
      store: f.store,
      problems: new RegistryProblemLog(),
      realPath: f.realPath,
    });
    const folders = await roster.read(await scanWorkspaces(f.workspacesDir));
    assertEquals([...folders], [
      ["alpha", join(REAL, "alpha")],
      ["beta", join(f.workspacesDir, "beta")],
    ]);
  });
});

Deno.test("createWorkspaceRoster: a host that starts on an unreadable registry serves its folders, and logs it once", async () => {
  await withFixture(async (f) => {
    await f.makeRepo("alpha");
    await Deno.mkdir(f.configDir);
    await f.corrupt();
    const roster = createWorkspaceRoster({
      workspacesDir: f.workspacesDir,
      store: f.store,
      problems: new RegistryProblemLog(),
      realPath: f.realPath,
    });
    const records = await captured(async () => {
      for (let i = 0; i < 3; i++) {
        const folders = await roster.read(
          await scanWorkspaces(f.workspacesDir),
        );
        assertEquals([...folders], [["alpha", join(f.workspacesDir, "alpha")]]);
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
      store: f.store,
      problems: new RegistryProblemLog(),
      realPath: f.realPath,
    });
    await roster.read(await scanWorkspaces(f.workspacesDir));
    await f.corrupt();
    await f.makeRepo("beta");
    await captured(async () => {
      const folders = await roster.read(await scanWorkspaces(f.workspacesDir));
      assertEquals([...folders], [
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
      store: f.store,
      problems: new RegistryProblemLog(),
      realPath: f.realPath,
    });
    const records = await captured(async () => {
      const folders = await roster.read(await scanWorkspaces(f.workspacesDir));
      assertEquals([...folders.keys()], ["alpha"]);
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
        await roster.read(await scanWorkspaces(f.workspacesDir));
        registrar.sync(() => ["alpha"]);
        await registrar.drain();
      }
    });
    assertEquals(unreadableLines(records), 1);
  });
});
