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

import { assertEquals, assertExists } from "@std/assert";
import { serializeEvent, serializeSwampError } from "./serializer.ts";
import type { SwampError } from "../libswamp/mod.ts";

// ── serializeSwampError ─────────────────────────────────────────────────

Deno.test("serializeSwampError - basic error with code and message", () => {
  const err: SwampError = {
    code: "not_found",
    message: "Model not found",
  };
  const result = serializeSwampError(err);
  assertEquals(result, { code: "not_found", message: "Model not found" });
});

Deno.test("serializeSwampError - includes details when present", () => {
  const err: SwampError = {
    code: "validation_error",
    message: "Invalid inputs",
    details: { field: "name", reason: "required" },
  };
  const result = serializeSwampError(err);
  assertEquals(result, {
    code: "validation_error",
    message: "Invalid inputs",
    details: { field: "name", reason: "required" },
  });
});

Deno.test("serializeSwampError - omits details when undefined", () => {
  const err: SwampError = {
    code: "cancelled",
    message: "Operation cancelled",
    details: undefined,
  };
  const result = serializeSwampError(err);
  assertEquals(result, { code: "cancelled", message: "Operation cancelled" });
  assertEquals("details" in result, false);
});

Deno.test("serializeSwampError - does not include cause (non-serializable)", () => {
  const err: SwampError = {
    code: "network",
    message: "Connection refused",
    cause: new Error("ECONNREFUSED"),
  };
  const result = serializeSwampError(err);
  assertEquals(result, { code: "network", message: "Connection refused" });
  assertEquals("cause" in result, false);
});

// ── serializeEvent with error kind ──────────────────────────────────────

Deno.test("serializeEvent - error event serializes the SwampError", () => {
  const swampError: SwampError = {
    code: "not_authenticated",
    message: "Not authenticated",
  };
  const result = serializeEvent({ kind: "error", error: swampError });
  assertEquals(result, {
    kind: "error",
    error: { code: "not_authenticated", message: "Not authenticated" },
  });
});

Deno.test("serializeEvent - error event with details", () => {
  const swampError: SwampError = {
    code: "validation_error",
    message: "Bad input",
    details: { missing: ["name"] },
  };
  const result = serializeEvent({ kind: "error", error: swampError });
  assertEquals(result, {
    kind: "error",
    error: {
      code: "validation_error",
      message: "Bad input",
      details: { missing: ["name"] },
    },
  });
});

// ── serializeEvent with non-error kinds (jsonSafeClone) ─────────────────

Deno.test("serializeEvent - simple event passes through", () => {
  const event = { kind: "started", runId: "abc-123", workflowName: "deploy" };
  const result = serializeEvent(event);
  assertEquals(result, {
    kind: "started",
    runId: "abc-123",
    workflowName: "deploy",
  });
});

Deno.test("serializeEvent - preserves null and undefined values", () => {
  const event = { kind: "test", a: null, b: undefined };
  const result = serializeEvent(event);
  assertEquals((result as Record<string, unknown>).a, null);
  assertEquals((result as Record<string, unknown>).b, undefined);
});

Deno.test("serializeEvent - converts Date to ISO string", () => {
  const date = new Date("2026-03-27T12:00:00.000Z");
  const event = { kind: "test", timestamp: date };
  const result = serializeEvent(event);
  assertEquals(
    (result as Record<string, unknown>).timestamp,
    "2026-03-27T12:00:00.000Z",
  );
});

Deno.test("serializeEvent - converts Error instances to plain objects", () => {
  const error = new Error("something broke");
  const event = { kind: "test", nested: { err: error } };
  const result = serializeEvent(event);
  const nested = (result as Record<string, unknown>).nested as Record<
    string,
    unknown
  >;
  assertEquals(nested.err !== null && typeof nested.err === "object", true);
  const errObj = nested.err as Record<string, unknown>;
  assertEquals(errObj.message, "something broke");
  assertExists(errObj.stack);
});

Deno.test("serializeEvent - handles arrays", () => {
  const event = { kind: "test", items: [1, "two", null] };
  const result = serializeEvent(event);
  assertEquals((result as Record<string, unknown>).items, [1, "two", null]);
});

Deno.test("serializeEvent - handles nested objects", () => {
  const event = {
    kind: "completed",
    run: {
      id: "r1",
      status: "succeeded",
      jobs: [{ name: "build", steps: [] }],
    },
  };
  const result = serializeEvent(event);
  assertEquals(result, event);
});

Deno.test("serializeEvent - handles array with mixed types including Date and Error", () => {
  const date = new Date("2026-01-01T00:00:00.000Z");
  const error = new Error("fail");
  const event = { kind: "test", mixed: [date, error, 42, "ok"] };
  const result = serializeEvent(event);
  const mixed = (result as Record<string, unknown>).mixed as unknown[];
  assertEquals(mixed[0], "2026-01-01T00:00:00.000Z");
  assertEquals((mixed[1] as Record<string, unknown>).message, "fail");
  assertEquals(mixed[2], 42);
  assertEquals(mixed[3], "ok");
});

Deno.test("serializeEvent - primitives pass through unchanged", () => {
  const event = {
    kind: "test",
    num: 42,
    str: "hello",
    bool: true,
  };
  const result = serializeEvent(event);
  assertEquals(result, event);
});

Deno.test("serializeEvent - deep clone does not mutate original", () => {
  const inner = { value: "original" };
  const event = { kind: "test", data: inner };
  const result = serializeEvent(event);
  (
    (result as Record<string, unknown>).data as Record<string, unknown>
  ).value = "modified";
  assertEquals(inner.value, "original");
});
