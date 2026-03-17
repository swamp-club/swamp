// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assertEquals, assertThrows } from "@std/assert";
import {
  TriggerCondition,
  TriggerConditionSchema,
  type TriggerEvaluationContext,
} from "./trigger_condition.ts";

/**
 * Creates a mock evaluation context from a status map.
 */
function createContext(
  statuses: Record<
    string,
    "pending" | "running" | "succeeded" | "failed" | "skipped"
  >,
): TriggerEvaluationContext {
  return {
    getStatus: (ref: string) => statuses[ref],
  };
}

Deno.test("TriggerCondition.always creates always condition", () => {
  const cond = TriggerCondition.always();
  assertEquals(cond.data, { type: "always" });
});

Deno.test("TriggerCondition.succeeded creates succeeded condition", () => {
  const cond = TriggerCondition.succeeded();
  assertEquals(cond.data, { type: "succeeded" });
});

Deno.test("TriggerCondition.failed creates failed condition", () => {
  const cond = TriggerCondition.failed();
  assertEquals(cond.data, { type: "failed" });
});

Deno.test("TriggerCondition.completed creates completed condition", () => {
  const cond = TriggerCondition.completed();
  assertEquals(cond.data, { type: "completed" });
});

Deno.test("TriggerCondition.skipped creates skipped condition", () => {
  const cond = TriggerCondition.skipped();
  assertEquals(cond.data, { type: "skipped" });
});

Deno.test("TriggerCondition.and creates and condition", () => {
  const cond = TriggerCondition.and([
    TriggerCondition.succeeded(),
    TriggerCondition.succeeded(),
  ]);
  assertEquals(cond.data.type, "and");
});

Deno.test("TriggerCondition.or creates or condition", () => {
  const cond = TriggerCondition.or([
    TriggerCondition.failed(),
    TriggerCondition.failed(),
  ]);
  assertEquals(cond.data.type, "or");
});

Deno.test("TriggerCondition.not creates not condition", () => {
  const cond = TriggerCondition.not(TriggerCondition.failed());
  assertEquals(cond.data.type, "not");
});

// Evaluation tests

Deno.test("always condition evaluates to true", () => {
  const cond = TriggerCondition.always();
  const ctx = createContext({});
  assertEquals(cond.evaluate(ctx, "step1"), true);
});

Deno.test("succeeded condition evaluates to true when step succeeded", () => {
  const cond = TriggerCondition.succeeded();
  const ctx = createContext({ step1: "succeeded" });
  assertEquals(cond.evaluate(ctx, "step1"), true);
});

Deno.test("succeeded condition evaluates to false when step failed", () => {
  const cond = TriggerCondition.succeeded();
  const ctx = createContext({ step1: "failed" });
  assertEquals(cond.evaluate(ctx, "step1"), false);
});

Deno.test("failed condition evaluates to true when step failed", () => {
  const cond = TriggerCondition.failed();
  const ctx = createContext({ step1: "failed" });
  assertEquals(cond.evaluate(ctx, "step1"), true);
});

Deno.test("failed condition evaluates to false when step succeeded", () => {
  const cond = TriggerCondition.failed();
  const ctx = createContext({ step1: "succeeded" });
  assertEquals(cond.evaluate(ctx, "step1"), false);
});

Deno.test("completed condition evaluates to true when step succeeded", () => {
  const cond = TriggerCondition.completed();
  const ctx = createContext({ step1: "succeeded" });
  assertEquals(cond.evaluate(ctx, "step1"), true);
});

Deno.test("completed condition evaluates to true when step failed", () => {
  const cond = TriggerCondition.completed();
  const ctx = createContext({ step1: "failed" });
  assertEquals(cond.evaluate(ctx, "step1"), true);
});

Deno.test("completed condition evaluates to false when step is pending", () => {
  const cond = TriggerCondition.completed();
  const ctx = createContext({ step1: "pending" });
  assertEquals(cond.evaluate(ctx, "step1"), false);
});

Deno.test("skipped condition evaluates to true when step skipped", () => {
  const cond = TriggerCondition.skipped();
  const ctx = createContext({ step1: "skipped" });
  assertEquals(cond.evaluate(ctx, "step1"), true);
});

Deno.test("skipped condition evaluates to false when step succeeded", () => {
  const cond = TriggerCondition.skipped();
  const ctx = createContext({ step1: "succeeded" });
  assertEquals(cond.evaluate(ctx, "step1"), false);
});

Deno.test("and condition evaluates to true when all conditions are true", () => {
  const cond = TriggerCondition.and([
    TriggerCondition.succeeded(),
    TriggerCondition.not(TriggerCondition.failed()),
  ]);
  const ctx = createContext({ step1: "succeeded" });
  assertEquals(cond.evaluate(ctx, "step1"), true);
});

Deno.test("and condition evaluates to false when any condition is false", () => {
  const cond = TriggerCondition.and([
    TriggerCondition.succeeded(),
    TriggerCondition.not(TriggerCondition.skipped()),
  ]);
  const ctx = createContext({ step1: "failed" });
  assertEquals(cond.evaluate(ctx, "step1"), false);
});

Deno.test("or condition evaluates to true when any condition is true", () => {
  const cond = TriggerCondition.or([
    TriggerCondition.succeeded(),
    TriggerCondition.failed(),
  ]);
  const ctx = createContext({ step1: "failed" });
  assertEquals(cond.evaluate(ctx, "step1"), true);
});

Deno.test("or condition evaluates to false when all conditions are false", () => {
  const cond = TriggerCondition.or([
    TriggerCondition.succeeded(),
    TriggerCondition.skipped(),
  ]);
  const ctx = createContext({ step1: "failed" });
  assertEquals(cond.evaluate(ctx, "step1"), false);
});

Deno.test("not condition inverts the result", () => {
  const cond = TriggerCondition.not(TriggerCondition.failed());
  const ctxFailed = createContext({ step1: "failed" });
  const ctxSucceeded = createContext({ step1: "succeeded" });
  assertEquals(cond.evaluate(ctxFailed, "step1"), false);
  assertEquals(cond.evaluate(ctxSucceeded, "step1"), true);
});

Deno.test("compound condition evaluates correctly", () => {
  // succeeded OR failed (i.e. completed)
  const cond = TriggerCondition.or([
    TriggerCondition.succeeded(),
    TriggerCondition.failed(),
  ]);

  // Test case: step succeeded
  assertEquals(
    cond.evaluate(createContext({ step1: "succeeded" }), "step1"),
    true,
  );

  // Test case: step failed
  assertEquals(
    cond.evaluate(createContext({ step1: "failed" }), "step1"),
    true,
  );

  // Test case: step pending (neither succeeded nor failed)
  assertEquals(
    cond.evaluate(createContext({ step1: "pending" }), "step1"),
    false,
  );
});

// equals tests

Deno.test("equals returns true for identical conditions", () => {
  const cond1 = TriggerCondition.succeeded();
  const cond2 = TriggerCondition.succeeded();
  assertEquals(cond1.equals(cond2), true);
});

Deno.test("equals returns false for different conditions", () => {
  const cond1 = TriggerCondition.succeeded();
  const cond2 = TriggerCondition.failed();
  assertEquals(cond1.equals(cond2), false);
});

// fromData and toData tests

Deno.test("fromData and toData roundtrip correctly", () => {
  const original = TriggerCondition.and([
    TriggerCondition.succeeded(),
    TriggerCondition.not(TriggerCondition.failed()),
  ]);
  const data = original.toData();
  const restored = TriggerCondition.fromData(data);
  assertEquals(original.equals(restored), true);
});

// Schema validation tests

Deno.test("TriggerConditionSchema rejects and with less than 2 conditions", () => {
  assertThrows(() => {
    TriggerConditionSchema.parse({
      type: "and",
      conditions: [{ type: "always" }],
    });
  });
});
