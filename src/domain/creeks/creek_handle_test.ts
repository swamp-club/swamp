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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { getLogger } from "@logtape/logtape";
import { z } from "zod";
import {
  type CreekDefinition,
  type CreekHandle,
  type CreekMethodContext,
  defineCreekMethod,
} from "./creek.ts";
import { CreekRegistry } from "./creek_registry.ts";
import {
  createCreekHandle,
  type CreekCallCache,
  stableHash,
} from "./creek_handle.ts";

function buildContext(): CreekMethodContext {
  return {
    signal: new AbortController().signal,
    logger: getLogger(["test", "creek"]),
    extensionFile: (p) => p,
  };
}

function buildRegistry(definition: CreekDefinition): CreekRegistry {
  const registry = new CreekRegistry();
  registry.register(definition);
  return registry;
}

Deno.test("stableHash: order-insensitive for objects", () => {
  assertEquals(
    stableHash({ a: 1, b: 2 }),
    stableHash({ b: 2, a: 1 }),
  );
  assertEquals(
    stableHash({ x: { z: 1, y: 2 } }),
    stableHash({ x: { y: 2, z: 1 } }),
  );
});

Deno.test("stableHash: preserves array order", () => {
  assert(stableHash([1, 2, 3]) !== stableHash([3, 2, 1]));
});

Deno.test("createCreekHandle: dispatches via property access (CEL form)", async () => {
  let calls = 0;
  const registry = buildRegistry({
    type: "@me/test",
    version: "2026.06.01.1",
    methods: {
      echo: defineCreekMethod({
        description: "Echo",
        arguments: z.object({ value: z.string() }),
        execute: (args) => {
          calls++;
          return Promise.resolve(args.value);
        },
      }),
    },
  });
  const cache: CreekCallCache = new Map();
  const handle = createCreekHandle("@me/test", cache, registry, buildContext());

  // deno-lint-ignore no-explicit-any
  const result = await (handle as any).echo({ value: "hi" });
  assertEquals(result, "hi");
  assertEquals(calls, 1);
});

Deno.test("createCreekHandle: dispatches via .call (programmatic form)", async () => {
  const registry = buildRegistry({
    type: "@me/test",
    version: "2026.06.01.1",
    methods: {
      echo: defineCreekMethod({
        description: "Echo",
        arguments: z.object({ value: z.string() }),
        execute: (args) => Promise.resolve(args.value),
      }),
    },
  });
  const handle: CreekHandle = createCreekHandle(
    "@me/test",
    new Map(),
    registry,
    buildContext(),
  );

  const result = await handle.call("echo", { value: "hi" });
  assertEquals(result, "hi");
});

Deno.test("createCreekHandle: memoizes calls by (method, args)", async () => {
  let calls = 0;
  const registry = buildRegistry({
    type: "@me/test",
    version: "2026.06.01.1",
    methods: {
      compute: defineCreekMethod({
        description: "Compute",
        arguments: z.object({ key: z.string() }),
        execute: (args) => {
          calls++;
          return Promise.resolve(`result-${args.key}`);
        },
      }),
    },
  });
  const cache: CreekCallCache = new Map();
  const handle = createCreekHandle("@me/test", cache, registry, buildContext());

  await handle.call("compute", { key: "a" });
  await handle.call("compute", { key: "a" });
  await handle.call("compute", { key: "a" });
  assertEquals(calls, 1);

  await handle.call("compute", { key: "b" });
  assertEquals(calls, 2);
});

Deno.test("createCreekHandle: invalid arguments throw with method context", async () => {
  const registry = buildRegistry({
    type: "@me/test",
    version: "2026.06.01.1",
    methods: {
      echo: defineCreekMethod({
        description: "Echo",
        arguments: z.object({ value: z.string() }),
        execute: (args) => Promise.resolve(args.value),
      }),
    },
  });
  const handle = createCreekHandle(
    "@me/test",
    new Map(),
    registry,
    buildContext(),
  );

  await assertRejects(
    // deno-lint-ignore no-explicit-any
    () => handle.call("echo", { value: 42 as any }),
    Error,
    "Invalid arguments for @me/test.echo",
  );
});

Deno.test("createCreekHandle: unknown method names throw with available list", async () => {
  const registry = buildRegistry({
    type: "@me/test",
    version: "2026.06.01.1",
    methods: {
      a: defineCreekMethod({
        description: "",
        arguments: z.object({}),
        execute: () => Promise.resolve(null),
      }),
      b: defineCreekMethod({
        description: "",
        arguments: z.object({}),
        execute: () => Promise.resolve(null),
      }),
    },
  });
  const handle = createCreekHandle(
    "@me/test",
    new Map(),
    registry,
    buildContext(),
  );

  await assertRejects(
    () => handle.call("nope", {}),
    Error,
    'Unknown method "nope" on creek "@me/test"',
  );
});

Deno.test("createCreekHandle: strictReturns true throws on schema mismatch", async () => {
  const registry = buildRegistry({
    type: "@me/test",
    version: "2026.06.01.1",
    methods: {
      bad: defineCreekMethod({
        description: "",
        arguments: z.object({}),
        returns: z.object({ count: z.number() }),
        strictReturns: true,
        // deno-lint-ignore no-explicit-any
        execute: () => Promise.resolve({ count: "not a number" } as any),
      }),
    },
  });
  const handle = createCreekHandle(
    "@me/test",
    new Map(),
    registry,
    buildContext(),
  );

  await assertRejects(
    () => handle.call("bad", {}),
    Error,
    "not matching declared schema",
  );
});

Deno.test("createCreekHandle: bypasses 'then' so Proxy is not thenable", () => {
  const registry = buildRegistry({
    type: "@me/test",
    version: "2026.06.01.1",
    methods: {
      noop: defineCreekMethod({
        description: "",
        arguments: z.object({}),
        execute: () => Promise.resolve(null),
      }),
    },
  });
  const handle = createCreekHandle(
    "@me/test",
    new Map(),
    registry,
    buildContext(),
  );

  // deno-lint-ignore no-explicit-any
  assertEquals((handle as any).then, undefined);
});
