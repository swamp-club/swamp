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
import { creekDescribe } from "./describe.ts";

const fixture: CreekDefinition = {
  type: "@me/fixture",
  version: "2026.06.01.1",
  description: "Test creek",
  methods: {
    one: defineCreekMethod({
      description: "First",
      arguments: z.object({ a: z.string() }),
      returns: z.string(),
      execute: () => Promise.resolve(""),
    }),
    two: defineCreekMethod({
      description: "Second",
      arguments: z.object({}),
      execute: () => Promise.resolve(null),
    }),
  },
};

Deno.test("creekDescribe: emits resolving then completed with methods + JSON schemas", async () => {
  const ctx = createLibSwampContext();
  const events = [];
  for await (
    const event of creekDescribe(
      ctx,
      { getCreek: () => Promise.resolve(fixture) },
      "@me/fixture",
    )
  ) {
    events.push(event);
  }

  assertEquals(events[0]?.kind, "resolving");
  const completed = events.at(-1);
  assert(completed?.kind === "completed");
  assertEquals(completed.data.type, "@me/fixture");
  assertEquals(completed.data.version, "2026.06.01.1");
  assertEquals(completed.data.methods.length, 2);
  assertEquals(completed.data.methods[0].name, "one");
  assertEquals(completed.data.methods[1].name, "two");
  assertEquals(completed.data.methods[0].returns !== undefined, true);
  assertEquals(completed.data.methods[1].returns, undefined);
});

Deno.test("creekDescribe: emits error when creek is not registered", async () => {
  const ctx = createLibSwampContext();
  const events = [];
  for await (
    const event of creekDescribe(
      ctx,
      { getCreek: () => Promise.resolve(undefined) },
      "@me/missing",
    )
  ) {
    events.push(event);
  }

  const last = events.at(-1);
  assert(last?.kind === "error");
  assertEquals(last.error.code, "not_found");
});
