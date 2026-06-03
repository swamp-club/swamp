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

import type { CommandInvocationData } from "../../domain/telemetry/command_invocation.ts";
import type { WorkflowContextData } from "../../domain/telemetry/workflow_context.ts";
import type { WorkflowRunEvent, WorkflowTelemetrySink } from "./run.ts";

/**
 * Build the CommandInvocationData for a workflow-internal method
 * invocation. Shape matches what `extractCommandInfo` would produce for a
 * direct `swamp model method run <name> <method>` invocation, with the
 * same redactions per ARG_SCHEMAS["model method"] = ["categorical",
 * "redact", "categorical"]:
 *   - args[0] = "run" (categorical, kept verbatim)
 *   - args[1] = "<REDACTED>" (model name is user-identifiable)
 *   - args[2] = methodName (categorical, kept verbatim)
 */
export function buildChildInvocation(
  methodName: string,
): CommandInvocationData {
  return {
    command: "model",
    subcommand: "method",
    args: ["run", "<REDACTED>", methodName],
    optionKeys: [],
    globalOptions: [],
  };
}

/**
 * Internal tracking record for a method invocation that has started but
 * not yet completed. Held by WorkflowTelemetryBridge while events are
 * still arriving for the (jobId, stepId) pair.
 */
interface InFlightMethodInvocation {
  startedAt: Date;
  modelName: string;
  methodName: string;
  modelType?: string;
  driver?: string;
}

/**
 * Bridges WorkflowRunEvents to per-method-invocation telemetry. Tracks
 * in-flight invocations between `method_executing` and the matching
 * `step_completed`/`step_failed` events; on stream termination,
 * finalizes any unfinished invocations as errors via {@link finalize}.
 *
 * Ownership model: one bridge instance per workflow stream consumption.
 * Re-using a bridge across runs would leak state. The libswamp
 * `workflowRun` generator constructs a fresh bridge inside its
 * try/finally and discards it on exit.
 */
export class WorkflowTelemetryBridge {
  /** Key shape: `${jobId}:${stepId}` */
  private readonly inFlight = new Map<string, InFlightMethodInvocation>();
  /** Captured from the `started` event so workflowContext can populate runId/workflowName. */
  private workflowName = "";
  private runId = "";
  /** Captured from `model_resolved` so workflowContext can carry modelType. */
  private readonly modelTypeByStep = new Map<string, string>();
  /** Set true after finalize() runs, so observe() becomes a no-op. */
  private finalized = false;

  constructor(private readonly sink: WorkflowTelemetrySink) {}

  /**
   * Observe one event from the workflow run stream. Idempotent — calling
   * with the same event twice would double-record, so callers must invoke
   * once per event.
   *
   * Returns void; awaits internally for `recordChildInvocation` so the
   * caller's stream loop awaits the write before yielding the next event
   * (matters for ordering guarantees in tests).
   */
  async observe(event: WorkflowRunEvent): Promise<void> {
    if (this.finalized) return;

    switch (event.kind) {
      case "started": {
        this.workflowName = event.workflowName;
        this.runId = event.runId;
        return;
      }
      case "model_resolved": {
        const key = stepKey(event.jobId, event.stepId);
        this.modelTypeByStep.set(key, event.modelType);
        return;
      }
      case "method_executing": {
        const key = stepKey(event.jobId, event.stepId);
        this.inFlight.set(key, {
          startedAt: new Date(),
          modelName: event.modelName,
          methodName: event.methodName,
          modelType: this.modelTypeByStep.get(key),
          driver: event.driver,
        });
        return;
      }
      case "step_completed": {
        const key = stepKey(event.jobId, event.stepId);
        const tracked = this.inFlight.get(key);
        if (!tracked) return; // workflow_task step or non-method step
        this.inFlight.delete(key);
        await this.sink.recordChildInvocation(
          buildChildInvocation(tracked.methodName),
          tracked.startedAt,
          new Date(),
          null,
          this.sink.parentInvocationId,
          this.buildWorkflowContext(event.jobId, event.stepId, tracked),
        );
        return;
      }
      case "step_failed": {
        const key = stepKey(event.jobId, event.stepId);
        const tracked = this.inFlight.get(key);

        if (tracked) {
          // Method had started; record an error child entry with the
          // actual duration from method_executing → step_failed.
          this.inFlight.delete(key);
          await this.sink.recordChildInvocation(
            buildChildInvocation(tracked.methodName),
            tracked.startedAt,
            new Date(),
            new Error(event.error),
            this.sink.parentInvocationId,
            this.buildWorkflowContext(event.jobId, event.stepId, tracked),
          );
          return;
        }

        // No method_executing was yielded — this is a pre-method-executing
        // failure (model lookup, vary-key validation, vault expression
        // resolution, etc.). The domain layer populates modelName /
        // methodName / driver on step_failed for model-method tasks; if
        // those are absent the failure is structural (workflow-task,
        // nesting-depth, cycle) and we skip emission.
        if (!event.modelName || !event.methodName) return;
        const synthesized: InFlightMethodInvocation = {
          startedAt: new Date(0), // placeholder, overwritten below
          modelName: event.modelName,
          methodName: event.methodName,
          modelType: this.modelTypeByStep.get(key),
          driver: event.driver,
        };
        const sameInstant = new Date();
        await this.sink.recordChildInvocation(
          buildChildInvocation(event.methodName),
          sameInstant,
          sameInstant,
          new Error(event.error),
          this.sink.parentInvocationId,
          this.buildWorkflowContext(event.jobId, event.stepId, synthesized),
        );
        return;
      }
    }
  }

  /**
   * Drain any in-flight invocations as error entries. Call from the
   * libswamp generator's `finally` block so cancelled / thrown / aborted
   * runs don't silently lose telemetry for methods that started but
   * never received a terminal event.
   *
   * Safe to call multiple times; only the first call drains.
   */
  async finalize(reason?: string): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;

    const now = new Date();
    const errorMessage = reason ?? "workflow run terminated before completion";
    const drained = Array.from(this.inFlight.entries());
    this.inFlight.clear();

    for (const [key, tracked] of drained) {
      const [jobId, stepId] = key.split(":");
      await this.sink.recordChildInvocation(
        buildChildInvocation(tracked.methodName),
        tracked.startedAt,
        now,
        new Error(errorMessage),
        this.sink.parentInvocationId,
        this.buildWorkflowContext(jobId, stepId, tracked),
      );
    }
  }

  private buildWorkflowContext(
    jobId: string,
    stepId: string,
    tracked: InFlightMethodInvocation,
  ): WorkflowContextData {
    const ctx: WorkflowContextData = {
      workflowName: this.workflowName,
      runId: this.runId,
      jobName: jobId,
      stepName: stepId,
    };
    if (tracked.modelType !== undefined) {
      ctx.modelType = tracked.modelType;
    }
    if (tracked.driver !== undefined) {
      ctx.driver = tracked.driver;
    }
    return ctx;
  }
}

function stepKey(jobId: string, stepId: string): string {
  return `${jobId}:${stepId}`;
}
