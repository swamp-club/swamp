// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { sourceRemove, type SourceRemoveDeps } from "./remove.ts";
import { createLibSwampContext } from "../context.ts";
import type { SwampSourcesConfig } from "../../domain/repo/swamp_sources.ts";
import type { SourceModifyEvent } from "./source_events.ts";

function createTestDeps(
  existing: SwampSourcesConfig | null = null,
): SourceRemoveDeps & {
  written: SwampSourcesConfig | null;
  removed: boolean;
  purgedPrefixes: string[];
} {
  const state = {
    written: null as SwampSourcesConfig | null,
    removed: false,
    purgedPrefixes: [] as string[],
  };
  return {
    readSources: () => Promise.resolve(existing),
    writeSources: (config) => {
      state.written = config;
      return Promise.resolve();
    },
    removeSources: () => {
      state.removed = true;
      return Promise.resolve();
    },
    purgeCatalogByPrefix: (prefix: string) => {
      state.purgedPrefixes.push(prefix);
      return 1;
    },
    expandPath: (path: string) => Promise.resolve([path]),
    get written() {
      return state.written;
    },
    get removed() {
      return state.removed;
    },
    get purgedPrefixes() {
      return state.purgedPrefixes;
    },
  };
}

async function collectEvents(
  gen: AsyncIterable<SourceModifyEvent>,
): Promise<SourceModifyEvent[]> {
  const events: SourceModifyEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

const ctx = createLibSwampContext({});

Deno.test("sourceRemove: removes an existing source", async () => {
  const deps = createTestDeps({
    sources: [
      { path: "~/code/ext-a" },
      { path: "~/code/ext-b" },
    ],
  });
  const events = await collectEvents(
    sourceRemove(ctx, deps, "~/code/ext-a"),
  );

  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.action, "removed");
    assertEquals(completed.data.path, "~/code/ext-a");
    assertEquals(completed.data.totalSources, 1);
  }
  assertEquals(deps.written?.sources.length, 1);
  assertEquals(deps.written?.sources[0].path, "~/code/ext-b");
});

Deno.test("sourceRemove: deletes file when last source removed", async () => {
  const deps = createTestDeps({
    sources: [{ path: "~/code/only-one" }],
  });
  const events = await collectEvents(
    sourceRemove(ctx, deps, "~/code/only-one"),
  );

  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.totalSources, 0);
  }
  assertEquals(deps.removed, true);
  assertEquals(deps.written, null);
});

Deno.test("sourceRemove: errors when path not found", async () => {
  const deps = createTestDeps({
    sources: [{ path: "~/code/existing" }],
  });
  const events = await collectEvents(
    sourceRemove(ctx, deps, "~/code/nonexistent"),
  );

  const error = events.find((e) => e.kind === "error");
  assertEquals(error?.kind, "error");
});

Deno.test("sourceRemove: errors when no sources configured", async () => {
  const deps = createTestDeps(null);
  const events = await collectEvents(
    sourceRemove(ctx, deps, "~/code/anything"),
  );

  const error = events.find((e) => e.kind === "error");
  assertEquals(error?.kind, "error");
});

Deno.test("sourceRemove: purges catalog rows for removed source", async () => {
  const deps = createTestDeps({
    sources: [
      { path: "~/code/ext-a" },
      { path: "~/code/ext-b" },
    ],
  });
  await collectEvents(sourceRemove(ctx, deps, "~/code/ext-a"));

  assertEquals(deps.purgedPrefixes, ["~/code/ext-a"]);
});

Deno.test("sourceRemove: purges catalog for last source removed", async () => {
  const deps = createTestDeps({
    sources: [{ path: "/abs/path/extensions" }],
  });
  await collectEvents(sourceRemove(ctx, deps, "/abs/path/extensions"));

  assertEquals(deps.purgedPrefixes, ["/abs/path/extensions"]);
});

Deno.test("sourceRemove: does not purge catalog on error path", async () => {
  const deps = createTestDeps({
    sources: [{ path: "~/code/existing" }],
  });
  await collectEvents(sourceRemove(ctx, deps, "~/code/nonexistent"));

  assertEquals(deps.purgedPrefixes, []);
});

Deno.test("sourceRemove: purges multiple expanded paths from glob source", async () => {
  const state = {
    written: null as SwampSourcesConfig | null,
    removed: false,
    purgedPrefixes: [] as string[],
  };
  const deps: SourceRemoveDeps & {
    written: SwampSourcesConfig | null;
    removed: boolean;
    purgedPrefixes: string[];
  } = {
    readSources: () => Promise.resolve({ sources: [{ path: "~/code/ext-*" }] }),
    writeSources: (_config) => {
      state.written = _config;
      return Promise.resolve();
    },
    removeSources: () => {
      state.removed = true;
      return Promise.resolve();
    },
    purgeCatalogByPrefix: (prefix: string) => {
      state.purgedPrefixes.push(prefix);
      return 1;
    },
    expandPath: () =>
      Promise.resolve(["/expanded/ext-one", "/expanded/ext-two"]),
    get written() {
      return state.written;
    },
    get removed() {
      return state.removed;
    },
    get purgedPrefixes() {
      return state.purgedPrefixes;
    },
  };

  await collectEvents(sourceRemove(ctx, deps, "~/code/ext-*"));

  assertEquals(deps.purgedPrefixes, ["/expanded/ext-one", "/expanded/ext-two"]);
});
