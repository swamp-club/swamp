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
import {
  exampleConfigFor,
  explainVaultConfigIssues,
  findMissingRequiredFields,
  sanitizeFieldText,
  type VaultConfigField,
} from "./vault_config_fields.ts";

const arbFieldName = fc.stringMatching(/^[a-z][a-z0-9_]{0,15}$/);

/** Distinct field names with random required flags, in a fixed order. */
const arbFields: fc.Arbitrary<VaultConfigField[]> = fc
  .uniqueArray(arbFieldName, { minLength: 0, maxLength: 8 })
  .chain((names) =>
    fc.tuple(
      ...names.map((name) =>
        fc.boolean().map((required): VaultConfigField => ({
          name,
          type: "string",
          required,
        }))
      ),
    )
  );

/** A config that sets some of the fields (and sometimes unrelated keys). */
function arbConfigFor(
  fields: VaultConfigField[],
): fc.Arbitrary<Record<string, unknown>> {
  return fc.tuple(
    fc.subarray(fields.map((f) => f.name)),
    fc.array(arbFieldName, { maxLength: 2 }),
  ).map(([set, extra]) =>
    Object.fromEntries([...set, ...extra].map((name) => [name, "value"]))
  );
}

Deno.test("findMissingRequiredFields: exactly the required fields absent from the config, in field order", () => {
  fc.assert(
    fc.property(
      arbFields.chain((fields) =>
        fc.tuple(fc.constant(fields), arbConfigFor(fields))
      ),
      ([fields, config]) => {
        const missing = findMissingRequiredFields(fields, config);
        assertEquals(
          missing,
          fields.filter((f) => f.required && !(f.name in config)),
        );
      },
    ),
  );
});

Deno.test("exampleConfigFor: parses as JSON with one placeholder key per missing field", () => {
  fc.assert(
    fc.property(arbFields, (fields) => {
      const example = JSON.parse(exampleConfigFor(fields)) as Record<
        string,
        unknown
      >;
      assertEquals(Object.keys(example), fields.map((f) => f.name));
      for (const f of fields) assertEquals(example[f.name], `<${f.name}>`);
    }),
  );
});

Deno.test("sanitizeFieldText: never yields control characters and respects the cap", () => {
  fc.assert(
    fc.property(
      fc.string({ unit: "binary", maxLength: 300 }),
      fc.integer({ min: 1, max: 200 }),
      (text, max) => {
        const cleaned = sanitizeFieldText(text, max);
        // deno-lint-ignore no-control-regex
        assertEquals(/[\x00-\x1f\x7f-\x9f]/.test(cleaned), false);
        assertEquals(cleaned.length <= max, true);
        assertEquals(cleaned, cleaned.trim());
      },
    ),
  );
});

Deno.test("explainVaultConfigIssues: every missing field named in the issues appears in the message and the example", () => {
  fc.assert(
    fc.property(arbFields, (fields) => {
      const required = fields.filter((f) => f.required);
      let example = "";
      const message = explainVaultConfigIssues({
        vaultType: "@acme/vault",
        config: {},
        issues: required.map((f) => ({
          code: "invalid_type",
          path: [f.name],
          message: "Invalid input: expected string, received undefined",
          expected: "string",
        })),
        fields,
        rerunHint: (ex) => {
          example = ex;
          return "";
        },
      });
      for (const f of required) {
        assertEquals(message.includes(`'${f.name}'`), true);
        assertEquals(
          (JSON.parse(example) as Record<string, unknown>)[f.name],
          `<${f.name}>`,
        );
      }
    }),
  );
});
