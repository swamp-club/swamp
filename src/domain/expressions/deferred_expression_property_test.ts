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
import fc from "fast-check";
import {
  captureDeferredBindings,
  deferredExpressionReference,
  DeferredExpressionSchema,
  isDeferredExpression,
} from "./deferred_expression.ts";
import { extractExpressions } from "./expression_parser.ts";

Deno.test("DeferredExpression: __proto__ binding key survives round-trip", () => {
  const inputs = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(inputs, "__proto__", {
    value: { nested: "value" },
    writable: true,
    enumerable: true,
    configurable: true,
  });

  const bindings = captureDeferredBindings({
    model: {},
    env: {},
    inputs,
  });

  assertStrictEquals(
    Object.hasOwn(bindings.inputs!, "__proto__"),
    true,
    "captureDeferredBindings must preserve __proto__ as an own property",
  );

  const record = {
    id: "a0000000-0000-4000-8000-000000000001",
    expression: "${{ env.HOME + inputs.suffix }}",
    bindings,
  };

  const roundTripped = DeferredExpressionSchema.parse(
    JSON.parse(JSON.stringify(record)),
  );

  assertStrictEquals(
    Object.hasOwn(roundTripped.bindings.inputs!, "__proto__"),
    true,
    "__proto__ binding must survive Zod schema round-trip",
  );
  assertEquals(
    roundTripped.bindings.inputs!["__proto__"],
    { nested: "value" },
  );
});

Deno.test("DeferredExpression: durable bindings round-trip and references keep scope identity", () => {
  fc.assert(
    fc.property(
      fc.uuid(),
      fc.uuid(),
      fc.dictionary(fc.string(), fc.jsonValue()),
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
