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

import type { WorkflowRunEvent } from "../libswamp/workflows/run.ts";
import { assertEquals } from "@std/assert";
import {
  deserializeEvent,
  isWireEvent,
  serializeEvent,
  serializeSwampError,
} from "./serializer.ts";
import type { SwampError } from "../libswamp/errors.ts";

// ── serializeSwampError ─────────────────────────────────────────────────

Deno.test("serializeSwampError - basic error with code and message", () => {
  const err: SwampError = {
    code: "not_found",
    message: "Model not found",
  };
  const result = serializeSwampError(err);
  assertEquals(result, { code: "not_found", message: "Model not found" });
});

Deno.test("serializeSwampError - includes details when present", () => {
  const err: SwampError = {
    code: "validation_error",
    message: "Invalid inputs",
    details: { field: "name", reason: "required" },
  };
  const result = serializeSwampError(err);
  assertEquals(result, {
    code: "validation_error",
    message: "Invalid inputs",
    details: { field: "name", reason: "required" },
  });
});

Deno.test("serializeSwampError - omits details when undefined", () => {
  const err: SwampError = {
    code: "cancelled",
    message: "Operation cancelled",
    details: undefined,
  };
  const result = serializeSwampError(err);
  assertEquals(result, { code: "cancelled", message: "Operation cancelled" });
  assertEquals("details" in result, false);
});

Deno.test("serializeSwampError - does not include cause (non-serializable)", () => {
  const err: SwampError = {
    code: "network",
    message: "Connection refused",
    cause: new Error("ECONNREFUSED"),
  };
  const result = serializeSwampError(err);
  assertEquals(result, { code: "network", message: "Connection refused" });
  assertEquals("cause" in result, false);
});

// ── serializeEvent with error kind ──────────────────────────────────────

Deno.test("serializeEvent - error event serializes the SwampError", () => {
  const swampError: SwampError = {
    code: "not_authenticated",
    message: "Not authenticated",
  };
  const result = serializeEvent({ kind: "error", error: swampError });
  assertEquals(result, {
    kind: "error",
    error: { code: "not_authenticated", message: "Not authenticated" },
  });
});

Deno.test("serializeEvent - error event with details", () => {
  const swampError: SwampError = {
    code: "validation_error",
    message: "Bad input",
    details: { missing: ["name"] },
  };
  const result = serializeEvent({ kind: "error", error: swampError });
  assertEquals(result, {
    kind: "error",
    error: {
      code: "validation_error",
      message: "Bad input",
      details: { missing: ["name"] },
    },
  });
});

// ── serializeEvent with non-error kinds (jsonSafeClone) ─────────────────

Deno.test("serializeEvent - simple event passes through", () => {
  const event = { kind: "started", runId: "abc-123", workflowName: "deploy" };
  const result = serializeEvent(event);
  assertEquals(result, {
    kind: "started",
    runId: "abc-123",
    workflowName: "deploy",
  });
});

Deno.test("serializeEvent - preserves null and undefined values", () => {
  const event = { kind: "test", a: null, b: undefined };
  const result = serializeEvent(event);
  assertEquals((result as Record<string, unknown>).a, null);
  assertEquals((result as Record<string, unknown>).b, undefined);
});

Deno.test("serializeEvent - converts Date to ISO string", () => {
  const date = new Date("2026-03-27T12:00:00.000Z");
  const event = { kind: "test", timestamp: date };
  const result = serializeEvent(event);
  assertEquals(
    (result as Record<string, unknown>).timestamp,
    "2026-03-27T12:00:00.000Z",
  );
});

Deno.test("serializeEvent - converts Error instances to plain objects", () => {
  const error = new Error("something broke");
  const event = { kind: "test", nested: { err: error } };
  const result = serializeEvent(event);
  const nested = (result as Record<string, unknown>).nested as Record<
    string,
    unknown
  >;
  assertEquals(nested.err !== null && typeof nested.err === "object", true);
  const errObj = nested.err as Record<string, unknown>;
  assertEquals(errObj.message, "something broke");
  assertEquals("stack" in errObj, false);
});

Deno.test("serializeEvent - handles arrays", () => {
  const event = { kind: "test", items: [1, "two", null] };
  const result = serializeEvent(event);
  assertEquals((result as Record<string, unknown>).items, [1, "two", null]);
});

Deno.test("serializeEvent - handles nested objects", () => {
  const event = {
    kind: "completed",
    run: {
      id: "r1",
      status: "succeeded",
      jobs: [{ name: "build", steps: [] }],
    },
  };
  const result = serializeEvent(event);
  assertEquals(result, event);
});

Deno.test("serializeEvent - handles array with mixed types including Date and Error", () => {
  const date = new Date("2026-01-01T00:00:00.000Z");
  const error = new Error("fail");
  const event = { kind: "test", mixed: [date, error, 42, "ok"] };
  const result = serializeEvent(event);
  const mixed = (result as Record<string, unknown>).mixed as unknown[];
  assertEquals(mixed[0], "2026-01-01T00:00:00.000Z");
  assertEquals((mixed[1] as Record<string, unknown>).message, "fail");
  assertEquals(mixed[2], 42);
  assertEquals(mixed[3], "ok");
});

Deno.test("serializeEvent - primitives pass through unchanged", () => {
  const event = {
    kind: "test",
    num: 42,
    str: "hello",
    bool: true,
  };
  const result = serializeEvent(event);
  assertEquals(result, event);
});

Deno.test("serializeEvent - deep clone does not mutate original", () => {
  const inner = { value: "original" };
  const event = { kind: "test", data: inner };
  const result = serializeEvent(event);
  (
    (result as Record<string, unknown>).data as Record<string, unknown>
  ).value = "modified";
  assertEquals(inner.value, "original");
});

Deno.test("deserializeEvent: error events round-trip losslessly through the wire codec", () => {
  const original = {
    kind: "error",
    error: {
      code: "method_execution_failed",
      message: "boom in method",
      details: { stepName: "build", attempt: 2 },
      cause: new Error("underlying"),
    },
  };
  const wire = JSON.parse(JSON.stringify(serializeEvent(original)));
  const restored = deserializeEvent(wire);
  assertEquals(restored.kind, "error");
  const error = restored.error as {
    code: string;
    message: string;
    details?: unknown;
  };
  // The restored error satisfies the SwampError structural contract that
  // renderers consume; only the non-rendered `cause` Error is dropped.
  assertEquals(error.code, "method_execution_failed");
  assertEquals(error.message, "boom in method");
  assertEquals(error.details, { stepName: "build", attempt: 2 });
});

Deno.test("deserializeEvent: exceptionType in details survives serialization round-trip", () => {
  const original = {
    kind: "error",
    error: {
      code: "method_execution_failed",
      message: "An internal error occurred",
      details: { exceptionType: "LockTimeoutError" },
      cause: new Error("underlying"),
    },
  };
  const wire = JSON.parse(JSON.stringify(serializeEvent(original)));
  const restored = deserializeEvent(wire);
  const error = restored.error as {
    code: string;
    message: string;
    details?: unknown;
  };
  assertEquals(error.code, "method_execution_failed");
  assertEquals(error.message, "An internal error occurred");
  assertEquals(error.details, { exceptionType: "LockTimeoutError" });
});

Deno.test("deserializeEvent: run events round-trip renderer-equivalent through JSON", () => {
  const corpus: Array<{ kind: string; [key: string]: unknown }> = [
    { kind: "started", workflowName: "deploy", runId: "r-1" },
    {
      kind: "step_completed",
      jobId: "main",
      stepId: "build",
      durationMs: 1234,
      artifacts: [{ dataId: "d-1", name: "out", version: 3, tags: {} }],
    },
    {
      kind: "method_output",
      jobId: "main",
      stepId: "build",
      line: "hello",
      stream: "stdout",
    },
    {
      kind: "completed",
      status: "succeeded",
      finishedAt: "2026-06-10T00:00:00Z",
    },
    {
      kind: "step_queued",
      jobId: "main",
      stepId: "deploy",
      requirement: "target=prod, platform=linux",
    },
  ];
  for (const event of corpus) {
    const wire = JSON.parse(JSON.stringify(serializeEvent(event)));
    assertEquals(deserializeEvent(wire), event);
  }
});

Deno.test("isWireEvent: signal_wait_requested never reaches a client, which has no handler for it", () => {
  assertEquals(
    isWireEvent({ kind: "signal_wait_requested" }),
    false,
  );
});

Deno.test("isWireEvent: the events an existing client handles are still sent", () => {
  for (
    const kind of [
      "started",
      "step_started",
      "approval_requested",
      "step_failed",
      "suspended",
      "completed",
      "error",
    ]
  ) {
    assertEquals(isWireEvent({ kind }), true, kind);
  }
});

Deno.test("serializeEvent: a suspension's nestedSignalWaits round-trips, in a kind an older client already handles", () => {
  const event = {
    kind: "suspended",
    run: { id: "run-1", jobs: [] },
    jobId: "main",
    stepId: "call-child",
    prompt: "",
    nested: { workflowName: "child", runId: "child-1" },
    nestedSignalWaits: [{
      workflowId: "wf-child",
      workflowName: "child",
      runId: "child-1",
      jobId: "child-job",
      stepId: "review",
      waitId: "6f1c0a52-3f0e-4c4b-9d53-2f6a7c1e8b90",
      deadline: "2026-10-09T00:00:00.000Z",
    }],
  };
  assertEquals(isWireEvent(event), true);
  const wire = JSON.parse(JSON.stringify(serializeEvent(event)));
  assertEquals(deserializeEvent(wire), event);
});

// Every kind a workflow run publishes, checked against the union by the
// compiler: `true` for a kind sent to clients, `false` for one kept local.
// A released client dispatches by kind and crashes on one it does not know,
// so a new kind starts as `false` here, and what it says is carried in a
// field of a kind already sent (swamp-club#3110).
const WORKFLOW_RUN_EVENT_KINDS: Record<WorkflowRunEvent["kind"], boolean> = {
  validating_inputs: true,
  superseded_runs: true,
  evaluating_workflow: true,
  started: true,
  job_started: true,
  job_completed: true,
  job_skipped: true,
  step_started: true,
  step_completed: true,
  step_skipped: true,
  approval_requested: true,
  signal_wait_requested: false,
  step_failed: true,
  model_resolved: true,
  env_var_warning: true,
  method_executing: true,
  method_output: true,
  step_queued: true,
  step_target_disconnected: true,
  method_event: true,
  assert_result: true,
  report_started: true,
  report_completed: true,
  report_failed: true,
  completed: true,
  cancelled: true,
  suspended: true,
  error: true,
};

Deno.test("isWireEvent: sends exactly the workflow run event kinds a released client handles", () => {
  for (const [kind, sent] of Object.entries(WORKFLOW_RUN_EVENT_KINDS)) {
    assertEquals(isWireEvent({ kind }), sent, kind);
  }
});
