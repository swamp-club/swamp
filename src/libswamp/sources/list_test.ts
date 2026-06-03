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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createSourceListDeps, sourceList } from "./list.ts";
import { createLibSwampContext } from "../context.ts";
import type { SourceListEvent } from "./source_events.ts";

const ctx = createLibSwampContext({});

async function collect(
  gen: AsyncIterable<SourceListEvent>,
): Promise<SourceListEvent[]> {
  const events: SourceListEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

function completedData(events: SourceListEvent[]) {
  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind !== "completed") throw new Error("no completed event");
  return completed.data;
}

async function withRepo(fn: (repo: string) => Promise<void>): Promise<void> {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_list_" });
  try {
    await fn(tmp);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

async function writeSourcesYaml(repo: string, body: string) {
  await Deno.writeTextFile(join(repo, ".swamp-sources.yaml"), body);
}

Deno.test("sourceList: returns empty when no config", async () => {
  await withRepo(async (repo) => {
    const deps = createSourceListDeps(repo);
    const data = completedData(await collect(sourceList(ctx, deps)));
    assertEquals(data.sources, []);
  });
});

Deno.test("sourceList: concrete valid source shows valid + resolvedKinds", async () => {
  await withRepo(async (repo) => {
    const src = join(repo, "s");
    await Deno.mkdir(join(src, "extensions", "models"), { recursive: true });
    await writeSourcesYaml(repo, `sources:\n  - path: ${src}\n`);
    const deps = createSourceListDeps(repo);
    const data = completedData(await collect(sourceList(ctx, deps)));
    assertEquals(data.sources.length, 1);
    assertEquals(data.sources[0].status, "valid");
    assertEquals(data.sources[0].resolvedKinds, ["models"]);
  });
});

Deno.test("sourceList: concrete path that exists but resolves to zero kinds → no_extensions", async () => {
  await withRepo(async (repo) => {
    const src = join(repo, "empty");
    await Deno.mkdir(src, { recursive: true });
    await writeSourcesYaml(repo, `sources:\n  - path: ${src}\n`);
    const deps = createSourceListDeps(repo);
    const data = completedData(await collect(sourceList(ctx, deps)));
    assertEquals(data.sources[0].status, "no_extensions");
    assertEquals(data.sources[0].resolvedKinds, undefined);
  });
});

Deno.test("sourceList: missing path → path_not_found", async () => {
  await withRepo(async (repo) => {
    await writeSourcesYaml(
      repo,
      `sources:\n  - path: ${repo}/does-not-exist\n`,
    );
    const deps = createSourceListDeps(repo);
    const data = completedData(await collect(sourceList(ctx, deps)));
    assertEquals(data.sources[0].status, "path_not_found");
  });
});

Deno.test("sourceList: glob that matches nothing → path_not_found", async () => {
  await withRepo(async (repo) => {
    await writeSourcesYaml(
      repo,
      `sources:\n  - path: ${repo}/no-match/*\n`,
    );
    const deps = createSourceListDeps(repo);
    const data = completedData(await collect(sourceList(ctx, deps)));
    assertEquals(data.sources[0].status, "path_not_found");
  });
});

Deno.test("sourceList: glob expanding to dirs with no kinds → no_extensions", async () => {
  await withRepo(async (repo) => {
    await Deno.mkdir(join(repo, "parent", "a"), { recursive: true });
    await Deno.mkdir(join(repo, "parent", "b"), { recursive: true });
    await writeSourcesYaml(
      repo,
      `sources:\n  - path: ${repo}/parent/*\n`,
    );
    const deps = createSourceListDeps(repo);
    const data = completedData(await collect(sourceList(ctx, deps)));
    assertEquals(data.sources[0].status, "no_extensions");
  });
});

Deno.test("sourceList: glob with mixed expansions (1 valid of 3) → valid + resolvedKinds union", async () => {
  await withRepo(async (repo) => {
    const parent = join(repo, "mixed");
    await Deno.mkdir(join(parent, "empty1"), { recursive: true });
    await Deno.mkdir(join(parent, "empty2"), { recursive: true });
    await Deno.mkdir(join(parent, "good", "extensions", "vaults"), {
      recursive: true,
    });
    await writeSourcesYaml(
      repo,
      `sources:\n  - path: ${parent}/*\n`,
    );
    const deps = createSourceListDeps(repo);
    const data = completedData(await collect(sourceList(ctx, deps)));
    assertEquals(data.sources[0].status, "valid");
    assertEquals(data.sources[0].resolvedKinds, ["vaults"]);
  });
});

Deno.test("sourceList: non-standard layout (content pre-scan) shows resolvedKinds", async () => {
  await withRepo(async (repo) => {
    const src = join(repo, "loose");
    await Deno.mkdir(src, { recursive: true });
    await Deno.writeTextFile(
      join(src, "m.ts"),
      'export const model = { type: "@r/m" };',
    );
    await writeSourcesYaml(repo, `sources:\n  - path: ${src}\n`);
    const deps = createSourceListDeps(repo);
    const data = completedData(await collect(sourceList(ctx, deps)));
    assertEquals(data.sources[0].status, "valid");
    assertEquals(data.sources[0].resolvedKinds, ["models"]);
  });
});

Deno.test("sourceList: resolvedKinds is sorted by EXTENSION_KINDS declaration order", async () => {
  await withRepo(async (repo) => {
    const src = join(repo, "multi");
    // Create in reverse declaration order to force sorting.
    for (const k of ["workflows", "reports", "vaults", "models"]) {
      await Deno.mkdir(join(src, "extensions", k), { recursive: true });
    }
    await writeSourcesYaml(repo, `sources:\n  - path: ${src}\n`);
    const deps = createSourceListDeps(repo);
    const data = completedData(await collect(sourceList(ctx, deps)));
    assertEquals(data.sources[0].resolvedKinds, [
      "models",
      "vaults",
      "reports",
      "workflows",
    ]);
  });
});

Deno.test("sourceList: preserves existing fields (path, only, expandedPaths, status)", async () => {
  await withRepo(async (repo) => {
    const src = join(repo, "good");
    await Deno.mkdir(join(src, "extensions", "models"), { recursive: true });
    await writeSourcesYaml(
      repo,
      `sources:\n  - path: ${src}\n    only: [models]\n`,
    );
    const deps = createSourceListDeps(repo);
    const data = completedData(await collect(sourceList(ctx, deps)));
    const entry = data.sources[0];
    assertEquals(entry.path, src);
    assertEquals(entry.only, ["models"]);
    assertEquals(entry.expandedPaths.length, 1);
    assertEquals(entry.status, "valid");
  });
});
