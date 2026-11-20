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
import { WorkspaceRegistryFileRepository } from "../../infrastructure/persistence/workspace_registry_file_repository.ts";
import type { HostedRegistryDeps } from "../../libswamp/workspace/hosted_registration.ts";
import { RegistryProblemLog } from "./workspace_registration.ts";
import type { WantedRead } from "./workspace_reconciler.ts";
import {
  createWorkspaceRoster,
  type WorkspaceFolders,
} from "./workspace_roster.ts";

interface Fixture {
  /** where the test's repos live */
  readonly projects: string;
  readonly configDir: string;
  readonly registry: WorkspaceRegistryFileRepository;
  readonly store: HostedRegistryDeps;
  makeRepo(name: string): Promise<string>;
  register(name: string, path: string): Promise<void>;
  corrupt(): Promise<void>;
}

async function withFixture(fn: (f: Fixture) => Promise<void>): Promise<void> {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  const projects = join(dir, "projects");
  const configDir = join(dir, "config");
  await Deno.mkdir(projects);
  const registry = new WorkspaceRegistryFileRepository(configDir);
  const store: HostedRegistryDeps = {
    dataDir: join(dir, "data"),
    now: () => new Date("2026-11-19T00:00:00.000Z"),
    repo: { isRepo: () => Promise.resolve(true) },
    registry,
  };
  try {
    await fn({
      projects,
      configDir,
      registry,
      store,
      makeRepo: async (name) => {
        const folder = join(projects, name);
        await Deno.mkdir(folder);
        await Deno.writeTextFile(join(folder, ".swamp.yaml"), "");
        return folder;
      },
      register: async (name, path) => {
        await registry.update((r) => {
          r.register({ name, path, createdAt: "2026-11-19T00:00:00.000Z" });
        });
      },
      corrupt: async () => {
        await Deno.mkdir(configDir, { recursive: true });
        await Deno.writeTextFile(
          join(configDir, "workspaces.json"),
          "{not json",
        );
      },
    });
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

function rosterOf(f: Fixture, problems = new RegistryProblemLog()) {
  return createWorkspaceRoster({
    rootRepo: null,
    store: f.store,
    problems,
    isRepo: () => Promise.resolve(true),
  });
}

const found = (workspace: HostedWorkspace): WantedRead => ({
  kind: "found",
  workspace,
});

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

Deno.test("createWorkspaceRoster: each entry is listed at its own folder, the operator's own without a wanted file a create wrote", async () => {
  await withFixture(async (f) => {
    const alpha = await f.makeRepo("alpha");
    const outside = await f.makeRepo("outside");
    await f.register("alpha", alpha);
    await f.register("outside", outside);
    await Deno.writeTextFile(
      join(alpha, ".swamp.yaml"),
      "repoId: alpha-repo\n",
    );
    const at = new Date("2026-11-19T00:00:00.000Z");
    const folders = await rosterOf(f).read(
      new Map([[
        "alpha",
        found(
          HostedWorkspace.create("alpha", "user:sub-a", at).withFolder(alpha)
            .withRepoId("alpha-repo"),
        ),
      ]]),
    );
    assertEquals(rows(folders), [["alpha", alpha], ["outside", outside]]);
    assertEquals(folders.workspaces.get("alpha")?.owner, "host");
    assertEquals(folders.workspaces.get("outside")?.owner, "operator");
  });
});

Deno.test("createWorkspaceRoster: a missing registry file is an empty registry, so no wanted file starts a folder", async () => {
  await withFixture(async (f) => {
    const elsewhere = await f.makeRepo("elsewhere");
    const folders = await rosterOf(f).read(
      new Map([[
        "elsewhere",
        found(HostedWorkspace.active("elsewhere").withFolder(elsewhere)),
      ]]),
    );
    assertEquals(rows(folders), []);
    assertEquals(await exists(join(f.configDir, "workspaces.json")), false);
  });
});

Deno.test("createWorkspaceRoster: a host started on an unreadable registry serves each active wanted file in the folder it names", async () => {
  await withFixture(async (f) => {
    const elsewhere = await f.makeRepo("elsewhere");
    await f.corrupt();
    await captured(async () => {
      const folders = await rosterOf(f).read(
        new Map([[
          "elsewhere",
          found(HostedWorkspace.active("elsewhere").withFolder(elsewhere)),
        ]]),
      );
      assertEquals(rows(folders), [["elsewhere", elsewhere]]);
      assertEquals(folders.workspaces.get("elsewhere")?.fromWantedFile, true);
    });
  });
});

Deno.test("createWorkspaceRoster: a wanted file matches only the folder it was written for, or a create stopped before it registered", async () => {
  await withFixture(async (f) => {
    const outside = await f.makeRepo("beta");
    await f.register("beta", outside);
    const at = new Date("2026-11-19T00:00:00.000Z");
    const reads = new Map<string, WantedRead>([
      ["beta", found(HostedWorkspace.active("beta").withFolder(outside))],
      ["gamma", found(HostedWorkspace.active("gamma"))],
      ["delta", found(HostedWorkspace.active("delta").withFolder(outside))],
      [
        "stopped",
        found(
          HostedWorkspace.create("stopped", "user:sub-a", at).withFolder(
            join(f.projects, "stopped"),
          ),
        ),
      ],
      ["epsilon", { kind: "unreadable", reason: "bad" }],
    ]);
    const left = await rosterOf(f).read(reads);
    assertEquals(Object.fromEntries(left.wantedMatches), {
      beta: true,
      gamma: false,
      delta: false,
      stopped: true,
    });

    const plain = await rosterOf(f).read(
      new Map([["beta", found(HostedWorkspace.active("beta"))]]),
    );
    assertEquals(plain.wantedMatches.get("beta"), false);
  });
});

Deno.test("createWorkspaceRoster: a registry file that disappears while the host runs keeps the entries last read, and logs it once", async () => {
  await withFixture(async (f) => {
    const outside = await f.makeRepo("personal");
    await f.register("personal", outside);
    const roster = rosterOf(f);
    assertEquals(rows(await roster.read(new Map())), [["personal", outside]]);
    await Deno.remove(join(f.configDir, "workspaces.json"));
    const records = await captured(async () => {
      for (let i = 0; i < 3; i++) {
        assertEquals(rows(await roster.read(new Map())), [
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

Deno.test("createWorkspaceRoster: a host that starts on an unreadable registry logs it once", async () => {
  await withFixture(async (f) => {
    await f.corrupt();
    const roster = rosterOf(f);
    const records = await captured(async () => {
      for (let i = 0; i < 3; i++) {
        assertEquals(rows(await roster.read(new Map())), []);
      }
    });
    assertEquals(unreadableLines(records), 1);
  });
});

Deno.test("createWorkspaceRoster: a registry that turns unreadable keeps the entries last read whole", async () => {
  await withFixture(async (f) => {
    const alpha = await f.makeRepo("alpha");
    await f.register("alpha", alpha);
    const roster = rosterOf(f);
    await roster.read(new Map());
    await f.corrupt();
    await captured(async () => {
      assertEquals(rows(await roster.read(new Map())), [["alpha", alpha]]);
    });
  });
});

Deno.test("createWorkspaceRoster: a folder in place of the registry file is unreadable, not a failed rescan", async () => {
  await withFixture(async (f) => {
    await Deno.mkdir(join(f.configDir, "workspaces.json"), { recursive: true });
    const records = await captured(async () => {
      assertEquals(rows(await rosterOf(f).read(new Map())), []);
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
