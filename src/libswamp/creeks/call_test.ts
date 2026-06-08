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

import { assert, assertEquals } from "@std/assert";
import { z } from "zod";
import { createLibSwampContext } from "../context.ts";
import {
  type CreekDefinition,
  defineCreekMethod,
} from "../../domain/creeks/creek.ts";
import { creekRegistry } from "../../domain/creeks/creek_registry.ts";
import { creekCall } from "./call.ts";

const fixture: CreekDefinition = {
  type: "@me/call-fixture",
  version: "2026.06.01.1",
  methods: {
    echo: defineCreekMethod({
      description: "Echo",
      arguments: z.object({ value: z.string() }),
      execute: (args) => Promise.resolve(args.value),
    }),
  },
};

if (!creekRegistry.has(fixture.type)) {
  creekRegistry.register(fixture);
}

Deno.test("creekCall: emits running then completed with result", async () => {
  const ctx = createLibSwampContext();
  const events = [];
  for await (
    const event of creekCall(
      ctx,
      { getCreek: () => Promise.resolve(fixture) },
      { type: fixture.type, method: "echo", args: { value: "hi" } },
    )
  ) {
    events.push(event);
  }

  assertEquals(events[0]?.kind, "running");
  const last = events.at(-1);
  assert(last?.kind === "completed");
  assertEquals(last.data.result, "hi");
});

Deno.test("creekCall: emits error for unknown creek", async () => {
  const ctx = createLibSwampContext();
  const events = [];
  for await (
    const event of creekCall(
      ctx,
      { getCreek: () => Promise.resolve(undefined) },
      { type: "@me/missing", method: "x", args: {} },
    )
  ) {
    events.push(event);
  }

  const last = events.at(-1);
  assert(last?.kind === "error");
  assertEquals(last.error.code, "not_found");
});

Deno.test("creekCall: emits error for unknown method", async () => {
  const ctx = createLibSwampContext();
  const events = [];
  for await (
    const event of creekCall(
      ctx,
      { getCreek: () => Promise.resolve(fixture) },
      { type: fixture.type, method: "no-such-method", args: {} },
    )
  ) {
    events.push(event);
  }

  const last = events.at(-1);
  assert(last?.kind === "error");
  assertEquals(last.error.code, "validation_failed");
});

Deno.test("creekCall: validation failure becomes an error event, not an exception", async () => {
  const ctx = createLibSwampContext();
  const events = [];
  for await (
    const event of creekCall(
      ctx,
      { getCreek: () => Promise.resolve(fixture) },
      { type: fixture.type, method: "echo", args: { value: 42 } },
    )
  ) {
    events.push(event);
  }

  const last = events.at(-1);
  assert(last?.kind === "error");
});
