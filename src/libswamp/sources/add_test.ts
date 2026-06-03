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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { sourceAdd, type SourceAddDeps } from "./add.ts";
import { createLibSwampContext } from "../context.ts";
import type {
  ExtensionKind,
  SwampSource,
  SwampSourcesConfig,
} from "../../domain/repo/swamp_sources.ts";
import type { SourceModifyEvent } from "./source_events.ts";

interface TestDeps extends SourceAddDeps {
  written: SwampSourcesConfig | null;
}

function createTestDeps(
  options: {
    existing?: SwampSourcesConfig | null;
    /** Override the resolver return for the next call. Accepts a function
     * so tests can key on the path being validated. */
    resolveKinds?: (source: SwampSource) => ExtensionKind[];
    /** Override the glob expansion for the next call. */
    expandSource?: (source: SwampSource) => SwampSource[];
  } = {},
): TestDeps {
  const state = { written: null as SwampSourcesConfig | null };
  return {
    readSources: () => Promise.resolve(options.existing ?? null),
    writeSources: (config) => {
      state.written = config;
      return Promise.resolve();
    },
    resolveKinds: (source) =>
      Promise.resolve(options.resolveKinds?.(source) ?? ["models"]),
    expandSource: (source) =>
      Promise.resolve(options.expandSource?.(source) ?? [source]),
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

function findCompleted(events: SourceModifyEvent[]) {
  return events.find((e) => e.kind === "completed");
}

function findError(events: SourceModifyEvent[]) {
  return events.find((e) => e.kind === "error");
}

const ctx = createLibSwampContext({});

// ----------------------------------------------------------------
// Basic add behaviours (independent of resolver validation).
// ----------------------------------------------------------------

Deno.test("sourceAdd: adds a new source when resolver reports kinds", async () => {
  const deps = createTestDeps({ resolveKinds: () => ["models"] });
  const events = await collectEvents(
    sourceAdd(ctx, deps, "/some/valid/path"),
  );

  const completed = findCompleted(events);
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.action, "added");
    assertEquals(completed.data.path, "/some/valid/path");
    assertEquals(completed.data.totalSources, 1);
  }
  assertEquals(deps.written?.sources.length, 1);
});

Deno.test("sourceAdd: adds to existing sources", async () => {
  const deps = createTestDeps({
    existing: { sources: [{ path: "/existing" }] },
    resolveKinds: () => ["models"],
  });
  const events = await collectEvents(
    sourceAdd(ctx, deps, "/new-source"),
  );

  const completed = findCompleted(events);
  if (completed?.kind === "completed") {
    assertEquals(completed.data.totalSources, 2);
  }
  assertEquals(deps.written?.sources.length, 2);
});

Deno.test("sourceAdd: adds with only filter", async () => {
  const deps = createTestDeps({ resolveKinds: () => ["vaults"] });
  const events = await collectEvents(
    sourceAdd(ctx, deps, "/vaults-src", ["vaults"]),
  );

  const completed = findCompleted(events);
  if (completed?.kind === "completed") {
    assertEquals(completed.data.only, ["vaults"]);
  }
  assertEquals(deps.written?.sources[0].only, ["vaults"]);
});

Deno.test("sourceAdd: rejects duplicate path", async () => {
  const deps = createTestDeps({
    existing: { sources: [{ path: "/dup" }] },
    resolveKinds: () => ["models"],
  });
  const events = await collectEvents(sourceAdd(ctx, deps, "/dup"));

  const error = findError(events);
  assertEquals(error?.kind, "error");
  assertEquals(deps.written, null);
});

Deno.test("sourceAdd: rejects empty path", async () => {
  const deps = createTestDeps();
  const events = await collectEvents(sourceAdd(ctx, deps, ""));

  const error = findError(events);
  assertEquals(error?.kind, "error");
  assertEquals(deps.written, null);
});

// ----------------------------------------------------------------
// Issue-139 validation: fail fast when the source contributes nothing.
// ----------------------------------------------------------------

Deno.test("sourceAdd: rejects concrete path that resolves to zero kinds", async () => {
  const deps = createTestDeps({ resolveKinds: () => [] });
  const events = await collectEvents(sourceAdd(ctx, deps, "/empty"));

  const error = findError(events);
  assertEquals(error?.kind, "error");
  if (error?.kind === "error") {
    assertStringIncludes(error.error.message, "No extensions found");
    assertStringIncludes(error.error.message, "/empty");
  }
  assertEquals(deps.written, null);
});

Deno.test("sourceAdd: rejection names probed kinds so --only mismatches are self-diagnosable", async () => {
  const deps = createTestDeps({ resolveKinds: () => [] });
  const events = await collectEvents(
    sourceAdd(ctx, deps, "/models-only-repo", ["vaults"]),
  );

  const error = findError(events);
  assertEquals(error?.kind, "error");
  if (error?.kind === "error") {
    assertStringIncludes(error.error.message, "vaults");
  }
  assertEquals(deps.written, null);
});

Deno.test("sourceAdd: rejection does NOT leak all kinds when --only is set", async () => {
  const deps = createTestDeps({ resolveKinds: () => [] });
  const events = await collectEvents(
    sourceAdd(ctx, deps, "/src", ["vaults"]),
  );

  const error = findError(events);
  if (error?.kind === "error") {
    // Only the requested kind should appear in the "expected" list.
    // Avoids a confusing message that suggests all kinds are expected
    // when the user explicitly narrowed via --only.
    const msg = error.error.message;
    // vaults is in the list
    assertStringIncludes(msg, "vaults");
    // The message should NOT enumerate the unrequested kinds.
    assertEquals(msg.includes("models"), false);
    assertEquals(msg.includes("drivers"), false);
  }
});

// ----------------------------------------------------------------
// Glob semantics: unexpanded allowed, expanded-but-empty rejected,
// expanded-with-content accepted.
// ----------------------------------------------------------------

Deno.test("sourceAdd: allows unexpanded glob (pre-population workflow)", async () => {
  const deps = createTestDeps({
    resolveKinds: () => [], // no kinds (glob hasn't matched anything yet)
    expandSource: () => [], // zero expansions
  });
  const events = await collectEvents(
    sourceAdd(ctx, deps, "/prefix/*"),
  );

  const completed = findCompleted(events);
  assertEquals(
    completed?.kind,
    "completed",
    "unexpanded glob should be allowed",
  );
  assertEquals(deps.written?.sources[0].path, "/prefix/*");
});

Deno.test("sourceAdd: rejects glob with expansions but zero kinds", async () => {
  const deps = createTestDeps({
    resolveKinds: () => [],
    expandSource: () => [
      { path: "/matched/a" },
      { path: "/matched/b" },
    ],
  });
  const events = await collectEvents(
    sourceAdd(ctx, deps, "/matched/*"),
  );

  const error = findError(events);
  assertEquals(error?.kind, "error");
  if (error?.kind === "error") {
    assertStringIncludes(error.error.message, "glob");
    assertStringIncludes(error.error.message, "2");
  }
  assertEquals(deps.written, null);
});

Deno.test("sourceAdd: accepts glob when at least one expansion contributes kinds", async () => {
  const deps = createTestDeps({
    resolveKinds: () => ["models"],
    expandSource: () => [
      { path: "/matched/a" },
      { path: "/matched/b" },
      { path: "/matched/c" },
    ],
  });
  const events = await collectEvents(
    sourceAdd(ctx, deps, "/matched/*"),
  );

  const completed = findCompleted(events);
  assertEquals(completed?.kind, "completed");
});

// ----------------------------------------------------------------
// End-to-end integration with the real resolver (temp-dir fixtures).
// These exercise the full path from sourceAdd → resolveExtensionKinds
// ForSource → both layouts, ensuring the unit-level fakes above agree
// with real filesystem behaviour.
// ----------------------------------------------------------------

import { createSourceAddDeps } from "./add.ts";

async function withTempRepo(
  fn: (repoDir: string) => Promise<void>,
): Promise<void> {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_sa_" });
  try {
    await fn(tmp);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

Deno.test("sourceAdd e2e: standard-layout repo with extensions/models/", async () => {
  await withTempRepo(async (repo) => {
    const src = join(repo, "src-root");
    await Deno.mkdir(join(src, "extensions", "models"), { recursive: true });
    await Deno.writeTextFile(
      join(src, "extensions", "models", "m.ts"),
      'export const model = { type: "@r/m" };',
    );
    const deps = createSourceAddDeps(repo);
    const events = await collectEvents(sourceAdd(ctx, deps, src));
    assertEquals(findCompleted(events)?.kind, "completed");
  });
});

Deno.test("sourceAdd e2e: non-standard layout — loose model.ts at root", async () => {
  await withTempRepo(async (repo) => {
    const src = join(repo, "loose");
    await Deno.mkdir(src, { recursive: true });
    await Deno.writeTextFile(
      join(src, "m.ts"),
      'export const model = { type: "@r/m" };',
    );
    const deps = createSourceAddDeps(repo);
    const events = await collectEvents(sourceAdd(ctx, deps, src));
    assertEquals(findCompleted(events)?.kind, "completed");
  });
});

Deno.test("sourceAdd e2e: reporter's case — extensions/models/ as source path", async () => {
  await withTempRepo(async (repo) => {
    // Exactly the issue-139 reporter's misconfiguration: user points at
    // the models dir itself instead of the parent repo root.
    const src = join(repo, "sister", "extensions", "models");
    await Deno.mkdir(src, { recursive: true });
    await Deno.writeTextFile(
      join(src, "m.ts"),
      'export const model = { type: "@r/m" };',
    );
    const deps = createSourceAddDeps(repo);
    const events = await collectEvents(sourceAdd(ctx, deps, src));
    assertEquals(
      findCompleted(events)?.kind,
      "completed",
      "reporter's case should now succeed",
    );
  });
});

Deno.test("sourceAdd e2e: empty directory is rejected", async () => {
  await withTempRepo(async (repo) => {
    const src = join(repo, "empty");
    await Deno.mkdir(src, { recursive: true });
    const deps = createSourceAddDeps(repo);
    const events = await collectEvents(sourceAdd(ctx, deps, src));
    const error = findError(events);
    assertEquals(error?.kind, "error");
  });
});

Deno.test("sourceAdd e2e: --only mismatch against models-only source is rejected", async () => {
  await withTempRepo(async (repo) => {
    const src = join(repo, "m-only");
    await Deno.mkdir(join(src, "extensions", "models"), { recursive: true });
    const deps = createSourceAddDeps(repo);
    const events = await collectEvents(
      sourceAdd(ctx, deps, src, ["vaults"]),
    );
    const error = findError(events);
    assertEquals(error?.kind, "error");
    if (error?.kind === "error") {
      assertStringIncludes(error.error.message, "vaults");
    }
  });
});

Deno.test("sourceAdd e2e: mixed layout — standard wins, loose files ignored", async () => {
  await withTempRepo(async (repo) => {
    const src = join(repo, "mixed");
    await Deno.mkdir(join(src, "extensions", "models"), { recursive: true });
    await Deno.writeTextFile(
      join(src, "extensions", "models", "m.ts"),
      'export const model = { type: "@r/m" };',
    );
    await Deno.writeTextFile(
      join(src, "loose.ts"),
      'export const model = { type: "@r/loose" };',
    );
    const deps = createSourceAddDeps(repo);
    const events = await collectEvents(sourceAdd(ctx, deps, src));
    // Should succeed — standard layout has content; loose file ignored.
    assertEquals(findCompleted(events)?.kind, "completed");
  });
});
