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
import { sourceAdd, type SourceAddDeps } from "./add.ts";
import { createLibSwampContext } from "../context.ts";
import type { SwampSourcesConfig } from "../../domain/repo/swamp_sources.ts";
import type { SourceModifyEvent } from "./source_events.ts";

function createTestDeps(
  existing: SwampSourcesConfig | null = null,
): SourceAddDeps & { written: SwampSourcesConfig | null } {
  const state = { written: null as SwampSourcesConfig | null };
  return {
    readSources: () => Promise.resolve(existing),
    writeSources: (config) => {
      state.written = config;
      return Promise.resolve();
    },
    get written() {
      return state.written;
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

Deno.test("sourceAdd: adds a new source to empty config", async () => {
  const deps = createTestDeps(null);
  const events = await collectEvents(
    sourceAdd(ctx, deps, "~/code/my-extensions"),
  );

  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.action, "added");
    assertEquals(completed.data.path, "~/code/my-extensions");
    assertEquals(completed.data.totalSources, 1);
  }
  assertEquals(deps.written?.sources.length, 1);
});

Deno.test("sourceAdd: adds to existing sources", async () => {
  const deps = createTestDeps({
    sources: [{ path: "~/code/existing" }],
  });
  const events = await collectEvents(
    sourceAdd(ctx, deps, "~/code/new-source"),
  );

  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.totalSources, 2);
  }
  assertEquals(deps.written?.sources.length, 2);
});

Deno.test("sourceAdd: adds with only filter", async () => {
  const deps = createTestDeps(null);
  const events = await collectEvents(
    sourceAdd(ctx, deps, "~/code/vaults", ["vaults"]),
  );

  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.only, ["vaults"]);
  }
  assertEquals(deps.written?.sources[0].only, ["vaults"]);
});

Deno.test("sourceAdd: rejects duplicate path", async () => {
  const deps = createTestDeps({
    sources: [{ path: "~/code/my-extensions" }],
  });
  const events = await collectEvents(
    sourceAdd(ctx, deps, "~/code/my-extensions"),
  );

  const error = events.find((e) => e.kind === "error");
  assertEquals(error?.kind, "error");
});

Deno.test("sourceAdd: rejects empty path", async () => {
  const deps = createTestDeps(null);
  const events = await collectEvents(sourceAdd(ctx, deps, ""));

  const error = events.find((e) => e.kind === "error");
  assertEquals(error?.kind, "error");
});
