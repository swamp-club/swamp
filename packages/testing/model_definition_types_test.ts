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
 * Type-level regression tests for the model-authoring escape hatch.
 *
 * The load-bearing assertion is that `deno check` passes under
 * strict+noImplicitAny. If the generics in model_definition_types.ts
 * silently regress such that execute parameters become implicitly
 * `any`, this file fails to type-check and CI catches it.
 *
 * Context: swamp-club issue #141. See
 * `.claude/skills/swamp-extension-model/references/typing.md` for
 * the narrative and worked example.
 */

import { assertEquals } from "@std/assert";
import { z } from "zod";
import { defineModel, type ModelDefinition } from "./mod.ts";

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  region: z.string(),
  tags: z.record(z.string(), z.string()).default({}),
});

const RunArgsSchema = z.object({ bucket: z.string() });

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Type-level helpers
// ---------------------------------------------------------------------------

/** Compile-time check that two types are mutually assignable. */
type Equals<A, B> = A extends B ? (B extends A ? true : false) : false;

/** Asserts at compile time that `T` is exactly `true`. */
function assertType<T extends true>(_value?: T): void {
  // no-op — purely a type-level assertion
}

// ---------------------------------------------------------------------------
// `satisfies ModelDefinition<...>` path
//
// Fixes TS7006 (execute params get concrete contextual types) and narrows
// `context.globalArgs` to the inferred global-arguments shape. The `args`
// parameter is typed as `any` via `z.infer<z.ZodTypeAny>` — authors
// narrow it per-method by parsing with the method's schema.
// ---------------------------------------------------------------------------

const satisfiesModel = {
  type: "@swamp-test/satisfies-model",
  version: "2026.04.21.1",
  globalArguments: GlobalArgsSchema,
  methods: {
    run: {
      description: "Run the model",
      arguments: RunArgsSchema,
      execute: (_args, context) => {
        // Load-bearing: under the pre-escape-hatch form this line lived
        // on an implicitly-any context. With `satisfies`, it narrows to
        // the global-arguments shape.
        type CtxGlobalArgs = typeof context.globalArgs;
        assertType<Equals<CtxGlobalArgs, GlobalArgs>>();
        return Promise.resolve({ dataHandles: [] });
      },
    },
  },
} satisfies ModelDefinition<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// `defineModel` path — same contract as `satisfies`, function form.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Runtime smoke — confirm the helpers preserve the input literal.
// ---------------------------------------------------------------------------

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
