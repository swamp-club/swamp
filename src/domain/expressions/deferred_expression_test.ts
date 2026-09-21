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
import {
  captureDeferredBindings,
  DeferredExpressionSchema,
} from "./deferred_expression.ts";

Deno.test("captureDeferredBindings: drops __proto__ keys so bindings survive the schema", () => {
  const inputs: Record<string, unknown> = JSON.parse(
    '{"__proto__": {"polluted": true}, "kept": 1}',
  );

  const bindings = captureDeferredBindings({ model: {}, env: {}, inputs });

  assertEquals(Object.getOwnPropertyNames(bindings.inputs), ["kept"]);

  const record = {
    id: crypto.randomUUID(),
    expression: "${{ inputs.kept }}",
    bindings,
  };
  assertEquals(
    DeferredExpressionSchema.parse(JSON.parse(JSON.stringify(record))),
    record,
  );
  assertEquals(({} as Record<string, unknown>).polluted, undefined);
});
