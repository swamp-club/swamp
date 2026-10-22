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

import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import {
  attachStepOutputSources,
  fromPersistedStepContexts,
  type StepOutputSources,
  stepOutputSourcesOf,
  toPersistedStepContexts,
} from "./step_output_sources.ts";

const REF = "${{ vault.get('prod', 'A') }}";

const sources: StepOutputSources = [{
  path: [],
  records: [{
    id: "r1",
    name: "main",
    version: 2,
    namespace: "",
    modelName: "writer",
    tags: { "_swamp.sensitiveFields": JSON.stringify(["password"]) },
    attributes: { password: REF, user: "u" },
  }],
}];

Deno.test("attachStepOutputSources: the sources are read back from the context, invisible to string keys and JSON, and copied by spread", () => {
  const context = { status: "succeeded", outputs: { user: "u" } };
  assertStrictEquals(attachStepOutputSources(context, sources), context);
  assertStrictEquals(stepOutputSourcesOf(context), sources);
  assertEquals(Object.keys(context), ["status", "outputs"]);
  assertEquals(JSON.parse(JSON.stringify(context)), {
    status: "succeeded",
    outputs: { user: "u" },
  });
  assertStrictEquals(stepOutputSourcesOf({ ...context }), sources);
  // A copy by string key loses them.
  assertEquals(
    stepOutputSourcesOf(Object.fromEntries(Object.entries(context))),
    undefined,
  );
});

Deno.test("attachStepOutputSources: undefined or empty sources attach nothing, and a non-object carries none", () => {
  const context = { status: "skipped" };
  attachStepOutputSources(context, undefined);
  assertEquals(stepOutputSourcesOf(context), undefined);
  attachStepOutputSources(context, []);
  assertEquals(stepOutputSourcesOf(context), undefined);
  assertEquals(stepOutputSourcesOf(undefined), undefined);
  assertEquals(stepOutputSourcesOf("steps"), undefined);
  assertEquals(stepOutputSourcesOf(null), undefined);
});

Deno.test("toPersistedStepContexts / fromPersistedStepContexts: the sources round-trip through a JSON copy as plain data and come back under the symbol, with no plain key left", () => {
  const steps = {
    seed: attachStepOutputSources(
      { status: "succeeded", outputs: { password: REF, user: "u" } },
      sources,
    ),
    plain: { status: "failed" },
  };
  const persisted = toPersistedStepContexts(steps)!;
  assertEquals(persisted.seed, {
    status: "succeeded",
    outputs: { password: REF, user: "u" },
    sources,
  });
  assertEquals(persisted.plain, { status: "failed" });
  // The originals are untouched.
  assertEquals(Object.keys(steps.seed), ["status", "outputs"]);
  const copied = JSON.parse(JSON.stringify(persisted));
  const restored = fromPersistedStepContexts(copied)!;
  assertEquals(Object.keys(restored.seed), ["status", "outputs"]);
  assertEquals(stepOutputSourcesOf(restored.seed), sources);
  assertEquals(restored.plain, { status: "failed" });
  assertEquals(stepOutputSourcesOf(restored.plain), undefined);
  assertEquals(toPersistedStepContexts(undefined), undefined);
  assertEquals(fromPersistedStepContexts(undefined), undefined);
});

Deno.test("fromPersistedStepContexts: a malformed persisted form is rejected", () => {
  assertThrows(() =>
    fromPersistedStepContexts({
      seed: {
        status: "succeeded",
        sources: [{ path: [], records: [{ id: "r1" }] }],
      },
    })
  );
  assertThrows(() =>
    fromPersistedStepContexts({ seed: { status: "succeeded", sources: "x" } })
  );
});

Deno.test("toPersistedStepContexts / fromPersistedStepContexts: a step named __proto__ is an own key on both sides", () => {
  const steps: Record<string, object> = {};
  Object.defineProperty(steps, "__proto__", {
    value: attachStepOutputSources(
      { status: "succeeded", outputs: { user: "u" } },
      sources,
    ),
    enumerable: true,
    writable: true,
    configurable: true,
  });
  const persisted = toPersistedStepContexts(steps)!;
  assert(Object.hasOwn(persisted, "__proto__"));
  assertStrictEquals(Object.getPrototypeOf(persisted), Object.prototype);
  const restored = fromPersistedStepContexts(
    JSON.parse(JSON.stringify(persisted)),
  )!;
  assert(Object.hasOwn(restored, "__proto__"));
  assertStrictEquals(Object.getPrototypeOf(restored), Object.prototype);
  const context = Object.getOwnPropertyDescriptor(restored, "__proto__")!
    .value as Record<string, unknown>;
  assertEquals(Object.keys(context), ["status", "outputs"]);
  assertEquals(stepOutputSourcesOf(context), sources);
});
