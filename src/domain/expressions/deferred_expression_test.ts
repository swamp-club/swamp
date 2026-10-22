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
import type { ExpressionContext } from "./model_resolver.ts";
import { attachSensitiveValues } from "./sensitive_context.ts";
import { attachStepOutputSources } from "./step_output_sources.ts";
import { RunSensitiveValues } from "../secrets/mod.ts";
import { SecretBagRegistry } from "../vaults/secret_bag_registry.ts";

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

Deno.test("captureDeferredBindings: an omitted key is one key, and no path reaches a prototype (swamp-club#3583)", () => {
  const context = {
    inputs: { "a.b": "dotted", a: { b: "nested" }, keep: 1 },
    self: {},
    run: { id: "r1", inputs: { "a.b": "dotted" } },
    workflowRunId: "r1",
    steps: {},
  } as unknown as ExpressionContext;
  const toString = Object.prototype.toString;
  const bindings = captureDeferredBindings(context, [
    "inputs.a.b",
    "run.inputs.a.b",
    "inputs.__proto__.toString",
    "run.inputs.__proto__",
    "inputs.constructor",
    "other.key",
  ]);
  // The dotted key is removed whole; the nested one is untouched.
  assertEquals(bindings.inputs as unknown, { a: { b: "nested" }, keep: 1 });
  assertEquals(bindings.run as unknown, { id: "r1", inputs: {} });
  assertEquals(Object.prototype.toString, toString);
  assertEquals(typeof ({}).toString, "function");
});

Deno.test("captureDeferredBindings: a typed run copies each step's output sources as plain data the schema accepts, and an untyped run's copy is what it always was (typed-secrets 4.2)", () => {
  // A mutable literal: the record schema's form and the context's both
  // take it.
  const sources = [{
    path: [] as string[],
    records: [{
      id: "r1",
      name: "main",
      version: 2,
      namespace: "",
      modelName: "writer",
      tags: { "_swamp.sensitiveFields": JSON.stringify(["password"]) },
      attributes: { password: "${{ vault.get('prod', 'A') }}", user: "u" },
    }],
  }];
  const steps = () => ({
    seed: attachStepOutputSources(
      {
        status: "succeeded",
        outputs: { password: "${{ vault.get('prod', 'A') }}", user: "u" },
      },
      sources,
    ),
    plain: { status: "skipped" },
  });
  const base = {
    inputs: { region: "us-east" },
    self: { id: "d1", name: "def", version: 1, tags: {}, globalArguments: {} },
    run: {
      id: "r1",
      workflowId: "w1",
      workflowName: "wf",
      startedAt: "2026-01-01T00:00:00.000Z",
      tags: {},
      inputs: {},
    },
    workflowRunId: "r1",
  };
  const untyped = captureDeferredBindings(
    attachSensitiveValues(
      { ...base, steps: steps() } as unknown as ExpressionContext,
      new RunSensitiveValues(),
    ),
  );
  assertEquals(untyped.steps, {
    seed: {
      status: "succeeded",
      outputs: { password: "${{ vault.get('prod', 'A') }}", user: "u" },
    },
    plain: { status: "skipped" },
  });
  const typed = captureDeferredBindings(
    attachSensitiveValues(
      { ...base, steps: steps() } as unknown as ExpressionContext,
      new RunSensitiveValues(
        undefined,
        new SecretBagRegistry({ typedSecrets: true }),
      ),
    ),
  );
  assertEquals(typed.steps, {
    seed: {
      status: "succeeded",
      outputs: { password: "${{ vault.get('prod', 'A') }}", user: "u" },
      sources,
    },
    plain: { status: "skipped" },
  });
  // The copy is plain data the record schema accepts, in both forms.
  for (const bindings of [untyped, typed]) {
    const parsed = DeferredExpressionSchema.parse({
      id: crypto.randomUUID(),
      expression: "${{ env.HOME }}",
      bindings: JSON.parse(JSON.stringify(bindings)),
    });
    assertEquals(parsed.bindings.steps?.plain, { status: "skipped" });
  }
  // A context without a registry captures as the untyped run does.
  assertEquals(
    captureDeferredBindings(
      { ...base, steps: steps() } as unknown as ExpressionContext,
    ).steps,
    untyped.steps,
  );
});
