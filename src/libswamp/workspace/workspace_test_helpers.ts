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

import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { WorkspaceRegistryFileRepository } from "../../infrastructure/persistence/workspace_registry_file_repository.ts";
import { createLibSwampContext } from "../context.ts";
import type { WorkspaceDeps } from "./deps.ts";

export const ctx = createLibSwampContext();

export interface WorkspaceFixture {
  readonly deps: WorkspaceDeps;
  readonly dir: string;
  readonly dataDir: string;
  readonly tools: Map<string, string[]>;
  readonly open: Set<string>;
  readonly locks: string[];
  makeRepo(path: string): Promise<void>;
  configure(dir: string | undefined): void;
}

export async function withWorkspaceFixture(
  fn: (f: WorkspaceFixture) => Promise<void>,
): Promise<void> {
  // The real path (macOS temp dirs sit behind /var -> /private/var), as
  // import registers folders by their real path.
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp-workspace-libswamp-" }),
  );
  const dataDir = join(dir, "data");
  const tools = new Map<string, string[]>();
  const open = new Set<string>();
  const locks: string[] = [];
  let configured: string | undefined;
  const configure = (folder: string | undefined) => {
    configured = folder;
  };
  const makeRepo = async (path: string) => {
    await ensureDir(path);
    await Deno.writeTextFile(join(path, ".swamp.yaml"), "repoId: test\n");
  };
  const deps: WorkspaceDeps = {
    dataDir,
    os: Deno.build.os,
    registry: new WorkspaceRegistryFileRepository(join(dir, "config")),
    repo: {
      isRepo: async (path) => {
        try {
          return (await Deno.stat(join(path, ".swamp.yaml"))).isFile;
        } catch {
          return false;
        }
      },
      init: makeRepo,
    },
    now: () => new Date("2026-10-14T10:00:00.000Z"),
    homeDir: dir,
    configuredParent: () => Promise.resolve(configured),
    enrolledTools: (path) => Promise.resolve([...(tools.get(path) ?? [])]),
    isOpenInStart: (path) => Promise.resolve(open.has(path)),
    withCreateLock: (name, run) => {
      locks.push(name);
      return run();
    },
  };
  try {
    await fn({
      deps,
      dir,
      dataDir,
      tools,
      open,
      locks,
      makeRepo,
      configure,
    });
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

export async function completed<D>(
  events: AsyncIterable<
    { kind: "completed"; data: D } | {
      kind: "error";
      error: { code: string; message: string };
    }
  >,
): Promise<D> {
  const all = [];
  for await (const event of events) all.push(event);
  const [event] = all;
  if (all.length !== 1 || event.kind !== "completed") {
    throw new Error(`expected one completed event, got ${JSON.stringify(all)}`);
  }
  return event.data;
}

export async function errorCode(
  events: AsyncIterable<
    { kind: "completed"; data: unknown } | {
      kind: "error";
      error: { code: string; message: string };
    }
  >,
): Promise<string> {
  return (await errorOf(events)).code;
}

export async function errorOf(
  events: AsyncIterable<
    { kind: "completed"; data: unknown } | {
      kind: "error";
      error: { code: string; message: string };
    }
  >,
): Promise<{ code: string; message: string }> {
  const all = [];
  for await (const event of events) all.push(event);
  const [event] = all;
  if (all.length !== 1 || event.kind !== "error") {
    throw new Error(`expected one error event, got ${JSON.stringify(all)}`);
  }
  return event.error;
}
