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
  captureDeferredBindings,
  deferredExpressionReference,
  DeferredExpressionSchema,
  isDeferredExpression,
} from "./deferred_expression.ts";
import { extractExpressions } from "./expression_parser.ts";

Deno.test("DeferredExpression: durable bindings round-trip and references keep scope identity", () => {
  fc.assert(
    fc.property(
      fc.uuid(),
      fc.uuid(),
      // `__proto__` is excluded deliberately, not to dodge a failure: Zod
      // strips it when parsing a record, so the round-trip below is genuinely
      // lossy for that one key and the property as stated would be false. The
      // behaviour is asserted on its own in the test beneath this one, where
      // it reads as a decision rather than a gap. Fast-check found this at a
      // rate that made it an intermittent gate failure — roughly one seed in
      // a few hundred — so leaving it unhandled blocked unrelated work.
      fc.dictionary(
        fc.string().filter((key) => key !== "__proto__"),
        fc.jsonValue(),
      ),
      (id, otherId, inputs) => {
        const bindings = captureDeferredBindings({
          model: {},
          env: { SECRET: "not-persisted" },
          inputs,
        });
        const record = {
          id,
          expression: "${{ env.HOME + inputs.suffix }}",
          bindings,
        };
        assertEquals(
          DeferredExpressionSchema.parse(JSON.parse(JSON.stringify(record))),
          record,
        );
        assertEquals(Object.hasOwn(bindings, "env"), false);
        assertEquals(Object.hasOwn(bindings, "model"), false);
        assertEquals(
          isDeferredExpression(
            extractExpressions(deferredExpressionReference(id))[0]
              .celExpression,
          ),
          true,
        );
        assertEquals(
          deferredExpressionReference(id) ===
            deferredExpressionReference(otherId),
          id === otherId,
        );
        inputs.changedAfterCapture = true;
        assertEquals(
          Object.hasOwn(bindings.inputs!, "changedAfterCapture"),
          false,
        );
      },
    ),
  );
});

Deno.test("DeferredExpression: a __proto__ binding is dropped by the schema, not carried", () => {
  // Zod strips `__proto__` when parsing a record — a prototype-pollution
  // defence, and the right call. The consequence is worth stating rather than
  // leaving for a random seed to rediscover: a workflow input named
  // `__proto__` does not survive into a nested workflow's deferred bindings.
  // Every other key does, including ones that merely look dangerous.
  const bindings = captureDeferredBindings({
    model: {},
    env: {},
    inputs: JSON.parse('{"__proto__": 1, "constructor": 2, "ordinary": 3}'),
  });

  const parsed = DeferredExpressionSchema.parse(
    JSON.parse(JSON.stringify({
      id: "00000000-0000-4000-8000-000000000000",
      expression: "${{ inputs.ordinary }}",
      bindings,
    })),
  );

  const inputs = parsed.bindings.inputs!;
  const own = (key: string) =>
    Object.getOwnPropertyDescriptor(inputs, key)?.value;

  assertEquals(Object.hasOwn(inputs, "__proto__"), false);
  // Read through a descriptor: `inputs.constructor` would resolve up the
  // prototype chain and report a function even when the own key is gone.
  assertEquals(own("constructor"), 2);
  assertEquals(own("ordinary"), 3);
});
