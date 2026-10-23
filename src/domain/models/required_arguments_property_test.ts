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
import fc from "fast-check";
import { z } from "zod";
import { requiredArgumentNames } from "./required_arguments.ts";

type FieldKind =
  | "required"
  | "optional"
  | "default"
  | "catch"
  | "preprocessToValue"
  | "throwsOnMissing";

/** Each kind's field, a value it accepts, and whether a step must supply it. */
const KINDS: Record<
  FieldKind,
  { field: () => z.ZodTypeAny; value: unknown; required: boolean }
> = {
  required: { field: () => z.string(), value: "v", required: true },
  optional: { field: () => z.string().optional(), value: "v", required: false },
  default: {
    field: () => z.string().default("d"),
    value: "v",
    required: false,
  },
  catch: {
    field: () => z.string().transform((s) => s.length).catch(0),
    value: "v",
    required: false,
  },
  preprocessToValue: {
    field: () => z.preprocess((v) => v === true || v === "true", z.boolean()),
    value: true,
    required: false,
  },
  throwsOnMissing: {
    field: () => z.preprocess((v) => (v as string).toLowerCase(), z.string()),
    value: "V",
    required: true,
  },
};

type Wrapper = "none" | "refine" | "transform" | "pipe" | "intersection";

/**
 * A key only the pipe wrapper's output side requires. Generated keys start
 * lowercase, so it never collides with one.
 */
const OUTPUT_ONLY = "OUTPUT_ONLY";

const arbFields = fc.dictionary(
  fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,7}$/),
  fc.constantFrom(...(Object.keys(KINDS) as FieldKind[])),
  { minKeys: 1, maxKeys: 6 },
);
const arbWrapper = fc.constantFrom<Wrapper>(
  "none",
  "refine",
  "transform",
  "pipe",
  "intersection",
);

function buildSchema(
  fields: Record<string, FieldKind>,
  wrapper: Wrapper,
): z.ZodTypeAny {
  const shape = (keys: string[]) =>
    Object.fromEntries(keys.map((k) => [k, KINDS[fields[k]].field()]));
  const keys = Object.keys(fields);
  switch (wrapper) {
    case "none":
      return z.object(shape(keys));
    case "refine":
      return z.object(shape(keys)).refine(() => true);
    case "transform":
      return z.object(shape(keys)).transform((o) => o);
    case "pipe":
      // The output side requires a key the transform never produces, so
      // it fails whenever the input side passes: only the input side may
      // decide what a step supplies.
      return z.object(shape(keys)).transform((o) => o).pipe(
        z.object({ [OUTPUT_ONLY]: z.string() }),
      );
    case "intersection": {
      const half = Math.ceil(keys.length / 2);
      return z.object(shape(keys.slice(0, half))).and(
        z.object(shape(keys.slice(half))),
      );
    }
  }
}

Deno.test("requiredArgumentNames: reports exactly the fields a step must supply, under any wrapper", async () => {
  await fc.assert(
    fc.asyncProperty(arbFields, arbWrapper, async (fields, wrapper) => {
      const expected = Object.keys(fields)
        .filter((k) => KINDS[fields[k]].required)
        .sort();
      const actual = (await requiredArgumentNames(buildSchema(fields, wrapper)))
        .sort();
      assertEquals(actual, expected);
    }),
  );
});

Deno.test("requiredArgumentNames: agrees with the parser when one key is left out of a valid input", async () => {
  await fc.assert(
    fc.asyncProperty(arbFields, arbWrapper, async (fields, wrapper) => {
      const schema = buildSchema(fields, wrapper);
      const reported = new Set(await requiredArgumentNames(schema));
      const valid = Object.fromEntries(
        Object.keys(fields).map((k) => [k, KINDS[fields[k]].value]),
      );
      for (const key of Object.keys(fields)) {
        const { [key]: _omitted, ...rest } = valid;
        let failsAtKey: boolean;
        try {
          const result = await schema.safeParseAsync(rest);
          failsAtKey = !result.success &&
            result.error.issues.some((i) => i.path[0] === key);
        } catch {
          failsAtKey = true;
        }
        assertEquals(reported.has(key), failsAtKey, key);
      }
    }),
  );
});
