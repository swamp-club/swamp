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

/**
 * type-level regression test: deno check must pass under strict noImplicitAny,
 * so a regression that makes execute parameters implicitly any fails here
 */

import { assertEquals } from "@std/assert";
import { z } from "zod";
import { defineBehavior, defineModel, type ModelDefinition } from "./mod.ts";

const GlobalArgsSchema = z.object({
  region: z.string(),
  tags: z.record(z.string(), z.string()).default({}),
});

const RunArgsSchema = z.object({ bucket: z.string() });

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

type Equals<A, B> = A extends B ? (B extends A ? true : false) : false;

function assertType<T extends true>(_value?: T): void {
  // no-op — purely a type-level assertion
}

// satisfies path: execute params get concrete types and context.globalArgs
// narrows to the inferred shape; args stays any and authors parse it with the
// method schema

const satisfiesModel = {
  type: "@swamp-test/satisfies-model",
  version: "2026.04.21.1",
  globalArguments: GlobalArgsSchema,
  methods: {
    run: {
      description: "Run the model",
      arguments: RunArgsSchema,
      execute: (_args, context) => {
        // load-bearing: with satisfies, context narrows to the global-arguments
        // shape instead of being implicitly any
        type CtxGlobalArgs = typeof context.globalArgs;
        assertType<Equals<CtxGlobalArgs, GlobalArgs>>();
        return Promise.resolve({ dataHandles: [] });
      },
    },
  },
} satisfies ModelDefinition<typeof GlobalArgsSchema>;

const helperModel = defineModel({
  type: "@swamp-test/helper-model",
  version: "2026.04.21.1",
  globalArguments: GlobalArgsSchema,
  methods: {
    run: {
      description: "Run the model",
      arguments: RunArgsSchema,
      execute: (_args, context) => {
        type CtxGlobalArgs = typeof context.globalArgs;
        assertType<Equals<CtxGlobalArgs, GlobalArgs>>();
        return Promise.resolve({ dataHandles: [] });
      },
    },
  },
});

Deno.test("defineModel is an identity function at runtime", () => {
  const input = {
    type: "@swamp-test/identity",
    version: "2026.04.21.1",
    methods: {
      run: {
        description: "noop",
        arguments: z.object({}),
        execute: () => Promise.resolve({ dataHandles: [] }),
      },
    },
  } satisfies ModelDefinition;
  const output = defineModel(input);
  assertEquals(output, input);
});

Deno.test("satisfies-based model preserves its literal shape", () => {
  assertEquals(satisfiesModel.type, "@swamp-test/satisfies-model");
  assertEquals(typeof satisfiesModel.methods.run.execute, "function");
});

Deno.test("defineModel-based model preserves its literal shape", () => {
  assertEquals(helperModel.type, "@swamp-test/helper-model");
  assertEquals(Object.keys(helperModel.methods), ["run"]);
});

const helperBehavior = defineBehavior({
  type: "@swamp-test/helper-behavior",
  version: "2026.10.13.1",
  globalArguments: GlobalArgsSchema,
  methods: {
    run: {
      description: "Run the behavior",
      arguments: RunArgsSchema,
      execute: (_args, context) => {
        type CtxGlobalArgs = typeof context.globalArgs;
        assertType<Equals<CtxGlobalArgs, GlobalArgs>>();
        return Promise.resolve({ dataHandles: [] });
      },
    },
  },
});

Deno.test("defineBehavior is defineModel under the behavior spelling", () => {
  assertEquals(defineBehavior, defineModel);
  const input = {
    type: "@swamp-test/identity-behavior",
    version: "2026.10.13.1",
    methods: {},
  } satisfies ModelDefinition;
  assertEquals(defineBehavior(input), input);
  assertEquals(helperBehavior.type, "@swamp-test/helper-behavior");
  assertEquals(Object.keys(helperBehavior.methods), ["run"]);
});
