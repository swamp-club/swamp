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

import { assert, assertEquals, assertThrows } from "@std/assert";
import { z } from "zod";
import {
  argumentParseContext,
  boundedRecord,
  formatUntrustedIssues,
  isBoundedRecordGuard,
  parseUntrusted,
  parseUntrustedOrThrow,
  setProcessArgumentParsePolicy,
  stopsAtFirstFailingArgument,
} from "./untrusted_parse.ts";

const N = 100_000;

function issueCount(result: { success: boolean; error?: z.ZodError }): number {
  return result.success ? 0 : result.error!.issues.length;
}

function manyEntries(value: unknown): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  for (let i = 0; i < N; i++) entries[`k${i}`] = value;
  return entries;
}

Deno.test("parseUntrusted: an array of failing elements gives one issue", () => {
  const schema = z.object({ names: z.array(z.string()) });
  const input = { names: Array(N).fill(0) };
  assertEquals(issueCount(schema.safeParse(input)), N);
  assertEquals(issueCount(parseUntrusted(schema, input)), 1);
});

Deno.test("parseUntrusted: an object with failing keys gives one issue", () => {
  const shape: Record<string, z.ZodString> = {};
  for (let i = 0; i < 1000; i++) shape[`k${i}`] = z.string();
  const schema = z.object(shape);
  const input = Object.fromEntries(Object.keys(shape).map((k) => [k, 0]));
  assertEquals(issueCount(parseUntrusted(schema, input)), 1);
});

Deno.test("parseUntrusted: a union holding a failing array gives one issue", () => {
  const schema = z.discriminatedUnion("type", [
    z.object({
      type: z.literal("run"),
      names: z.union([z.string(), z.array(z.string())]),
    }),
    z.object({ type: z.literal("other") }),
  ]);
  const result = parseUntrusted(schema, {
    type: "run",
    names: Array(N).fill(0),
  });
  assertEquals(issueCount(result), 1);
});

Deno.test("parseUntrusted: a bare record still gives one issue per entry", () => {
  // zod 4.6.7 records ignore abortEarly; boundedRecord exists because of it.
  // If this starts failing, zod changed and boundedRecord may be redundant.
  const schema = z.record(z.string(), z.string());
  assertEquals(issueCount(parseUntrusted(schema, manyEntries(0))), N);
});

Deno.test("parseUntrusted: valid input parses as safeParse does, defaults and transforms included", () => {
  const schema = z.object({
    name: z.string().transform((s) => s.toUpperCase()),
    count: z.number().default(3),
    tags: z.array(z.string()).optional(),
  });
  const input = { name: "a", tags: ["x"] };
  assertEquals(parseUntrusted(schema, input), schema.safeParse(input));
});

Deno.test("parseUntrustedOrThrow: returns the data or throws a ZodError", () => {
  const schema = z.object({ names: z.array(z.string()) });
  assertEquals(parseUntrustedOrThrow(schema, { names: ["a"] }), {
    names: ["a"],
  });
  const error = assertThrows(
    () => parseUntrustedOrThrow(schema, { names: Array(N).fill(0) }),
    z.ZodError,
  );
  assertEquals(error.issues.length, 1);
});

Deno.test("boundedRecord: more entries than the bound give one issue", () => {
  const schema = boundedRecord(z.string(), z.string(), 1000);
  const result = parseUntrusted(schema, manyEntries(0));
  assertEquals(issueCount(result), 1);
  assertEquals(result.error!.issues[0].message, "Too many entries (max 1000)");
});

Deno.test("boundedRecord: within the bound parses as z.record does", () => {
  const bounded = boundedRecord(z.string(), z.string(), 3);
  const plain = z.record(z.string(), z.string());
  for (const input of [{ a: "x" }, { a: 1 }, "text", null, ["a"]]) {
    const b = bounded.safeParse(input);
    const p = plain.safeParse(input);
    assertEquals(b.success, p.success);
    assertEquals(b.data, p.data);
    assertEquals(
      b.error?.issues.map((i) => [i.path, i.message]),
      p.error?.issues.map((i) => [i.path, i.message]),
    );
  }
});

Deno.test("isBoundedRecordGuard: recognises only a boundedRecord's guard", () => {
  const bounded = boundedRecord(z.string(), z.string());
  assert(isBoundedRecordGuard(bounded.in));
  assert(!isBoundedRecordGuard(bounded.out));
  assert(!isBoundedRecordGuard(z.custom(() => true)));
  assert(!isBoundedRecordGuard("not a schema"));
});

Deno.test("formatUntrustedIssues: shows at most max issues and counts the rest", () => {
  const schema = z.object({ a: z.string(), b: z.string(), c: z.string() });
  const issues = schema.safeParse({ a: 1, b: 2, c: 3 }).error!.issues;
  assertEquals(
    formatUntrustedIssues(issues, 2),
    "a: Invalid input: expected string, received number; " +
      "b: Invalid input: expected string, received number; and 1 more",
  );
  assertEquals(
    formatUntrustedIssues(issues.slice(0, 1), 10).includes("more"),
    false,
  );
});

Deno.test("argumentParseContext: trusted by default, abortEarly under untrusted", () => {
  const schema = z.object({ names: z.array(z.string()) });
  const input = { names: Array(1000).fill(0) };
  assertEquals(stopsAtFirstFailingArgument(), false);
  const trusted = schema.safeParse(input, argumentParseContext());
  assertEquals(issueCount(trusted), 1000);
  assertEquals(trusted.error!.issues[0].input, 0);

  const restore = setProcessArgumentParsePolicy("untrusted");
  try {
    assertEquals(stopsAtFirstFailingArgument(), true);
    const untrusted = schema.safeParse(input, argumentParseContext());
    assertEquals(issueCount(untrusted), 1);
    assertEquals(untrusted.error!.issues[0].input, 0);
  } finally {
    restore();
  }
  assertEquals(stopsAtFirstFailingArgument(), false);
});
