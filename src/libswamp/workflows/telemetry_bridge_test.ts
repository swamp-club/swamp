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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { errorPaths } from "../../domain/errors.ts";
import type { CommandInvocationData } from "../../domain/telemetry/command_invocation.ts";
import type { WorkflowContextData } from "../../domain/telemetry/workflow_context.ts";
import type { WorkflowExecutionEvent } from "../../domain/workflows/execution_service.ts";
import type { WorkflowTelemetrySink } from "./run.ts";
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

const STARTED_EVENT: WorkflowExecutionEvent = {
  kind: "started",
  runId: "run-1",
  workflowName: "deploy",
  logPath: "/tmp/log",
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
    runId: "run-1",
    modelName: "shell-step",
    modelType: "@swamp/shell",
    modelId: "test-model-id",
    methodName: "run",
  });
  await bridge.observe({
    kind: "method_executing",
    jobId: "build",
    stepId: "validate",
    runId: "run-1",
    modelName: "shell-step",
    methodName: "run",
  });
  await bridge.observe({
    kind: "step_completed",
    jobId: "build",
    stepId: "validate",
    runId: "run-1",
  });
  await bridge.finalize();

  assertEquals(sink.calls.length, 1);
  const call = sink.calls[0];
  assertEquals(call.invocation.command, "model");
  assertEquals(call.invocation.subcommand, "method");
  assertEquals(call.invocation.args, ["run", "shell-step", "run"]);
  assertEquals(call.invocation.commandPath, ["model", "method", "run"]);
  assertEquals(call.error, null);
  assertEquals(call.parentInvocationId, "parent-x");
  assertEquals(call.workflowContext.workflowName, "deploy");
  assertEquals(call.workflowContext.runId, "run-1");
  assertEquals(call.workflowContext.jobName, "build");
  assertEquals(call.workflowContext.stepName, "validate");
  assertEquals(call.workflowContext.modelType, "@swamp/shell");
});

Deno.test("bridge records error entry on method_executing → step_failed (post-method-executing failure)", async () => {
  const sink = new FakeSink();
  const bridge = new WorkflowTelemetryBridge(sink);

  await bridge.observe(STARTED_EVENT);
  await bridge.observe({
    kind: "model_resolved",
    jobId: "build",
    stepId: "transform",
    runId: "run-1",
    modelName: "etl",
    modelType: "@swamp/python",
    modelId: "test-model-id",
    methodName: "transform",
  });
  await bridge.observe({
    kind: "method_executing",
    jobId: "build",
    stepId: "transform",
    runId: "run-1",
    modelName: "etl",
    methodName: "transform",
  });
  await bridge.observe({
    kind: "step_failed",
    jobId: "build",
    stepId: "transform",
    runId: "run-1",
    error: "transform threw",
  });
  await bridge.finalize();

  assertEquals(sink.calls.length, 1);
  assertEquals(sink.calls[0].error?.message, "transform threw");
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
    runId: "run-1",
    error: "model not found: missing",
    modelName: "missing",
    methodName: "enrich",
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
  assertEquals(call.invocation.args, ["run", "missing", "enrich"]);
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
    runId: "run-1",
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
    runId: "run-1",
    modelName: "slow",
    methodName: "process",
  });
  // Stream terminates without step_completed/step_failed
  await bridge.finalize();

  assertEquals(sink.calls.length, 1);
  const call = sink.calls[0];
  assertStringIncludes(
    call.error!.message,
    "workflow run terminated before completion",
  );
  assertStringIncludes(call.error!.message, 'step "long"');
  assertStringIncludes(call.error!.message, 'job "build"');
  assertStringIncludes(call.error!.message, "method process");
  assertStringIncludes(call.error!.message, "slow");
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
    runId: "run-1",
    modelName: "slow",
    methodName: "process",
  });
  await bridge.finalize("aborted by user");

  assertStringIncludes(sink.calls[0].error!.message, "aborted by user");
  assertStringIncludes(sink.calls[0].error!.message, 'step "long"');
});

Deno.test("bridge finalize() is idempotent", async () => {
  const sink = new FakeSink();
  const bridge = new WorkflowTelemetryBridge(sink);

  await bridge.observe(STARTED_EVENT);
  await bridge.observe({
    kind: "method_executing",
    jobId: "j",
    stepId: "s",
    runId: "run-1",
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
    runId: "run-1",
    modelName: "m1",
    methodName: "do",
  });
  await first.observe({
    kind: "step_completed",
    jobId: "j1",
    stepId: "s1",
    runId: "run-1",
  });
  await first.finalize();

  assertEquals(sink.calls.length, 1);

  const second = new WorkflowTelemetryBridge(sink);
  await second.observe({
    kind: "started",
    runId: "run-2",
    workflowName: "etl",
    logPath: "/tmp/log",
    jobs: [],
  });
  await second.observe({
    kind: "method_executing",
    jobId: "j2",
    stepId: "s2",
    runId: "run-2",
    modelName: "m2",
    methodName: "go",
  });
  await second.observe({
    kind: "step_completed",
    jobId: "j2",
    stepId: "s2",
    runId: "run-2",
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
      runId: "run-1",
      modelName: "shell",
      methodName: "run",
    });
    await bridge.observe({
      kind: "step_completed",
      jobId: "fan",
      stepId,
      runId: "run-1",
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
    runId: "run-1",
    modelName: "shell",
    methodName: "run",
  });
  await bridge.observe({
    kind: "step_failed",
    jobId: "build",
    stepId: "optional",
    runId: "run-1",
    error: "exit 1",
    allowedFailure: true,
  });
  await bridge.finalize();

  assertEquals(sink.calls.length, 1);
  assertEquals(sink.calls[0].error?.message, "exit 1");
});

Deno.test("bridge records the executor dimension from step_completed (swamp-club#535)", async () => {
  const sink = new FakeSink();
  const bridge = new WorkflowTelemetryBridge(sink);

  await bridge.observe(STARTED_EVENT);
  await bridge.observe({
    kind: "method_executing",
    jobId: "build",
    stepId: "train",
    runId: "run-1",
    modelName: "gpu-model",
    methodName: "fit",
  });
  await bridge.observe({
    kind: "step_completed",
    jobId: "build",
    stepId: "train",
    runId: "run-1",
    executor: "gpu-box-1",
  });
  // A loopback step records "loopback"; an event without the field stays
  // absent (older serve relays).
  await bridge.observe({
    kind: "method_executing",
    jobId: "build",
    stepId: "local",
    runId: "run-1",
    modelName: "shell-step",
    methodName: "run",
  });
  await bridge.observe({
    kind: "step_completed",
    jobId: "build",
    stepId: "local",
    runId: "run-1",
    executor: "loopback",
  });
  await bridge.finalize();

  assertEquals(sink.calls.length, 2);
  assertEquals(sink.calls[0].workflowContext.executor, "gpu-box-1");
  assertEquals(sink.calls[1].workflowContext.executor, "loopback");
});

const NESTED_STARTED_EVENT: WorkflowExecutionEvent = {
  kind: "started",
  runId: "child-run",
  parentRunId: "run-1",
  workflowName: "provision",
  logPath: "/tmp/log",
  jobs: [],
};

const GRANDCHILD_STARTED_EVENT: WorkflowExecutionEvent = {
  kind: "started",
  runId: "grandchild-run",
  parentRunId: "child-run",
  workflowName: "network",
  logPath: "/tmp/log",
  jobs: [],
};

Deno.test("bridge attributes a parent step after nested workflows to the top-level run (swamp-club#2735)", async () => {
  const sink = new FakeSink();
  const bridge = new WorkflowTelemetryBridge(sink);

  await bridge.observe(STARTED_EVENT);
  // A workflow step runs a nested workflow, which runs its own nested
  // workflow; both forward their started events into this stream.
  await bridge.observe(NESTED_STARTED_EVENT);
  await bridge.observe(GRANDCHILD_STARTED_EVENT);
  await bridge.observe({
    kind: "step_completed",
    jobId: "deploy",
    stepId: "nested",
    runId: "run-1",
  });
  await bridge.observe({
    kind: "method_executing",
    jobId: "deploy",
    stepId: "after",
    runId: "run-1",
    modelName: "m",
    methodName: "run",
  });
  await bridge.observe({
    kind: "step_completed",
    jobId: "deploy",
    stepId: "after",
    runId: "run-1",
  });
  await bridge.finalize();

  assertEquals(sink.calls.length, 1);
  assertEquals(sink.calls[0].workflowContext, {
    workflowName: "deploy",
    runId: "run-1",
    jobName: "deploy",
    stepName: "after",
  });
});

Deno.test("bridge records nested workflow steps under the top-level run with their own job and step names", async () => {
  const sink = new FakeSink();
  const bridge = new WorkflowTelemetryBridge(sink);

  await bridge.observe(STARTED_EVENT);
  await bridge.observe(NESTED_STARTED_EVENT);
  await bridge.observe({
    kind: "method_executing",
    jobId: "vm",
    stepId: "create",
    runId: "child-run",
    modelName: "m1",
    methodName: "create",
  });
  await bridge.observe({
    kind: "step_completed",
    jobId: "vm",
    stepId: "create",
    runId: "child-run",
  });
  await bridge.observe(GRANDCHILD_STARTED_EVENT);
  await bridge.observe({
    kind: "method_executing",
    jobId: "net",
    stepId: "attach",
    runId: "grandchild-run",
    modelName: "m2",
    methodName: "attach",
  });
  await bridge.observe({
    kind: "step_completed",
    jobId: "net",
    stepId: "attach",
    runId: "grandchild-run",
  });
  await bridge.finalize();

  assertEquals(sink.calls.length, 2);
  assertEquals(sink.calls[0].workflowContext, {
    workflowName: "deploy",
    runId: "run-1",
    jobName: "vm",
    stepName: "create",
  });
  assertEquals(sink.calls[1].workflowContext, {
    workflowName: "deploy",
    runId: "run-1",
    jobName: "net",
    stepName: "attach",
  });
});

Deno.test("bridge attributes synthesized and finalize-drained entries after a nested workflow to the top-level run", async () => {
  const sink = new FakeSink();
  const bridge = new WorkflowTelemetryBridge(sink);

  await bridge.observe(STARTED_EVENT);
  await bridge.observe(NESTED_STARTED_EVENT);
  // Pre-method-executing failure — synthesized entry.
  await bridge.observe({
    kind: "step_failed",
    jobId: "vm",
    stepId: "lookup",
    runId: "child-run",
    error: "model not found: missing",
    modelName: "missing",
    methodName: "create",
  });
  // Never completes — drained by finalize().
  await bridge.observe({
    kind: "method_executing",
    jobId: "vm",
    stepId: "long",
    runId: "child-run",
    modelName: "slow",
    methodName: "process",
  });
  await bridge.finalize();

  assertEquals(sink.calls.length, 2);
  for (const call of sink.calls) {
    assertEquals(call.workflowContext.workflowName, "deploy");
    assertEquals(call.workflowContext.runId, "run-1");
  }
  assertEquals(sink.calls[0].workflowContext.stepName, "lookup");
  assertEquals(sink.calls[1].workflowContext.stepName, "long");
});

// A nested workflow step forwards its child's events into the parent's
// stream, and the child's job and step names can repeat those of a step
// running concurrently in the parent or in a sibling nested run. Each run's
// step records its own entry (swamp-club#2802).

function methodExecuting(
  runId: string,
  jobId: string,
  stepId: string,
  modelName: string,
  methodName: string,
): WorkflowExecutionEvent {
  return {
    kind: "method_executing",
    runId,
    jobId,
    stepId,
    modelName,
    methodName,
  };
}

function stepCompleted(
  runId: string,
  jobId: string,
  stepId: string,
): WorkflowExecutionEvent {
  return { kind: "step_completed", runId, jobId, stepId };
}

function nestedStarted(
  runId: string,
  parentRunId: string,
): WorkflowExecutionEvent {
  return {
    kind: "started",
    runId,
    parentRunId,
    workflowName: "child",
    logPath: "/tmp/log",
    jobs: [],
  };
}

Deno.test("bridge records a parent step and a concurrent same-named nested step separately (swamp-club#2802)", async () => {
  const sink = new FakeSink();
  const bridge = new WorkflowTelemetryBridge(sink);

  await bridge.observe(STARTED_EVENT);
  await bridge.observe({
    kind: "model_resolved",
    runId: "run-1",
    jobId: "main",
    stepId: "a",
    modelName: "slow",
    modelType: "command/shell",
    modelId: "slow-id",
    methodName: "execute",
  });
  await bridge.observe(
    methodExecuting("run-1", "main", "a", "slow", "execute"),
  );
  await bridge.observe(nestedStarted("child-run", "run-1"));
  await bridge.observe({
    kind: "model_resolved",
    runId: "child-run",
    jobId: "main",
    stepId: "a",
    modelName: "fast",
    modelType: "@swamp/echo",
    modelId: "fast-id",
    methodName: "ping",
  });
  await bridge.observe(
    methodExecuting("child-run", "main", "a", "fast", "ping"),
  );
  await bridge.observe(stepCompleted("child-run", "main", "a"));
  await bridge.observe(stepCompleted("run-1", "main", "b"));
  await bridge.observe(stepCompleted("run-1", "main", "a"));
  await bridge.finalize();

  assertEquals(sink.calls.length, 2);
  assertEquals(sink.calls[0].invocation.args, ["run", "fast", "ping"]);
  assertEquals(sink.calls[0].workflowContext.modelType, "@swamp/echo");
  assertEquals(sink.calls[1].invocation.args, ["run", "slow", "execute"]);
  assertEquals(sink.calls[1].workflowContext.modelType, "command/shell");
  for (const call of sink.calls) {
    assertEquals(call.error, null);
    assertEquals(call.workflowContext.runId, "run-1");
    assertEquals(call.workflowContext.jobName, "main");
    assertEquals(call.workflowContext.stepName, "a");
  }
});

Deno.test("bridge records same-named steps of two concurrent sibling nested runs separately (swamp-club#2802)", async () => {
  const sink = new FakeSink();
  const bridge = new WorkflowTelemetryBridge(sink);

  await bridge.observe(STARTED_EVENT);
  await bridge.observe(nestedStarted("child-1", "run-1"));
  await bridge.observe(nestedStarted("child-2", "run-1"));
  await bridge.observe(methodExecuting("child-1", "main", "a", "m1", "one"));
  await bridge.observe(methodExecuting("child-2", "main", "a", "m2", "two"));
  await bridge.observe(stepCompleted("child-1", "main", "a"));
  await bridge.observe(stepCompleted("child-2", "main", "a"));
  await bridge.finalize();

  assertEquals(
    sink.calls.map((c) => c.invocation.args[2]),
    ["one", "two"],
  );
  assertEquals(sink.calls.map((c) => c.error), [null, null]);
});

Deno.test("bridge records a nested step's failure without touching the parent's same-named in-flight step (swamp-club#2802)", async () => {
  const sink = new FakeSink();
  const bridge = new WorkflowTelemetryBridge(sink);

  await bridge.observe(STARTED_EVENT);
  await bridge.observe(
    methodExecuting("run-1", "main", "a", "slow", "execute"),
  );
  await bridge.observe(nestedStarted("child-run", "run-1"));
  await bridge.observe(
    methodExecuting("child-run", "main", "a", "fast", "ping"),
  );
  await bridge.observe({
    kind: "step_failed",
    runId: "child-run",
    jobId: "main",
    stepId: "a",
    error: "ping failed",
  });
  await bridge.observe(stepCompleted("run-1", "main", "a"));
  await bridge.finalize();

  assertEquals(sink.calls.length, 2);
  assertEquals(sink.calls[0].invocation.args[2], "ping");
  assertEquals(sink.calls[0].error?.message, "ping failed");
  assertEquals(sink.calls[1].invocation.args[2], "execute");
  assertEquals(sink.calls[1].error, null);
});

Deno.test("bridge finalize() drains same-named in-flight steps of different runs as separate entries (swamp-club#2802)", async () => {
  const sink = new FakeSink();
  const bridge = new WorkflowTelemetryBridge(sink);

  await bridge.observe(STARTED_EVENT);
  await bridge.observe(
    methodExecuting("run-1", "main", "a", "slow", "execute"),
  );
  await bridge.observe(nestedStarted("child-run", "run-1"));
  await bridge.observe(
    methodExecuting("child-run", "main", "a", "fast", "ping"),
  );
  await bridge.finalize("aborted by user");

  assertEquals(sink.calls.length, 2);
  for (const call of sink.calls) {
    assertStringIncludes(call.error!.message, "aborted by user");
    assertStringIncludes(call.error!.message, 'step "a" in job "main"');
    assertEquals(call.workflowContext.jobName, "main");
    assertEquals(call.workflowContext.stepName, "a");
  }
  assertEquals(
    sink.calls.map((c) => c.invocation.args[2]).sort(),
    ["execute", "ping"],
  );
});

Deno.test("bridge gives a pre-method-executing failure its own run's modelType (swamp-club#2802)", async () => {
  const sink = new FakeSink();
  const bridge = new WorkflowTelemetryBridge(sink);

  await bridge.observe(STARTED_EVENT);
  await bridge.observe({
    kind: "model_resolved",
    runId: "run-1",
    jobId: "main",
    stepId: "a",
    modelName: "slow",
    modelType: "command/shell",
    modelId: "slow-id",
    methodName: "execute",
  });
  await bridge.observe(nestedStarted("child-run", "run-1"));
  await bridge.observe({
    kind: "model_resolved",
    runId: "child-run",
    jobId: "main",
    stepId: "a",
    modelName: "fast",
    modelType: "@swamp/echo",
    modelId: "fast-id",
    methodName: "ping",
  });
  await bridge.observe({
    kind: "step_failed",
    runId: "run-1",
    jobId: "main",
    stepId: "a",
    error: "vault expression failed",
    modelName: "slow",
    methodName: "execute",
  });
  await bridge.finalize();

  assertEquals(sink.calls.length, 1);
  assertEquals(sink.calls[0].workflowContext.modelType, "command/shell");
});

Deno.test("bridge finalize() names a job whose name contains a colon", async () => {
  const sink = new FakeSink();
  const bridge = new WorkflowTelemetryBridge(sink);

  await bridge.observe(STARTED_EVENT);
  await bridge.observe(
    methodExecuting("run-1", "deploy:prod", "apply", "infra", "apply"),
  );
  await bridge.finalize();

  assertEquals(sink.calls.length, 1);
  assertStringIncludes(
    sink.calls[0].error!.message,
    'step "apply" in job "deploy:prod"',
  );
  assertEquals(sink.calls[0].workflowContext.jobName, "deploy:prod");
  assertEquals(sink.calls[0].workflowContext.stepName, "apply");
});

Deno.test("bridge marks the step's errorPaths on the error it records", async () => {
  const sink = new FakeSink();
  const bridge = new WorkflowTelemetryBridge(sink);
  const path = "/srv/acme/final report";

  await bridge.observe(STARTED_EVENT);
  await bridge.observe({
    kind: "method_executing",
    jobId: "build",
    stepId: "transform",
    runId: "run-1",
    modelName: "etl",
    methodName: "transform",
  });
  await bridge.observe({
    kind: "step_failed",
    jobId: "build",
    stepId: "transform",
    runId: "run-1",
    error: `cannot read ${path}`,
    errorPaths: [path],
  });
  await bridge.observe({
    kind: "step_failed",
    jobId: "lookup",
    stepId: "fetch",
    runId: "run-1",
    error: `cannot read ${path}`,
    modelName: "missing",
    methodName: "enrich",
    errorPaths: [path],
  });
  await bridge.finalize();

  assertEquals(sink.calls.length, 2);
  assertEquals(errorPaths(sink.calls[0].error), [path]);
  assertEquals(errorPaths(sink.calls[1].error), [path]);
});
