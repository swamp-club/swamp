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

// Relative .swamp-sources.yaml paths in a swamp repo nested below the git
// root (swamp-club#4027, swamp-club#4026). The reporter's layout: the git
// root is an extension checkout `ext/` with `extensions/models/`, and the
// swamp repo is `ext/example`. Relative sources must resolve from the swamp
// repo, in the main checkout and in a linked worktree, while sources that
// earlier releases recorded relative to the git root keep loading. These
// tests wire the real git probe, source add, source list and mounted-source
// resolution together on a temp filesystem.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  readSwampSources,
  resolveMountedSourceDirs,
} from "../src/infrastructure/persistence/swamp_sources_repository.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { createSourceAddDeps, sourceAdd } from "../src/libswamp/sources/add.ts";
import {
  createSourceListDeps,
  sourceList,
} from "../src/libswamp/sources/list.ts";
import type {
  SourceListEvent,
  SourceModifyEvent,
} from "../src/libswamp/sources/source_events.ts";

await initializeLogging({});

const ctx = createLibSwampContext({});

async function git(cwd: string, ...args: string[]): Promise<void> {
  const { code } = await new Deno.Command("git", {
    args: [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@test.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    cwd,
    stdout: "null",
    stderr: "null",
  }).output();
  assertEquals(code, 0, `git ${args.join(" ")} failed`);
}

async function writeModel(dir: string): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    join(dir, "m.ts"),
    'export const model = { type: "@r/m" };',
  );
}

interface Layout {
  /** Real path of the temp root, which holds `ext/` and `sibling/`. */
  root: string;
  /** The git root and extension checkout. */
  ext: string;
  /** The swamp repo below the git root. */
  repo: string;
  /** A linked worktree of `ext`. */
  worktree: string;
}

async function withLayout(fn: (l: Layout) => Promise<void>): Promise<void> {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_4027_" });
  const root = await Deno.realPath(tmp);
  const ext = join(root, "ext");
  const repo = join(ext, "example");
  const worktree = join(root, "ext-wt");
  try {
    await writeModel(join(ext, "extensions", "models"));
    // Outside ext: a .. source resolved from the git root mounts this.
    await writeModel(join(root, "sibling", "extensions", "models"));
    await Deno.mkdir(repo, { recursive: true });
    await Deno.writeTextFile(join(repo, ".keep"), "");
    await git(ext, "init");
    await git(ext, "add", ".");
    await git(ext, "commit", "-m", "init");
    await git(ext, "worktree", "add", "--detach", worktree, "HEAD");
    await fn({ root, ext, repo, worktree });
  } finally {
    await new Deno.Command("git", {
      args: ["worktree", "remove", "--force", worktree],
      cwd: ext,
      stdout: "null",
      stderr: "null",
    }).output().catch(() => {});
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

async function add(repo: string, path: string): Promise<SourceModifyEvent> {
  const deps = await createSourceAddDeps(repo);
  let last: SourceModifyEvent | undefined;
  for await (const event of sourceAdd(ctx, deps, path)) last = event;
  return last!;
}

async function list(repo: string) {
  const deps = await createSourceListDeps(repo);
  let last: SourceListEvent | undefined;
  for await (const event of sourceList(ctx, deps)) last = event;
  if (last?.kind !== "completed") throw new Error("no completed event");
  return last.data.sources;
}

async function writeSources(repo: string, paths: string[]): Promise<void> {
  await Deno.writeTextFile(
    join(repo, ".swamp-sources.yaml"),
    `sources:\n${paths.map((p) => `  - path: ${p}\n`).join("")}`,
  );
}

Deno.test("relative sources: a nested repo adds direct-content and standard-layout paths", async () => {
  await withLayout(async ({ ext, repo }) => {
    assertEquals((await add(repo, "../extensions/models")).kind, "completed");
    assertEquals((await add(repo, "..")).kind, "completed");
    assertEquals(
      (await readSwampSources(repo))?.sources.map((s) => s.path),
      ["../extensions/models", ".."],
    );
    // Both sources mount the same directory, listed once.
    assertEquals(await resolveMountedSourceDirs(repo), [
      join(ext, "extensions", "models"),
    ]);
  });
});

Deno.test("relative sources: .. never mounts the parent of the git root", async () => {
  await withLayout(async ({ root, repo }) => {
    await writeSources(repo, [".."]);
    const mounted = await resolveMountedSourceDirs(repo);
    assertEquals(
      mounted.filter((dir) => dir.startsWith(join(root, "sibling"))),
      [],
    );
    const [entry] = await list(repo);
    assertEquals(entry.status, "valid");
    assertEquals(entry.expandedPaths, [join(root, "ext")]);
  });
});

Deno.test("relative sources: a linked worktree resolves into the main checkout", async () => {
  await withLayout(async ({ ext, worktree }) => {
    const repo = join(worktree, "example");
    await writeSources(repo, ["../extensions/models"]);
    assertEquals(await resolveMountedSourceDirs(repo), [
      join(ext, "extensions", "models"),
    ]);
  });
});

Deno.test("relative sources: a git-root-relative path from an earlier release still loads and lists", async () => {
  await withLayout(async ({ ext, repo }) => {
    // Only resolves from the git root: <repo>/extensions/models is absent.
    await writeSources(repo, ["extensions/models"]);
    assertEquals(await resolveMountedSourceDirs(repo), [
      join(ext, "extensions", "models"),
    ]);
    const [entry] = await list(repo);
    assertEquals(entry.status, "valid");
    assertEquals(entry.expandedPaths, [join(ext, "extensions", "models")]);
    assertEquals(entry.resolvedKinds, ["models"]);
  });
});

Deno.test("relative sources: add does not record a git-root-relative path", async () => {
  await withLayout(async ({ repo }) => {
    assertEquals((await add(repo, "extensions/models")).kind, "error");
    assertEquals(await readSwampSources(repo), null);
  });
});
