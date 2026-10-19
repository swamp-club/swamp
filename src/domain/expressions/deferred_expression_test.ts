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
import { captureDeferredBindings } from "./deferred_expression.ts";
import type { ExpressionContext } from "./model_resolver.ts";

Deno.test("captureDeferredBindings: omits two- and three-segment paths and leaves the context untouched", () => {
  const context = {
    inputs: { region: "us-east", token: "minted" },
    self: { item: "a", other: "b" },
    run: { id: "r1", inputs: { region: "us-east", token: "minted" } },
    workflowRunId: "r1",
    steps: {},
  } as unknown as ExpressionContext;
  const bindings = captureDeferredBindings(context, [
    "inputs.token",
    "run.inputs.token",
    "self.item",
    "run.missing.key",
  ]);
  assertEquals(bindings.inputs, { region: "us-east" });
  assertEquals(bindings.self as unknown, { other: "b" });
  assertEquals(bindings.run as unknown, {
    id: "r1",
    inputs: { region: "us-east" },
  });
  assertEquals(
    (context.run as { inputs: Record<string, unknown> }).inputs.token,
    "minted",
  );
});
