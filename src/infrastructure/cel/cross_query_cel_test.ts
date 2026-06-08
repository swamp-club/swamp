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

import { assertEquals, assertRejects } from "@std/assert";
import { getLogger } from "@logtape/logtape";
import { z } from "zod";
import {
  type CreekDefinition,
  defineCreekMethod,
} from "../../domain/creeks/creek.ts";
import { CreekRegistry } from "../../domain/creeks/creek_registry.ts";
import { createExtensionCelEnvironment } from "./cel_evaluator.ts";
import { registerCrossQueryFunctions } from "./cross_query_cel.ts";

function buildRegistry(definition: CreekDefinition): CreekRegistry {
  const registry = new CreekRegistry();
  registry.register(definition);
  return registry;
}

function noopSwampDataQuery(): Promise<unknown[]> {
  return Promise.resolve([]);
}

const baseDeps = {
  signal: new AbortController().signal,
  logger: getLogger(["test", "cross-query"]),
  swampDataQuery: noopSwampDataQuery,
};

Deno.test("creek() CEL function: dispatches to registered creek method", async () => {
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

  const env = createExtensionCelEnvironment();
  registerCrossQueryFunctions(env, { ...baseDeps, registry });

  const result = await env.evaluate(
    'creek("@me/test", "echo", {"value": "hi"})',
    {},
  );
  assertEquals(result, "hi");
});

Deno.test("creek() CEL function: 2-arg form passes empty args", async () => {
  const registry = buildRegistry({
    type: "@me/test",
    version: "2026.06.01.1",
    methods: {
      ping: defineCreekMethod({
        description: "Ping",
        arguments: z.object({}),
        execute: () => Promise.resolve("pong"),
      }),
    },
  });

  const env = createExtensionCelEnvironment();
  registerCrossQueryFunctions(env, { ...baseDeps, registry });

  const result = await env.evaluate('creek("@me/test", "ping")', {});
  assertEquals(result, "pong");
});

Deno.test("creek() CEL function: result supports property access in CEL", async () => {
  const registry = buildRegistry({
    type: "@me/jira",
    version: "2026.06.01.1",
    methods: {
      issue: defineCreekMethod({
        description: "Fetch issue",
        arguments: z.object({ key: z.string() }),
        execute: (args) =>
          Promise.resolve({ key: args.key, status: "open", priority: 1 }),
      }),
    },
  });

  const env = createExtensionCelEnvironment();
  registerCrossQueryFunctions(env, { ...baseDeps, registry });

  const result = await env.evaluate(
    'creek("@me/jira", "issue", {"key": "FOO-1"}).status == "open"',
    {},
  );
  assertEquals(result, true);
});

Deno.test("creek() CEL function: memoizes same (type, method, args) within a query", async () => {
  let calls = 0;
  const registry = buildRegistry({
    type: "@me/test",
    version: "2026.06.01.1",
    methods: {
      get: defineCreekMethod({
        description: "Get",
        arguments: z.object({ id: z.string() }),
        execute: (args) => {
          calls++;
          return Promise.resolve(args.id);
        },
      }),
    },
  });

  const env = createExtensionCelEnvironment();
  registerCrossQueryFunctions(env, { ...baseDeps, registry });

  // 5 calls with the same args inside one expression → 1 dispatch.
  await env.evaluate(
    [
      'creek("@me/test", "get", {"id": "x"})',
      'creek("@me/test", "get", {"id": "x"})',
      'creek("@me/test", "get", {"id": "x"})',
      'creek("@me/test", "get", {"id": "x"})',
      'creek("@me/test", "get", {"id": "x"})',
    ].join(" == "),
    {},
  );
  assertEquals(calls, 1);
});

Deno.test("creek() CEL function: unknown method throws via promise rejection", async () => {
  const registry = buildRegistry({
    type: "@me/test",
    version: "2026.06.01.1",
    methods: {
      a: defineCreekMethod({
        description: "",
        arguments: z.object({}),
        execute: () => Promise.resolve(null),
      }),
    },
  });

  const env = createExtensionCelEnvironment();
  registerCrossQueryFunctions(env, { ...baseDeps, registry });

  await assertRejects(
    async () => {
      await env.evaluate('creek("@me/test", "no-such-method")', {});
    },
    Error,
    "Unknown method",
  );
});

Deno.test("swamp.data() CEL function: calls the injected query callback", async () => {
  const registry = new CreekRegistry();
  const calls: Array<{ pred: string; select?: string }> = [];

  const env = createExtensionCelEnvironment();
  const { swampNamespace } = registerCrossQueryFunctions(env, {
    ...baseDeps,
    registry,
    swampDataQuery: (pred, select) => {
      calls.push({ pred, select });
      return Promise.resolve([{ id: 1 }, { id: 2 }]);
    },
  });

  const result = await env.evaluate(
    "swamp.data('dataType == \"resource\"').size()",
    { swamp: swampNamespace },
  );
  assertEquals(result, 2n);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].pred, 'dataType == "resource"');
});

Deno.test("swamp.data() CEL function: enforces recursion depth limit", async () => {
  const registry = new CreekRegistry();
  const env = createExtensionCelEnvironment();
  const { swampNamespace } = registerCrossQueryFunctions(env, {
    ...baseDeps,
    registry,
    swampDataQuery: () => Promise.resolve([]),
    recursionDepth: 3,
    maxRecursionDepth: 3,
  });

  await assertRejects(
    async () => {
      await env.evaluate("swamp.data('whatever')", { swamp: swampNamespace });
    },
    Error,
    "recursion depth limit",
  );
});
