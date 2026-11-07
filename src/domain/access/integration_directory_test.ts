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
import { waitFor } from "@swamp-club/swamp-testing";
import type { UnifiedDataRepository } from "../data/repositories.ts";
import { Ceiling } from "./ceiling.ts";
import { IntegrationDirectory } from "./integration_directory.ts";

interface Row {
  readonly modelId: string;
  readonly attrs?: unknown;
  readonly raw?: string;
}

function record(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    name: id,
    credentialHash: `sha256:${"0".repeat(64)}`,
    ceiling: {
      version: 1,
      ceiling: [{ actions: ["read", "run"], resource: "workflow:*" }],
    },
    ceilingDigest: "sha256:x",
    state: "active",
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function repo(state: {
  rows: Row[];
  fail?: boolean;
  unreadable?: boolean;
}): UnifiedDataRepository {
  return {
    findAllForType: (type: { normalized: string }, options?: {
      unreadable?: unknown[];
    }) => {
      if (state.fail) return Promise.reject(new Error("listing failed"));
      if (type.normalized.startsWith("@")) return Promise.resolve([]);
      if (state.unreadable) {
        options?.unreadable?.push({
          modelType: type,
          modelId: "x",
          error: new Error("denied"),
        });
      }
      return Promise.resolve(
        state.rows.map((row) => ({
          data: { name: "integration-main" },
          modelType: type,
          modelId: row.modelId,
        })),
      );
    },
    getContent: (_type: unknown, modelId: string) => {
      const row = state.rows.find((r) => r.modelId === modelId)!;
      return Promise.resolve(
        new TextEncoder().encode(row.raw ?? JSON.stringify(row.attrs)),
      );
    },
  } as unknown as UnifiedDataRepository;
}

Deno.test("IntegrationDirectory: everything is unknown before the first load", () => {
  const directory = new IntegrationDirectory(repo({ rows: [] }));
  assertEquals(directory.known, false);
  assertEquals(directory.standingOf("a").kind, "unknown");
});

Deno.test("IntegrationDirectory: an empty repo leaves every id unknown", async () => {
  const directory = new IntegrationDirectory(repo({ rows: [] }));
  await directory.reload();
  assertEquals(directory.known, true);
  assertEquals(directory.standingOf("a").kind, "unknown");
  await directory.dispose();
});

Deno.test("IntegrationDirectory: reads active and revoked records", async () => {
  const directory = new IntegrationDirectory(repo({
    rows: [
      { modelId: "1", attrs: record("a") },
      { modelId: "2", attrs: record("b", { state: "revoked" }) },
    ],
  }));
  await directory.reload();
  assertEquals(directory.standingOf("a").kind, "active");
  assertEquals(directory.standingOf("b").kind, "revoked");
  await directory.dispose();
});

Deno.test("IntegrationDirectory: a ceiling version this build can't read refuses only that integration", async () => {
  const directory = new IntegrationDirectory(repo({
    rows: [
      {
        modelId: "1",
        attrs: record("a", { ceiling: { version: 2, ceiling: [] } }),
      },
      { modelId: "2", attrs: record("b") },
    ],
  }));
  await directory.reload();
  assertEquals(directory.standingOf("a").kind, "unknown");
  assertEquals(directory.standingOf("b").kind, "active");
  await directory.dispose();
});

Deno.test("IntegrationDirectory: copies that disagree are refused, and a revoked copy wins", async () => {
  const wider = {
    version: 1,
    ceiling: [{ actions: ["run"], resource: "workflow:other" }],
  };
  const directory = new IntegrationDirectory(repo({
    rows: [
      { modelId: "1", attrs: record("a") },
      { modelId: "2", attrs: record("a", { ceiling: wider }) },
      { modelId: "3", attrs: record("b") },
      { modelId: "4", attrs: record("b") },
      { modelId: "5", attrs: record("c") },
      { modelId: "6", attrs: record("c", { state: "revoked" }) },
    ],
  }));
  await directory.reload();
  assertEquals(directory.standingOf("a").kind, "unknown");
  assertEquals(directory.standingOf("b").kind, "active");
  assertEquals(directory.standingOf("c").kind, "revoked");
  await directory.dispose();
});

Deno.test("IntegrationDirectory: a failed reload refuses every integration until one succeeds", async () => {
  const state = { rows: [{ modelId: "1", attrs: record("a") }], fail: false };
  const directory = new IntegrationDirectory(repo(state), {
    retryMs: 3_600_000,
  });
  await directory.reload();
  assertEquals(directory.standingOf("a").kind, "active");
  state.fail = true;
  await directory.reload();
  assertEquals(directory.known, false);
  assertEquals(directory.standingOf("a").kind, "unknown");
  state.fail = false;
  await directory.reload();
  assertEquals(directory.standingOf("a").kind, "active");
  await directory.dispose();
});

Deno.test("IntegrationDirectory: an unreadable record or corrupt content refuses every integration", async () => {
  const state = {
    rows: [{ modelId: "1", attrs: record("a") }] as Row[],
    unreadable: true,
  };
  const directory = new IntegrationDirectory(repo(state), {
    retryMs: 3_600_000,
  });
  await directory.reload();
  assertEquals(directory.standingOf("a").kind, "unknown");
  state.unreadable = false;
  state.rows = [
    { modelId: "1", attrs: record("a") },
    { modelId: "2", raw: "{not json" },
  ];
  await directory.reload();
  assertEquals(directory.standingOf("a").kind, "unknown");
  await directory.dispose();
});

Deno.test("IntegrationDirectory: reports a revoke and a narrowing, but not a widening or a first load", async () => {
  const narrow = {
    version: 1,
    ceiling: [{ actions: ["read"], resource: "workflow:*" }],
  };
  const wide = record("b").ceiling;
  const state = {
    rows: [
      { modelId: "1", attrs: record("a") },
      { modelId: "2", attrs: record("b", { ceiling: narrow }) },
      { modelId: "3", attrs: record("c") },
    ] as Row[],
  };
  const seen: unknown[] = [];
  const directory = new IntegrationDirectory(repo(state));
  directory.onNarrowed((changes) => seen.push(...changes));
  await directory.reload();
  assertEquals(seen, []);
  state.rows = [
    { modelId: "1", attrs: record("a", { state: "revoked" }) },
    { modelId: "2", attrs: record("b", { ceiling: wide }) },
    { modelId: "3", attrs: record("c", { ceiling: narrow }) },
  ];
  await directory.reload();
  assertEquals(seen, [
    { id: "a", reason: "revoked" },
    { id: "c", reason: "narrowed" },
  ]);
  await directory.dispose();
});

Deno.test("IntegrationDirectory: a change made during a failed read is still seen once a read succeeds", async () => {
  const state = {
    rows: [{ modelId: "1", attrs: record("a") }] as Row[],
    fail: false,
  };
  const seen: unknown[] = [];
  const directory = new IntegrationDirectory(repo(state), {
    retryMs: 3_600_000,
  });
  directory.onNarrowed((changes) => seen.push(...changes));
  await directory.reload();
  state.fail = true;
  await directory.reload();
  assertEquals(seen, []);
  state.fail = false;
  state.rows = [{ modelId: "1", attrs: record("a", { state: "revoked" }) }];
  await directory.reload();
  assertEquals(seen, [{ id: "a", reason: "revoked" }]);
  await directory.dispose();
});

Deno.test("IntegrationDirectory: a parsed ceiling keeps its meaning", async () => {
  const directory = new IntegrationDirectory(repo({
    rows: [{ modelId: "1", attrs: record("a") }],
  }));
  await directory.reload();
  const standing = directory.standingOf("a");
  assertEquals(
    standing.kind === "active" &&
      standing.ceiling.equals(Ceiling.parse(record("a").ceiling)),
    true,
  );
  await directory.dispose();
});

Deno.test("IntegrationDirectory: a write in this process reloads it in any reload mode, for this type only", async () => {
  const state = { rows: [] as Row[] };
  const handlers = new Map<string, (event: unknown) => void>();
  const directory = new IntegrationDirectory(repo(state), {
    eventBus: {
      subscribe: (type: string, handler: (event: unknown) => void) => {
        handlers.set(type, handler);
        return () => {};
      },
    } as never,
  });
  await directory.reload();
  state.rows = [{ modelId: "1", attrs: record("a") }];
  handlers.get("ModelUpdated")!({ modelType: "swamp/grant" });
  await directory.reload();
  state.rows = [{ modelId: "1", attrs: record("a", { state: "revoked" }) }];
  handlers.get("ModelUpdated")!({ modelType: "swamp/integration" });
  await waitFor(
    () => directory.standingOf("a").kind === "revoked",
    "the event reloaded the directory",
  );
  await directory.dispose();
});

Deno.test("IntegrationDirectory: a record with no content refuses every integration, since it may be the revoke", async () => {
  const base = repo({ rows: [{ modelId: "1", attrs: record("a") }] });
  const directory = new IntegrationDirectory({
    ...base,
    findAllForType: base.findAllForType,
    getContent: () => Promise.resolve(null),
  } as unknown as UnifiedDataRepository, { retryMs: 3_600_000 });
  await directory.reload();
  assertEquals(directory.known, false);
  assertEquals(directory.standingOf("a").kind, "unknown");
  await directory.dispose();
});
