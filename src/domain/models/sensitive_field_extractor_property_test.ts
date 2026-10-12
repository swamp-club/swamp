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
import {
  extractSensitiveFieldValues,
  findLiteralSensitiveGlobalArgs,
  redactSensitiveValues,
} from "./sensitive_field_extractor.ts";

const VAULT_REF = "${{ vault.get('my-vault', 'k') }}";

type Layer = "object" | "array" | "record" | "optional" | "union";

/**
 * Wraps a schema and a value holding `leaf` in the given container layers,
 * innermost first, and returns both with the path the leaf ends up at.
 */
function nest(layers: Layer[], leaf: string) {
  let schema: z.ZodTypeAny = z.string().meta({ sensitive: true });
  let value: unknown = leaf;
  let path = "";
  for (const layer of layers) {
    if (layer === "object") {
      schema = z.object({ f: schema, other: z.string().optional() });
      value = { f: value };
      path = path.startsWith("[") ? `f${path}` : path ? `f.${path}` : "f";
    } else if (layer === "record") {
      schema = z.record(z.string(), schema);
      value = { k: value };
      path = path.startsWith("[") ? `k${path}` : path ? `k.${path}` : "k";
    } else if (layer === "array") {
      schema = z.array(schema);
      value = [value];
      path = path.startsWith("[") ? `[0]${path}` : path ? `[0].${path}` : "[0]";
    } else if (layer === "optional") {
      schema = schema.optional();
    } else {
      schema = z.union([z.number(), schema]);
    }
  }
  return {
    schema: z.object({ root: schema }),
    args: { root: value },
    path: path.startsWith("[") ? `root${path}` : path ? `root.${path}` : "root",
  };
}

const arbLayers = fc.array(
  fc.constantFrom<Layer>("object", "array", "record", "optional", "union"),
  { maxLength: 6 },
);

const arbLiteral = fc.string({ minLength: 1 }).filter((s) =>
  s.trim() !== "" && !s.includes("${{")
);

Deno.test("findLiteralSensitiveGlobalArgs: a literal in a sensitive field is flagged at any nesting", () => {
  fc.assert(
    fc.property(arbLayers, arbLiteral, (layers, literal) => {
      const { schema, args, path } = nest(layers, literal);
      assertEquals(findLiteralSensitiveGlobalArgs(schema, args), [path]);
    }),
  );
});

Deno.test("findLiteralSensitiveGlobalArgs: a vault.get expression in a sensitive field is accepted at any nesting", () => {
  fc.assert(
    fc.property(arbLayers, (layers) => {
      const { schema, args } = nest(layers, VAULT_REF);
      assertEquals(findLiteralSensitiveGlobalArgs(schema, args), []);
    }),
  );
});

Deno.test("extractSensitiveFieldValues and redactSensitiveValues: a value the guard reaches is registered and masked", () => {
  fc.assert(
    fc.property(arbLayers, arbLiteral, (layers, literal) => {
      const { schema, args } = nest(layers, `secret:${literal}`);
      assertEquals(extractSensitiveFieldValues(schema, args), [
        `secret:${literal}`,
      ]);
      const redacted = redactSensitiveValues(schema, args);
      assertEquals(
        JSON.stringify(redacted).includes(JSON.stringify(`secret:${literal}`)),
        false,
      );
      assertEquals(JSON.stringify(redacted).includes('"***"'), true);
    }),
  );
});
