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

import { assertEquals, assertStrictEquals } from "@std/assert";
import { Environment, Optional } from "cel-js";
import { coerceBigInts } from "./cel_coercion.ts";

const env = new Environment({ unlistedVariablesAreDyn: true });

Deno.test("coerceBigInts: ints, uints, timestamps, durations, bytes and optionals coerce as CEL's JSON mapping says", () => {
  assertEquals(coerceBigInts(7n), 7);
  assertEquals(coerceBigInts(2n ** 60n), 2n ** 60n);
  assertEquals(coerceBigInts(env.evaluate("3u", {})), 3);
  assertEquals(
    coerceBigInts(env.evaluate("timestamp('2026-01-02T03:04:05Z')", {})),
    "2026-01-02T03:04:05.000Z",
  );
  assertEquals(coerceBigInts(env.evaluate("duration('90s')", {})), "90s");
  assertEquals(coerceBigInts(env.evaluate("duration('-1.5s')", {})), "-1.5s");
  assertEquals(coerceBigInts(env.evaluate("b'hi'", {})), "aGk=");
  assertEquals(coerceBigInts(Optional.of(1n)), 1);
  assertEquals(coerceBigInts(Optional.none()), null);
  assertEquals(coerceBigInts(null), null);
  assertEquals(coerceBigInts("text"), "text");
});

Deno.test("coerceBigInts: lists and maps rebuild plain with every leaf coerced, and a map keeps no prototype", () => {
  const result = coerceBigInts({ a: [1n, { b: 2n }], c: "x" }) as Record<
    string,
    unknown
  >;
  assertEquals(result, { a: [1, { b: 2 }], c: "x" });
  assertEquals(Object.getPrototypeOf(result), null);
});

Deno.test("coerceBigInts: a kept object returns by identity at any depth while its siblings coerce, and keep sees no primitive", () => {
  class Opaque {
    readonly n = 1n;
  }
  const kept = new Opaque();
  const seen: unknown[] = [];
  const keep = (value: object): boolean => {
    seen.push(value);
    return value instanceof Opaque;
  };
  const result = coerceBigInts(
    { top: kept, list: [kept, 3n], nested: { deep: kept, n: 4n } },
    keep,
  ) as Record<string, unknown>;
  assertStrictEquals(result.top, kept);
  assertStrictEquals((result.list as unknown[])[0], kept);
  assertEquals((result.list as unknown[])[1], 3);
  assertStrictEquals((result.nested as Record<string, unknown>).deep, kept);
  assertEquals((result.nested as Record<string, unknown>).n, 4);
  assertEquals(kept.n, 1n);
  assertEquals(seen.every((value) => typeof value === "object"), true);
});

Deno.test("coerceBigInts: keep is asked before any other object branch, so a kept Optional, list or Date is not unwrapped", () => {
  const optional = Optional.of(1n);
  const list = [1n];
  const date = new Date(0);
  const keepAll = () => true;
  assertStrictEquals(coerceBigInts(optional, keepAll), optional);
  assertStrictEquals(coerceBigInts(list, keepAll), list);
  assertStrictEquals(coerceBigInts(date, keepAll), date);
  assertEquals(coerceBigInts(5n, keepAll), 5);
});

Deno.test("coerceBigInts: without keep the result equals the result with a keep that keeps nothing", () => {
  const value = {
    a: [1n, Optional.of(2n), env.evaluate("duration('1s')", {})],
    b: { c: new Date(0), d: env.evaluate("2u", {}) },
  };
  assertEquals(coerceBigInts(value), coerceBigInts(value, () => false));
  assertEquals(coerceBigInts(value), {
    a: [1, 2, "1s"],
    b: { c: "1970-01-01T00:00:00.000Z", d: 2 },
  });
});
