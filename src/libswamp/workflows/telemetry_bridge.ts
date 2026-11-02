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

import { markErrorPaths } from "../../domain/errors.ts";
import type { CommandInvocationData } from "../../domain/telemetry/command_invocation.ts";
import type { WorkflowContextData } from "../../domain/telemetry/workflow_context.ts";
import type { WorkflowExecutionEvent } from "../../domain/workflows/execution_service.ts";
import type { WorkflowTelemetrySink } from "./run.ts";

/**
 * model and method names are not sensitive and are sent as-is; the shape
 * matches a direct `swamp model method run <name> <method>` invocation
 */
export function buildChildInvocation(
  modelName: string,
  methodName: string,
): CommandInvocationData {
  return {
    command: "model",
    subcommand: "method",
    args: ["run", modelName, methodName],
    optionKeys: [],
    globalOptions: [],
    commandPath: ["model", "method", "run"],
  };
}

interface InFlightMethodInvocation {
  jobId: string;
  stepId: string;
  startedAt: Date;
  modelName: string;
  methodName: string;
  modelType?: string;
}

/**
 * a step is keyed by its owning run as well as job and step names, since nested
 * runs forward events into the same stream with repeating names; the run id is
 * on the domain event only
 */
export class WorkflowTelemetryBridge {
  private readonly inFlight = new Map<string, InFlightMethodInvocation>();
  /**
   * Captured from the top-level run's `started` event so workflowContext can
   * populate runId/workflowName. Nested workflows, at any depth, are
   * attributed to the top-level run.
   */
  private workflowName = "";
  private runId = "";
  private readonly modelTypeByStep = new Map<string, string>();
  private finalized = false;

  constructor(private readonly sink: WorkflowTelemetrySink) {}

  /**
   * calling twice with the same event double-records, so invoke once per event;
   * awaits the sink write so ordering holds before the next event
   */
  async observe(event: WorkflowExecutionEvent): Promise<void> {
    if (this.finalized) return;

    switch (event.kind) {
      case "started": {
        // A nested workflow step forwards its child's started event into
        // this stream; keep attributing to the top-level run.
        if (event.parentRunId !== undefined) return;
        this.workflowName = event.workflowName;
        this.runId = event.runId;
        return;
      }
      case "model_resolved": {
        const key = stepKey(event.runId, event.jobId, event.stepId);
        this.modelTypeByStep.set(key, event.modelType);
        return;
      }
      case "method_executing": {
        const key = stepKey(event.runId, event.jobId, event.stepId);
        this.inFlight.set(key, {
          jobId: event.jobId,
          stepId: event.stepId,
          startedAt: new Date(),
          modelName: event.modelName,
          methodName: event.methodName,
          modelType: this.modelTypeByStep.get(key),
        });
        return;
      }
      case "step_completed": {
        const key = stepKey(event.runId, event.jobId, event.stepId);
        const tracked = this.inFlight.get(key);
        if (!tracked) return;
        this.inFlight.delete(key);
        await this.sink.recordChildInvocation(
          buildChildInvocation(tracked.modelName, tracked.methodName),
          tracked.startedAt,
          new Date(),
          null,
          this.sink.parentInvocationId,
          this.buildWorkflowContext(
            event.jobId,
            event.stepId,
            tracked,
            event.executor,
          ),
        );
        return;
      }
      case "step_failed": {
        const key = stepKey(event.runId, event.jobId, event.stepId);
        const tracked = this.inFlight.get(key);

        if (tracked) {
          this.inFlight.delete(key);
          await this.sink.recordChildInvocation(
            buildChildInvocation(tracked.modelName, tracked.methodName),
            tracked.startedAt,
            new Date(),
            markErrorPaths(new Error(event.error), event.errorPaths ?? []),
            this.sink.parentInvocationId,
            this.buildWorkflowContext(event.jobId, event.stepId, tracked),
          );
          return;
        }

        // no method_executing was yielded, so this is a pre-method failure; the
        // domain sets modelName and methodName for model-method tasks, and when
        // absent the failure is structural and nothing is emitted
        if (!event.modelName || !event.methodName) return;
        const synthesized: InFlightMethodInvocation = {
          jobId: event.jobId,
          stepId: event.stepId,
          startedAt: new Date(0),
          modelName: event.modelName,
          methodName: event.methodName,
          modelType: this.modelTypeByStep.get(key),
        };
        const sameInstant = new Date();
        await this.sink.recordChildInvocation(
          buildChildInvocation(event.modelName, event.methodName),
          sameInstant,
          sameInstant,
          markErrorPaths(new Error(event.error), event.errorPaths ?? []),
          this.sink.parentInvocationId,
          this.buildWorkflowContext(event.jobId, event.stepId, synthesized),
        );
        return;
      }
    }
  }

  /**
   * call from the generator's finally so cancelled or thrown runs don't lose
   * telemetry for methods that never received a terminal event; only the first
   * call drains
   */
  async finalize(reason?: string): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;

    const now = new Date();
    const baseReason = reason ?? "workflow run terminated before completion";
    const drained = Array.from(this.inFlight.values());
    this.inFlight.clear();

    for (const tracked of drained) {
      const { jobId, stepId } = tracked;
      const elapsed = now.getTime() - tracked.startedAt.getTime();
      const elapsedStr = elapsed >= 1000
        ? `${(elapsed / 1000).toFixed(1)}s`
        : `${elapsed}ms`;
      const errorMessage =
        `${baseReason}: step "${stepId}" in job "${jobId}" ` +
        `(method ${tracked.methodName} on ${tracked.modelName}, ` +
        `running for ${elapsedStr})`;
      await this.sink.recordChildInvocation(
        buildChildInvocation(tracked.modelName, tracked.methodName),
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
    executor?: string,
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
    if (executor !== undefined) {
      ctx.executor = executor;
    }
    return ctx;
  }
}

/**
 * Identity of a step within the event stream: the run that owns it plus its
 * job and step names. JSON-encoded because job and step names may contain
 * any character, so a delimiter-joined key could collide.
 */
function stepKey(runId: string, jobId: string, stepId: string): string {
  return JSON.stringify([runId, jobId, stepId]);
}
