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
  const cond = TriggerCondition.succeeded("step1");
  assertEquals(cond.data, { type: "succeeded", ref: "step1" });
});

Deno.test("TriggerCondition.failed creates failed condition", () => {
  const cond = TriggerCondition.failed("step1");
  assertEquals(cond.data, { type: "failed", ref: "step1" });
});

Deno.test("TriggerCondition.completed creates completed condition", () => {
  const cond = TriggerCondition.completed("step1");
  assertEquals(cond.data, { type: "completed", ref: "step1" });
});

Deno.test("TriggerCondition.skipped creates skipped condition", () => {
  const cond = TriggerCondition.skipped("step1");
  assertEquals(cond.data, { type: "skipped", ref: "step1" });
});

Deno.test("TriggerCondition.and creates and condition", () => {
  const cond = TriggerCondition.and([
    TriggerCondition.succeeded("step1"),
    TriggerCondition.succeeded("step2"),
  ]);
  assertEquals(cond.data.type, "and");
});

Deno.test("TriggerCondition.or creates or condition", () => {
  const cond = TriggerCondition.or([
    TriggerCondition.failed("step1"),
    TriggerCondition.failed("step2"),
  ]);
  assertEquals(cond.data.type, "or");
});

Deno.test("TriggerCondition.not creates not condition", () => {
  const cond = TriggerCondition.not(TriggerCondition.failed("step1"));
  assertEquals(cond.data.type, "not");
});

// Evaluation tests

Deno.test("always condition evaluates to true", () => {
  const cond = TriggerCondition.always();
  const ctx = createContext({});
  assertEquals(cond.evaluate(ctx), true);
});

Deno.test("succeeded condition evaluates to true when step succeeded", () => {
  const cond = TriggerCondition.succeeded("step1");
  const ctx = createContext({ step1: "succeeded" });
  assertEquals(cond.evaluate(ctx), true);
});

Deno.test("succeeded condition evaluates to false when step failed", () => {
  const cond = TriggerCondition.succeeded("step1");
  const ctx = createContext({ step1: "failed" });
  assertEquals(cond.evaluate(ctx), false);
});

Deno.test("failed condition evaluates to true when step failed", () => {
  const cond = TriggerCondition.failed("step1");
  const ctx = createContext({ step1: "failed" });
  assertEquals(cond.evaluate(ctx), true);
});

Deno.test("failed condition evaluates to false when step succeeded", () => {
  const cond = TriggerCondition.failed("step1");
  const ctx = createContext({ step1: "succeeded" });
  assertEquals(cond.evaluate(ctx), false);
});

Deno.test("completed condition evaluates to true when step succeeded", () => {
  const cond = TriggerCondition.completed("step1");
  const ctx = createContext({ step1: "succeeded" });
  assertEquals(cond.evaluate(ctx), true);
});

Deno.test("completed condition evaluates to true when step failed", () => {
  const cond = TriggerCondition.completed("step1");
  const ctx = createContext({ step1: "failed" });
  assertEquals(cond.evaluate(ctx), true);
});

Deno.test("completed condition evaluates to false when step is pending", () => {
  const cond = TriggerCondition.completed("step1");
  const ctx = createContext({ step1: "pending" });
  assertEquals(cond.evaluate(ctx), false);
});

Deno.test("skipped condition evaluates to true when step skipped", () => {
  const cond = TriggerCondition.skipped("step1");
  const ctx = createContext({ step1: "skipped" });
  assertEquals(cond.evaluate(ctx), true);
});

Deno.test("skipped condition evaluates to false when step succeeded", () => {
  const cond = TriggerCondition.skipped("step1");
  const ctx = createContext({ step1: "succeeded" });
  assertEquals(cond.evaluate(ctx), false);
});

Deno.test("and condition evaluates to true when all conditions are true", () => {
  const cond = TriggerCondition.and([
    TriggerCondition.succeeded("step1"),
    TriggerCondition.succeeded("step2"),
  ]);
  const ctx = createContext({ step1: "succeeded", step2: "succeeded" });
  assertEquals(cond.evaluate(ctx), true);
});

Deno.test("and condition evaluates to false when any condition is false", () => {
  const cond = TriggerCondition.and([
    TriggerCondition.succeeded("step1"),
    TriggerCondition.succeeded("step2"),
  ]);
  const ctx = createContext({ step1: "succeeded", step2: "failed" });
  assertEquals(cond.evaluate(ctx), false);
});

Deno.test("or condition evaluates to true when any condition is true", () => {
  const cond = TriggerCondition.or([
    TriggerCondition.succeeded("step1"),
    TriggerCondition.succeeded("step2"),
  ]);
  const ctx = createContext({ step1: "failed", step2: "succeeded" });
  assertEquals(cond.evaluate(ctx), true);
});

Deno.test("or condition evaluates to false when all conditions are false", () => {
  const cond = TriggerCondition.or([
    TriggerCondition.succeeded("step1"),
    TriggerCondition.succeeded("step2"),
  ]);
  const ctx = createContext({ step1: "failed", step2: "failed" });
  assertEquals(cond.evaluate(ctx), false);
});

Deno.test("not condition inverts the result", () => {
  const cond = TriggerCondition.not(TriggerCondition.failed("step1"));
  const ctxFailed = createContext({ step1: "failed" });
  const ctxSucceeded = createContext({ step1: "succeeded" });
  assertEquals(cond.evaluate(ctxFailed), false);
  assertEquals(cond.evaluate(ctxSucceeded), true);
});

Deno.test("complex nested condition evaluates correctly", () => {
  // (step1 succeeded AND step2 succeeded) OR step3 failed
  const cond = TriggerCondition.or([
    TriggerCondition.and([
      TriggerCondition.succeeded("step1"),
      TriggerCondition.succeeded("step2"),
    ]),
    TriggerCondition.failed("step3"),
  ]);

  // Test case: step1 and step2 succeeded
  assertEquals(
    cond.evaluate(
      createContext({
        step1: "succeeded",
        step2: "succeeded",
        step3: "succeeded",
      }),
    ),
    true,
  );

  // Test case: step3 failed
  assertEquals(
    cond.evaluate(
      createContext({ step1: "failed", step2: "failed", step3: "failed" }),
    ),
    true,
  );

  // Test case: neither condition met
  assertEquals(
    cond.evaluate(
      createContext({
        step1: "succeeded",
        step2: "failed",
        step3: "succeeded",
      }),
    ),
    false,
  );
});

// getRefs tests

Deno.test("getRefs returns empty array for always condition", () => {
  const cond = TriggerCondition.always();
  assertEquals(cond.getRefs(), []);
});

Deno.test("getRefs returns ref for simple conditions", () => {
  assertEquals(TriggerCondition.succeeded("step1").getRefs(), ["step1"]);
  assertEquals(TriggerCondition.failed("step2").getRefs(), ["step2"]);
  assertEquals(TriggerCondition.completed("step3").getRefs(), ["step3"]);
  assertEquals(TriggerCondition.skipped("step4").getRefs(), ["step4"]);
});

Deno.test("getRefs collects all refs from nested conditions", () => {
  const cond = TriggerCondition.and([
    TriggerCondition.succeeded("step1"),
    TriggerCondition.or([
      TriggerCondition.failed("step2"),
      TriggerCondition.completed("step3"),
    ]),
  ]);
  assertEquals(cond.getRefs().sort(), ["step1", "step2", "step3"]);
});

// equals tests

Deno.test("equals returns true for identical conditions", () => {
  const cond1 = TriggerCondition.succeeded("step1");
  const cond2 = TriggerCondition.succeeded("step1");
  assertEquals(cond1.equals(cond2), true);
});

Deno.test("equals returns false for different conditions", () => {
  const cond1 = TriggerCondition.succeeded("step1");
  const cond2 = TriggerCondition.failed("step1");
  assertEquals(cond1.equals(cond2), false);
});

// fromData and toData tests

Deno.test("fromData and toData roundtrip correctly", () => {
  const original = TriggerCondition.and([
    TriggerCondition.succeeded("step1"),
    TriggerCondition.not(TriggerCondition.failed("step2")),
  ]);
  const data = original.toData();
  const restored = TriggerCondition.fromData(data);
  assertEquals(original.equals(restored), true);
});

// Schema validation tests

Deno.test("TriggerConditionSchema rejects empty ref", () => {
  assertThrows(() => {
    TriggerConditionSchema.parse({ type: "succeeded", ref: "" });
  });
});

Deno.test("TriggerConditionSchema rejects and with less than 2 conditions", () => {
  assertThrows(() => {
    TriggerConditionSchema.parse({
      type: "and",
      conditions: [{ type: "always" }],
    });
  });
});
