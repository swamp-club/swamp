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
import type { CommandInvocationData } from "../../domain/telemetry/command_invocation.ts";
import type { WorkflowContextData } from "../../domain/telemetry/workflow_context.ts";
import type { WorkflowRunEvent, WorkflowTelemetrySink } from "./run.ts";
import { WorkflowTelemetryBridge } from "./telemetry_bridge.ts";

interface RecordedCall {
  invocation: CommandInvocationData;
  startedAt: Date;
  completedAt: Date;
  error: Error | null;
  parentInvocationId: string;
  workflowContext: WorkflowContextData;
}

class FakeSink implements WorkflowTelemetrySink {
  readonly parentInvocationId = "parent-x";
  readonly calls: RecordedCall[] = [];

  recordChildInvocation(
    invocation: CommandInvocationData,
    startedAt: Date,
    completedAt: Date,
    error: Error | null,
    parentInvocationId: string,
    workflowContext: WorkflowContextData,
  ): Promise<void> {
    this.calls.push({
      invocation,
      startedAt,
      completedAt,
      error,
      parentInvocationId,
      workflowContext,
    });
    return Promise.resolve();
  }
}

const STARTED_EVENT: WorkflowRunEvent = {
  kind: "started",
  runId: "run-1",
  workflowName: "deploy",
  driver: "local",
  jobs: [],
};

Deno.test("bridge records success entry on method_executing → step_completed", async () => {
  const sink = new FakeSink();
  const bridge = new WorkflowTelemetryBridge(sink);

  await bridge.observe(STARTED_EVENT);
  await bridge.observe({
    kind: "model_resolved",
    jobId: "build",
    stepId: "validate",
    modelName: "shell-step",
    modelType: "@swamp/shell",
    modelId: "test-model-id",
    methodName: "run",
  });
  await bridge.observe({
    kind: "method_executing",
    jobId: "build",
    stepId: "validate",
    modelName: "shell-step",
    methodName: "run",
    driver: "local",
  });
  await bridge.observe({
    kind: "step_completed",
    jobId: "build",
    stepId: "validate",
  });
  await bridge.finalize();

  assertEquals(sink.calls.length, 1);
  const call = sink.calls[0];
  assertEquals(call.invocation.command, "model");
  assertEquals(call.invocation.subcommand, "method");
  assertEquals(call.invocation.args, ["run", "<REDACTED>", "run"]);
  assertEquals(call.error, null);
  assertEquals(call.parentInvocationId, "parent-x");
  assertEquals(call.workflowContext.workflowName, "deploy");
  assertEquals(call.workflowContext.runId, "run-1");
  assertEquals(call.workflowContext.jobName, "build");
  assertEquals(call.workflowContext.stepName, "validate");
  assertEquals(call.workflowContext.modelType, "@swamp/shell");
  assertEquals(call.workflowContext.driver, "local");
});

Deno.test("bridge records error entry on method_executing → step_failed (post-method-executing failure)", async () => {
  const sink = new FakeSink();
  const bridge = new WorkflowTelemetryBridge(sink);

  await bridge.observe(STARTED_EVENT);
  await bridge.observe({
    kind: "model_resolved",
    jobId: "build",
    stepId: "transform",
    modelName: "etl",
    modelType: "@swamp/python",
    modelId: "test-model-id",
    methodName: "transform",
  });
  await bridge.observe({
    kind: "method_executing",
    jobId: "build",
    stepId: "transform",
    modelName: "etl",
    methodName: "transform",
    driver: "docker",
  });
  await bridge.observe({
    kind: "step_failed",
    jobId: "build",
    stepId: "transform",
    error: "transform threw",
  });
  await bridge.finalize();

  assertEquals(sink.calls.length, 1);
  assertEquals(sink.calls[0].error?.message, "transform threw");
  assertEquals(sink.calls[0].workflowContext.driver, "docker");
});

Deno.test("bridge synthesizes durationMs=0 entry for pre-method-executing failures", async () => {
  const sink = new FakeSink();
  const bridge = new WorkflowTelemetryBridge(sink);

  await bridge.observe(STARTED_EVENT);
  // No method_executing — domain emits step_failed with modelName/methodName
  await bridge.observe({
    kind: "step_failed",
    jobId: "lookup",
    stepId: "fetch",
    error: "model not found: missing",
    modelName: "missing",
    methodName: "enrich",
    driver: "local",
  });
  await bridge.finalize();

  assertEquals(sink.calls.length, 1);
  const call = sink.calls[0];
  assertEquals(
    call.completedAt.getTime() - call.startedAt.getTime(),
    0,
    "synthesized entries have zero duration",
  );
  assertEquals(call.error?.message, "model not found: missing");
  assertEquals(call.workflowContext.driver, "local");
  assertEquals(call.invocation.args, ["run", "<REDACTED>", "enrich"]);
});

Deno.test("bridge skips workflow-task / structural step_failed (no modelName)", async () => {
  const sink = new FakeSink();
  const bridge = new WorkflowTelemetryBridge(sink);

  await bridge.observe(STARTED_EVENT);
  // Structural failure — workflow-task step or cycle/depth — no model context
  await bridge.observe({
    kind: "step_failed",
    jobId: "orchestrate",
    stepId: "nested",
    error: "Nested workflow failed",
  });
  await bridge.finalize();

  assertEquals(sink.calls.length, 0);
});

Deno.test("bridge finalize() drains in-flight invocations as error entries", async () => {
  const sink = new FakeSink();
  const bridge = new WorkflowTelemetryBridge(sink);

  await bridge.observe(STARTED_EVENT);
  await bridge.observe({
    kind: "method_executing",
    jobId: "build",
    stepId: "long",
    modelName: "slow",
    methodName: "process",
    driver: "local",
  });
  // Stream terminates without step_completed/step_failed
  await bridge.finalize();

  assertEquals(sink.calls.length, 1);
  const call = sink.calls[0];
  assertEquals(
    call.error?.message,
    "workflow run terminated before completion",
  );
  assertEquals(call.workflowContext.stepName, "long");
});

Deno.test("bridge finalize() with custom reason propagates to drained entries", async () => {
  const sink = new FakeSink();
  const bridge = new WorkflowTelemetryBridge(sink);

  await bridge.observe(STARTED_EVENT);
  await bridge.observe({
    kind: "method_executing",
    jobId: "build",
    stepId: "long",
    modelName: "slow",
    methodName: "process",
  });
  await bridge.finalize("aborted by user");

  assertEquals(sink.calls[0].error?.message, "aborted by user");
});

Deno.test("bridge finalize() is idempotent", async () => {
  const sink = new FakeSink();
  const bridge = new WorkflowTelemetryBridge(sink);

  await bridge.observe(STARTED_EVENT);
  await bridge.observe({
    kind: "method_executing",
    jobId: "j",
    stepId: "s",
    modelName: "m",
    methodName: "go",
  });
  await bridge.finalize();
  await bridge.finalize(); // second call should be a no-op

  assertEquals(sink.calls.length, 1);
});

Deno.test("bridge handles two sequential workflows independently (no state leak)", async () => {
  // Each workflow stream gets its own bridge. Verify constructing a
  // fresh bridge after one finalizes does not bleed state.
  const sink = new FakeSink();
  const first = new WorkflowTelemetryBridge(sink);
  await first.observe(STARTED_EVENT);
  await first.observe({
    kind: "method_executing",
    jobId: "j1",
    stepId: "s1",
    modelName: "m1",
    methodName: "do",
  });
  await first.observe({
    kind: "step_completed",
    jobId: "j1",
    stepId: "s1",
  });
  await first.finalize();

  assertEquals(sink.calls.length, 1);

  const second = new WorkflowTelemetryBridge(sink);
  await second.observe({
    kind: "started",
    runId: "run-2",
    workflowName: "etl",
    jobs: [],
  });
  await second.observe({
    kind: "method_executing",
    jobId: "j2",
    stepId: "s2",
    modelName: "m2",
    methodName: "go",
  });
  await second.observe({
    kind: "step_completed",
    jobId: "j2",
    stepId: "s2",
  });
  await second.finalize();

  assertEquals(sink.calls.length, 2);
  assertEquals(sink.calls[0].workflowContext.runId, "run-1");
  assertEquals(sink.calls[1].workflowContext.runId, "run-2");
});

Deno.test("bridge emits one entry per forEach iteration (distinct stepNames)", async () => {
  const sink = new FakeSink();
  const bridge = new WorkflowTelemetryBridge(sink);

  await bridge.observe(STARTED_EVENT);
  // forEach expands a step into iterations with derived step names
  for (const stepId of ["fan-out[0]", "fan-out[1]"]) {
    await bridge.observe({
      kind: "method_executing",
      jobId: "fan",
      stepId,
      modelName: "shell",
      methodName: "run",
    });
    await bridge.observe({
      kind: "step_completed",
      jobId: "fan",
      stepId,
    });
  }
  await bridge.finalize();

  assertEquals(sink.calls.length, 2);
  assertEquals(sink.calls[0].workflowContext.stepName, "fan-out[0]");
  assertEquals(sink.calls[1].workflowContext.stepName, "fan-out[1]");
});

Deno.test("bridge does not record allowedFailure: true differently from error", async () => {
  // Per ADV-3 resolution: allowedFailure records as error (the method
  // outcome). The workflow's overall success is the parent's concern.
  const sink = new FakeSink();
  const bridge = new WorkflowTelemetryBridge(sink);

  await bridge.observe(STARTED_EVENT);
  await bridge.observe({
    kind: "method_executing",
    jobId: "build",
    stepId: "optional",
    modelName: "shell",
    methodName: "run",
  });
  await bridge.observe({
    kind: "step_failed",
    jobId: "build",
    stepId: "optional",
    error: "exit 1",
    allowedFailure: true,
  });
  await bridge.finalize();

  assertEquals(sink.calls.length, 1);
  assertEquals(sink.calls[0].error?.message, "exit 1");
});
