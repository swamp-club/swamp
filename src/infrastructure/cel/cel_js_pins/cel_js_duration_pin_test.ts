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

// Pins for the cel-js duration internals that cel_evaluator.ts relies on when
// it replaces Duration's addDuration and subtractDuration (swamp-club#3714).
// Each holds whether or not that file has been loaded in this process.

import { assertEquals, assertStrictEquals } from "@std/assert";
import { dynEnvironment, pin } from "./cel_js_pin_test_helpers.ts";

interface Duration {
  readonly seconds: bigint;
  readonly nanos: number;
}

type DurationConstructor = new (seconds: bigint, nanos: number) => Duration;

const env = dynEnvironment();
const DurationType = (env.evaluate("duration('0s')") as object)
  .constructor as DurationConstructor;

function fields(duration: unknown): [bigint, number] {
  const { seconds, nanos } = duration as Duration;
  return [seconds, nanos];
}

Deno.test(
  pin("Duration's + and - call its addDuration and subtractDuration methods"),
  () => {
    assertEquals(typeof DurationType.prototype.addDuration, "function");
    assertEquals(typeof DurationType.prototype.subtractDuration, "function");
    const prototype = DurationType.prototype as Record<string, unknown>;
    const original = {
      addDuration: prototype.addDuration,
      subtractDuration: prototype.subtractDuration,
    };
    try {
      prototype.addDuration = () => new DurationType(7n, 0);
      prototype.subtractDuration = () => new DurationType(8n, 0);
      assertEquals(fields(env.evaluate("duration('1s') + duration('1s')")), [
        7n,
        0,
      ]);
      assertEquals(fields(env.evaluate("duration('1s') - duration('1s')")), [
        8n,
        0,
      ]);
    } finally {
      Object.assign(prototype, original);
    }
  },
);

Deno.test(
  pin("the Duration constructor stores seconds and nanos as given"),
  () => {
    assertEquals(fields(new DurationType(-1n, -500_000_000)), [
      -1n,
      -500_000_000,
    ]);
    assertEquals(fields(new DurationType(-2n, 500_000_000)), [
      -2n,
      500_000_000,
    ]);
  },
);

Deno.test(
  pin("a parsed negative duration keeps seconds and nanos at one sign"),
  () => {
    assertEquals(fields(env.evaluate("duration('-1.5s')")), [
      -1n,
      -500_000_000,
    ]);
    assertEquals(fields(env.evaluate("duration('-1ns')")), [0n, -1]);
    assertEquals(fields(env.evaluate("duration('1.5s')")), [1n, 500_000_000]);
  },
);

Deno.test(
  pin("a negative timestamp difference keeps seconds and nanos at one sign"),
  () => {
    assertEquals(
      fields(
        env.evaluate(
          "timestamp('2026-01-01T00:00:00Z') - timestamp('2026-01-01T00:00:01.5Z')",
        ),
      ),
      [-1n, -500_000_000],
    );
  },
);

Deno.test(pin("duration == compares the stored fields, not the total"), () => {
  const sameTotal = {
    a: new DurationType(-1n, -500_000_000),
    b: new DurationType(-2n, 500_000_000),
  };
  assertStrictEquals(env.evaluate("a == b", sameTotal), false);
  assertStrictEquals(
    env.evaluate("a == a", { a: new DurationType(-1n, -500_000_000) }),
    true,
  );
});
