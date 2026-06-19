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
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import type { DataRecord } from "../../domain/data/data_record.ts";
import {
  serverTokenList,
  type ServerTokenListDeps,
  type ServerTokenListEvent,
} from "./token_list.ts";

function makeRecord(
  modelName: string,
  dataName: string,
  attributes: Record<string, unknown>,
): DataRecord {
  return {
    id: `${modelName}-${dataName}`,
    name: dataName,
    version: 1,
    isLatest: true,
    createdAt: "2026-06-18T00:00:00.000Z",
    namespace: "",
    attributes,
    tags: {},
    modelName,
    modelId: modelName,
    modelType: "swamp/server-token",
    specName: "token",
    dataType: "resource",
    contentType: "application/json",
    lifetime: "infinite",
    ownerType: "model",
    streaming: false,
    size: 0,
    content: "",
    ownerRef: "",
    workflowRunId: "",
    workflowName: "",
    jobName: "",
    stepName: "",
    source: "",
  };
}

function tokenAttributes(
  name: string,
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    name,
    state: "active",
    principalId: "user:adam",
    principalEmail: "adam@example.com",
    createdAt: "2026-06-18T00:00:00.000Z",
    expiresAt: "2026-07-18T00:00:00.000Z",
    vaultName: "main-vault",
    secretKey: `server-token-${name}`,
    ...overrides,
  };
}

const NOW = Date.parse("2026-06-20T00:00:00.000Z");

function makeDeps(records: DataRecord[]): ServerTokenListDeps {
  return {
    query: () => Promise.resolve(records),
    now: () => NOW,
  };
}

Deno.test("serverTokenList: yields resolving then completed with mapped tokens", async () => {
  const deps = makeDeps([
    makeRecord("adam-token", "token-main", tokenAttributes("adam-token")),
  ]);
  const events = await collect<ServerTokenListEvent>(
    serverTokenList(createLibSwampContext(), deps),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const completed = events[1] as Extract<
    ServerTokenListEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.count, 1);
  assertEquals(completed.data.tokens[0].name, "adam-token");
  assertEquals(completed.data.tokens[0].state, "active");
  assertEquals(completed.data.tokens[0].effectiveState, "active");
  assertEquals(completed.data.tokens[0].principalId, "user:adam");
  assertEquals(completed.data.tokens[0].principalEmail, "adam@example.com");
});

Deno.test("serverTokenList: overlays expired display state on stale active tokens", async () => {
  const deps = makeDeps([
    makeRecord(
      "stale",
      "token-main",
      tokenAttributes("stale", {
        state: "active",
        expiresAt: "2026-06-19T00:00:00.000Z",
        lastUsedAt: "2026-06-18T12:00:00.000Z",
      }),
    ),
  ]);
  const events = await collect<ServerTokenListEvent>(
    serverTokenList(createLibSwampContext(), deps),
  );
  const completed = events[1] as Extract<
    ServerTokenListEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.tokens[0].state, "active");
  assertEquals(completed.data.tokens[0].effectiveState, "expired");
  assertEquals(completed.data.tokens[0].lastUsedAt, "2026-06-18T12:00:00.000Z");
});

Deno.test("serverTokenList: revoked tokens keep their state regardless of expiry", async () => {
  const deps = makeDeps([
    makeRecord(
      "revoked-tok",
      "token-main",
      tokenAttributes("revoked-tok", {
        state: "revoked",
        expiresAt: "2026-06-19T00:00:00.000Z",
      }),
    ),
  ]);
  const events = await collect<ServerTokenListEvent>(
    serverTokenList(createLibSwampContext(), deps),
  );
  const completed = events[1] as Extract<
    ServerTokenListEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.tokens[0].effectiveState, "revoked");
});

Deno.test("serverTokenList: skips malformed records and sorts by name", async () => {
  const deps = makeDeps([
    makeRecord("zeta", "token-main", tokenAttributes("zeta")),
    makeRecord("broken", "token-main", { nonsense: true }),
    makeRecord("alpha", "token-main", tokenAttributes("alpha")),
  ]);
  const events = await collect<ServerTokenListEvent>(
    serverTokenList(createLibSwampContext(), deps),
  );
  const completed = events[1] as Extract<
    ServerTokenListEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.count, 2);
  assertEquals(
    completed.data.tokens.map((t) => t.name),
    ["alpha", "zeta"],
  );
});

Deno.test("serverTokenList: yields error when the query fails", async () => {
  const deps: ServerTokenListDeps = {
    query: () => Promise.reject(new Error("catalog unavailable")),
  };
  const events = await collect<ServerTokenListEvent>(
    serverTokenList(createLibSwampContext(), deps),
  );
  const error = events[1] as Extract<
    ServerTokenListEvent,
    { kind: "error" }
  >;
  assertEquals(error.kind, "error");
  assertStringIncludes(error.error.message, "catalog unavailable");
});

Deno.test("serverTokenList: empty list yields zero-count completed", async () => {
  const deps = makeDeps([]);
  const events = await collect<ServerTokenListEvent>(
    serverTokenList(createLibSwampContext(), deps),
  );
  const completed = events[1] as Extract<
    ServerTokenListEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.count, 0);
  assertEquals(completed.data.tokens, []);
});
