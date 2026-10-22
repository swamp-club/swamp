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
import { Definition } from "../definitions/definition.ts";
import { RunSensitiveValues } from "../secrets/mod.ts";
import {
  type ArgumentSchemas,
  findPlaintextSensitiveArguments,
  persistEvaluatedDefinition,
  SENSITIVE_ARGUMENT_MASK,
} from "./persisted_evaluation.ts";

const VAULT_REFERENCE = "${{ vault.get('v', 'k') }}";

/**
 * One argument: its name, whether its schema marks it sensitive, and a value
 * that is literal text, a vault reference, or a number. Only a literal under
 * a sensitive schema is masked.
 */
const arbField = fc.record({
  name: fc.stringMatching(/^[a-z][a-z0-9]{0,5}$/),
  sensitive: fc.boolean(),
  value: fc.oneof(
    fc.stringMatching(/^[A-Z]{3,8}$/),
    fc.constant(VAULT_REFERENCE),
    fc.integer({ min: 100, max: 999 }),
  ),
});
type Field = { name: string; sensitive: boolean; value: string | number };
const arbFields = fc.uniqueArray(arbField, {
  minLength: 1,
  maxLength: 5,
  selector: (field) => field.name,
});

function schemaOf(fields: readonly Field[]): z.ZodTypeAny {
  return z.object(
    Object.fromEntries(fields.map((field) => {
      const base = typeof field.value === "number" ? z.number() : z.string();
      return [
        field.name,
        base.meta(field.sensitive ? { sensitive: true } : {}).optional(),
      ];
    })),
  );
}

function argsOf(fields: readonly Field[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field.name, field.value]));
}

function masked(field: Field): boolean {
  return field.sensitive && field.value !== VAULT_REFERENCE;
}

Deno.test("persistEvaluatedDefinition: no literal survives under a sensitive argument, nothing else changes, the replay predicate agrees, and persisting again changes nothing", () => {
  fc.assert(
    fc.property(arbFields, arbFields, (globals, methodArgs) => {
      const schemas: ArgumentSchemas = {
        globalArguments: schemaOf(globals),
        methods: { run: { arguments: schemaOf(methodArgs) } },
      };
      const executed = Definition.create({
        name: "random",
        globalArguments: argsOf(globals),
        methods: { run: { arguments: argsOf(methodArgs) } },
      });
      const values = new RunSensitiveValues();
      const persisted = persistEvaluatedDefinition(
        executed,
        [],
        executed,
        values,
        schemas,
      );
      const data = persisted.definition.toData();
      const writtenArgs = persisted.definition.getMethodArguments("run");
      for (const field of globals) {
        assertEquals(
          data.globalArguments?.[field.name],
          masked(field) ? SENSITIVE_ARGUMENT_MASK : field.value,
        );
      }
      for (const field of methodArgs) {
        assertEquals(
          writtenArgs[field.name],
          masked(field) ? SENSITIVE_ARGUMENT_MASK : field.value,
        );
      }
      const expected = [
        ...globals.filter(masked).map((f) => `globalArguments.${f.name}`),
        ...methodArgs.filter(masked).map((f) =>
          `methods.run.arguments.${f.name}`
        ),
      ].sort();
      assertEquals([...persisted.maskedArguments].sort(), expected);
      assertEquals(persisted.maskedPaths.length, expected.length);
      assertEquals(
        [...findPlaintextSensitiveArguments(schemas, data, [])].sort(),
        expected,
      );
      assertEquals(
        findPlaintextSensitiveArguments(schemas, data, [], { allowMask: true }),
        [],
      );
      const again = persistEvaluatedDefinition(
        persisted.definition,
        [],
        persisted.definition,
        values,
        schemas,
      );
      assertEquals(again.definition.toData(), data);
    }),
  );
});
