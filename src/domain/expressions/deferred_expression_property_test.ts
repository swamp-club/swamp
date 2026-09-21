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
      // A binding key of "__proto__" cannot survive the round-trip: zod
      // rebuilds a parsed record by assignment, and Deno disables assignment
      // to `Object.prototype.__proto__`, so the entry is silently dropped.
      // Dropping it is the prototype-pollution-safe behaviour and not what
      // this property pins, so keep it out of the generated keys rather than
      // failing on whichever seed happens to produce it.
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
