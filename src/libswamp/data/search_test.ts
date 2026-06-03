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

import { assertEquals, assertThrows } from "@std/assert";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  dataSearch,
  type DataSearchDeps,
  type DataSearchEvent,
  parseDuration,
  parseTags,
} from "./search.ts";
import { UserError } from "../../domain/errors.ts";

function makeDataItem(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      id: (overrides.id as string) ?? "d1",
      name: (overrides.name as string) ?? "output",
      version: (overrides.version as number) ?? 1,
      contentType: (overrides.contentType as string) ?? "application/json",
      type: (overrides.type as string) ?? "data",
      lifetime: (overrides.lifetime as string) ?? "persistent",
      ownerDefinition: {
        ownerType: (overrides.ownerType as string) ?? "model",
        ownerRef: (overrides.ownerRef as string) ?? "ref-1",
      },
      streaming: (overrides.streaming as boolean) ?? false,
      size: (overrides.size as number) ?? 100,
      createdAt: (overrides.createdAt as Date) ?? new Date("2026-01-15"),
      tags: (overrides.tags as Record<string, string>) ?? {},
    },
    modelType: { normalized: (overrides.modelType as string) ?? "aws/ec2" },
    modelId: (overrides.modelId as string) ?? "model-1",
  };
}

function makeDeps(
  items: ReturnType<typeof makeDataItem>[] = [],
  overrides?: Partial<DataSearchDeps>,
): DataSearchDeps {
  return {
    findAllGlobal: () => Promise.resolve(items),
    findDefinitionById: (_type, defId) =>
      Promise.resolve({ name: `name-${defId}` }),
    findDefinitionByIdOrName: () =>
      Promise.resolve({ definition: { name: "my-model" } }),
    ...overrides,
  };
}

Deno.test("dataSearch: returns all data items with no query or filters", async () => {
  const items = [
    makeDataItem({ id: "d1", name: "alpha" }),
    makeDataItem({ id: "d2", name: "beta" }),
  ];
  const deps = makeDeps(items);
  const events = await collect<DataSearchEvent>(
    dataSearch(createLibSwampContext(), deps, {}),
  );

  assertEquals(events[0], { kind: "resolving" });
  assertEquals(events[1].kind, "completed");
  const completed = events[1] as Extract<
    DataSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 2);
  assertEquals(completed.data.total, 2);
  assertEquals(completed.data.limited, false);
});

Deno.test("dataSearch: filters by type", async () => {
  const items = [
    makeDataItem({ id: "d1", type: "data" }),
    makeDataItem({ id: "d2", type: "log" }),
    makeDataItem({ id: "d3", type: "data" }),
  ];
  const deps = makeDeps(items);
  const events = await collect<DataSearchEvent>(
    dataSearch(createLibSwampContext(), deps, { type: "log" }),
  );

  const completed = events[1] as Extract<
    DataSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 1);
  assertEquals(completed.data.results[0].type, "log");
  assertEquals(completed.data.filters.type, "log");
});

Deno.test("dataSearch: filters by since duration", async () => {
  const now = new Date();
  const recent = new Date(now.getTime() - 1 * 60 * 60 * 1000); // 1 hour ago
  const old = new Date(now.getTime() - 48 * 60 * 60 * 1000); // 48 hours ago
  const items = [
    makeDataItem({ id: "d1", createdAt: recent }),
    makeDataItem({ id: "d2", createdAt: old }),
  ];
  const deps = makeDeps(items);
  const events = await collect<DataSearchEvent>(
    dataSearch(createLibSwampContext(), deps, { since: "1d" }),
  );

  const completed = events[1] as Extract<
    DataSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 1);
  assertEquals(completed.data.results[0].id, "d1");
});

Deno.test("dataSearch: filters by tags with AND logic", async () => {
  const items = [
    makeDataItem({
      id: "d1",
      tags: { env: "prod", team: "infra" },
    }),
    makeDataItem({
      id: "d2",
      tags: { env: "prod", team: "app" },
    }),
    makeDataItem({
      id: "d3",
      tags: { env: "staging" },
    }),
  ];
  const deps = makeDeps(items);
  const events = await collect<DataSearchEvent>(
    dataSearch(createLibSwampContext(), deps, {
      tags: { env: "prod", team: "infra" },
    }),
  );

  const completed = events[1] as Extract<
    DataSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 1);
  assertEquals(completed.data.results[0].id, "d1");
});

Deno.test("dataSearch: surfaces workflowTag/jobTag/stepTag from data tags", async () => {
  const items = [
    makeDataItem({
      id: "d1",
      tags: { workflow: "my-wf", job: "my-job", step: "my-step" },
    }),
  ];
  const deps = makeDeps(items);
  const events = await collect<DataSearchEvent>(
    dataSearch(createLibSwampContext(), deps, {}),
  );

  const completed = events[1] as Extract<
    DataSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 1);
  assertEquals(completed.data.results[0].workflowTag, "my-wf");
  assertEquals(completed.data.results[0].jobTag, "my-job");
  assertEquals(completed.data.results[0].stepTag, "my-step");
});

Deno.test("dataSearch: jobTag is undefined when data has no job tag", async () => {
  const items = [
    makeDataItem({ id: "d1", tags: {} }),
  ];
  const deps = makeDeps(items);
  const events = await collect<DataSearchEvent>(
    dataSearch(createLibSwampContext(), deps, {}),
  );

  const completed = events[1] as Extract<
    DataSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 1);
  assertEquals(completed.data.results[0].jobTag, undefined);
});

Deno.test("dataSearch: yields error when model not found", async () => {
  const deps = makeDeps([], {
    findDefinitionByIdOrName: () => Promise.resolve(null),
  });
  const events = await collect<DataSearchEvent>(
    dataSearch(createLibSwampContext(), deps, { model: "missing" }),
  );

  assertEquals(events[0], { kind: "resolving" });
  assertEquals(events[1].kind, "error");
  const error = events[1] as Extract<DataSearchEvent, { kind: "error" }>;
  assertEquals(error.error.code, "validation_failed");
});

Deno.test("dataSearch: applies limit and reports total/limited correctly", async () => {
  const items = [
    makeDataItem({ id: "d1" }),
    makeDataItem({ id: "d2" }),
    makeDataItem({ id: "d3" }),
  ];
  const deps = makeDeps(items);
  const events = await collect<DataSearchEvent>(
    dataSearch(createLibSwampContext(), deps, { limit: 2 }),
  );

  const completed = events[1] as Extract<
    DataSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 2);
  assertEquals(completed.data.total, 3);
  assertEquals(completed.data.limited, true);
});

Deno.test("dataSearch: sorts results by createdAt descending", async () => {
  const items = [
    makeDataItem({ id: "d1", createdAt: new Date("2026-01-01") }),
    makeDataItem({ id: "d2", createdAt: new Date("2026-03-01") }),
    makeDataItem({ id: "d3", createdAt: new Date("2026-02-01") }),
  ];
  const deps = makeDeps(items);
  const events = await collect<DataSearchEvent>(
    dataSearch(createLibSwampContext(), deps, {}),
  );

  const completed = events[1] as Extract<
    DataSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results[0].id, "d2");
  assertEquals(completed.data.results[1].id, "d3");
  assertEquals(completed.data.results[2].id, "d1");
});

Deno.test("parseDuration: parses valid duration formats", () => {
  assertEquals(parseDuration("1h"), 60 * 60 * 1000);
  assertEquals(parseDuration("5m"), 5 * 60 * 1000);
  assertEquals(parseDuration("1d"), 24 * 60 * 60 * 1000);
  assertEquals(parseDuration("2w"), 2 * 7 * 24 * 60 * 60 * 1000);
  assertEquals(parseDuration("1mo"), 30 * 24 * 60 * 60 * 1000);
  assertEquals(parseDuration("1y"), 365 * 24 * 60 * 60 * 1000);
  assertThrows(
    () => parseDuration("abc"),
    UserError,
    "Invalid duration format",
  );
  assertThrows(
    () => parseDuration("10x"),
    UserError,
    "Invalid duration format",
  );
});

Deno.test("parseTags: parses KEY=VALUE strings", () => {
  assertEquals(parseTags(["env=prod", "team=infra"]), {
    env: "prod",
    team: "infra",
  });
  assertEquals(parseTags(["key=val=ue"]), { key: "val=ue" });
  assertEquals(parseTags([]), {});
  assertThrows(() => parseTags(["noequals"]), UserError, "Invalid tag format");
  assertThrows(() => parseTags(["=value"]), UserError, "Invalid tag format");
});
