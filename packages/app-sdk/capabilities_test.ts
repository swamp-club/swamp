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
  decideAppRequest,
  exposedRequestTypes,
  holdsExpression,
  isAppReadCapability,
  isGatedAppReadCapability,
} from "./capabilities.ts";

Deno.test("decideAppRequest: a capability allows only its own requests", () => {
  const grant = { capabilities: ["runs:read"], run: [], methods: [] };
  assertEquals(
    decideAppRequest(grant, "workflow.run.search", {}).allowed,
    true,
  );
  assertEquals(decideAppRequest(grant, "data.query", {}).allowed, false);
});

Deno.test("decideAppRequest: a run must name a listed workflow exactly", () => {
  const grant = { capabilities: [], run: ["@acme/nightly"], methods: [] };
  const decide = (workflowIdOrName: unknown) =>
    decideAppRequest(grant, "workflow.run", { workflowIdOrName }).allowed;
  assertEquals(decide("@acme/nightly"), true);
  assertEquals(decide("@acme/nightly-2"), false);
  assertEquals(decide(undefined), false);
  assertEquals(decideAppRequest(grant, "workflow.run", null).allowed, false);
});

Deno.test("decideAppRequest: an unknown capability grants nothing", () => {
  const grant = { capabilities: ["everything"], run: [], methods: [] };
  assertEquals(decideAppRequest(grant, "data.query", {}).allowed, false);
});

Deno.test("exposedRequestTypes: nothing sensitive is reachable", () => {
  for (const type of exposedRequestTypes()) {
    for (const prefix of ["vault.", "access.", "audit.", "app.", "serve."]) {
      assertEquals(type.startsWith(prefix), false, type);
    }
  }
});

const METHODS = {
  capabilities: [],
  run: [],
  methods: [{ behavior: "plan", type: "@acme/plan", methods: ["x"] }],
};

Deno.test("decideAppRequest: a method runs only on a listed behavior", () => {
  const decide = (payload: unknown) =>
    decideAppRequest(METHODS, "model.method.run", payload).allowed;
  assertEquals(decide({ modelIdOrName: "plan", methodName: "x" }), true);
  assertEquals(decide({ modelIdOrName: "other", methodName: "x" }), false);
  assertEquals(decide(undefined), false);
});

Deno.test("decideAppRequest: a method runs only if its behavior lists it", () => {
  const decide = (payload: unknown) =>
    decideAppRequest(METHODS, "model.method.run", payload);
  assertEquals(
    decide({ modelIdOrName: "plan", methodName: "x" }).allowed,
    true,
  );
  assertEquals(decide({ modelIdOrName: "plan", methodName: "delete" }), {
    allowed: false,
    reason: "This app may not run delete on plan.",
  });
  assertEquals(decide({ modelIdOrName: "plan" }).allowed, false);
  assertEquals(
    decide({ modelIdOrName: "plan", methodName: ["x"] }).allowed,
    false,
  );
});

Deno.test("decideAppRequest: a listed name cannot be run as another type", () => {
  const decide = (payload: unknown) =>
    decideAppRequest(METHODS, "model.method.run", payload).allowed;
  assertEquals(
    decide({
      modelIdOrName: "plan",
      methodName: "x",
      typeArg: "@acme/plan",
      definitionName: "plan",
    }),
    true,
  );
  assertEquals(
    decide({
      modelIdOrName: "plan",
      methodName: "x",
      typeArg: "command/shell",
    }),
    false,
  );
  assertEquals(
    decide({ modelIdOrName: "plan", methodName: "x", definitionName: "other" }),
    false,
  );
});

Deno.test("decideAppRequest: a workflow's inputs may not hold an expression", () => {
  const grant = { capabilities: [], run: ["nightly"], methods: [] };
  const decide = (inputs: unknown) =>
    decideAppRequest(grant, "workflow.run", {
      workflowIdOrName: "nightly",
      inputs,
    }).allowed;
  assertEquals(decide({ day: "mon" }), true);
  assertEquals(decide({ a: "${{ vault.get('x', 'y') }}" }), false);
  assertEquals(decide({ a: { b: ["${{ env.HOME }}"] } }), false);
  assertEquals(decide({ "${{ env.HOME }}": 1 }), false);
});

Deno.test("holdsExpression: input nested past the call stack is still read", () => {
  let nested: unknown = "${{ vault.get('x', 'y') }}";
  for (let depth = 0; depth < 100_000; depth++) nested = { value: nested };
  assertEquals(holdsExpression(nested), true);
});

Deno.test("decideAppRequest: federation:read allows the two member reads and nothing else", () => {
  const grant = { capabilities: ["federation:read"], run: [], methods: [] };
  assertEquals(
    decideAppRequest(grant, "federation.member.list", {}).allowed,
    true,
  );
  assertEquals(
    decideAppRequest(grant, "federation.member.get", { name: "a" }).allowed,
    true,
  );
  for (
    const type of [
      "federation.member.remove",
      "federation.token.create",
      "federation.token.list",
      "data.query",
    ]
  ) {
    assertEquals(decideAppRequest(grant, type, {}).allowed, false, type);
  }
  const without = { capabilities: ["data:read"], run: [], methods: [] };
  assertEquals(
    decideAppRequest(without, "federation.member.list", {}).allowed,
    false,
  );
});

Deno.test("decideAppRequest: prototype names as capabilities grant nothing", () => {
  for (
    const name of ["__proto__", "constructor", "toString", "hasOwnProperty"]
  ) {
    const grant = { capabilities: [name], run: [], methods: [] };
    for (
      const type of ["worker.list", "constructor", "federation.member.list"]
    ) {
      assertEquals(
        decideAppRequest(grant, type, {}).allowed,
        false,
        `${name} ${type}`,
      );
    }
  }
});

Deno.test("exposedRequestTypes: the gated reads appear only when asked for", () => {
  const off = exposedRequestTypes();
  const on = exposedRequestTypes({ gated: true });
  assertEquals(off.has("federation.member.list"), false);
  assertEquals(
    [...on].filter((type) => !off.has(type)).sort(),
    ["federation.member.get", "federation.member.list"],
  );
});

Deno.test("isAppReadCapability: federation:read is gated, never an ordinary read", () => {
  assertEquals(isAppReadCapability("federation:read"), false);
  assertEquals(isGatedAppReadCapability("federation:read"), true);
  assertEquals(isGatedAppReadCapability("workers:read"), false);
});
