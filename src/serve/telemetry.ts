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

import type { WorkflowTelemetrySink } from "../libswamp/workflows/run.ts";
import type {
  CommandInvocationData,
  WorkflowTriggerSource,
} from "../domain/telemetry/mod.ts";
import { getActiveTelemetryService } from "../cli/telemetry_integration.ts";

export interface RunTelemetry {
  readonly sink: WorkflowTelemetrySink;
  finish(error: Error | null): Promise<void>;
}

/** the workflow name is sent as-is, as the interactive CLI does */
function buildRunInvocation(workflowName: string): CommandInvocationData {
  return {
    command: "workflow",
    subcommand: "run",
    args: [workflowName],
    optionKeys: [],
    globalOptions: [],
    commandPath: ["workflow", "run"],
  };
}

export interface CommandTelemetry {
  finish(error: Error | null): Promise<void>;
}

/** subcommand keeps the value "method run" so server-side keys do not move */
function buildMethodRunInvocation(
  modelName: string,
  methodName: string,
): CommandInvocationData {
  return {
    command: "model",
    subcommand: "method run",
    args: [modelName, methodName],
    optionKeys: [],
    globalOptions: [],
    commandPath: ["model", "method", "run"],
  };
}

export function createCommandTelemetry(
  target: { modelName: string; methodName: string },
  initiatedBy?: string,
  startedAt: Date = new Date(),
): CommandTelemetry | undefined {
  const service = getActiveTelemetryService();
  if (!service) return undefined;

  const runService = service.forkForRun("api", initiatedBy);

  return {
    finish: async (error: Error | null): Promise<void> => {
      if (error) {
        await runService.recordError(
          buildMethodRunInvocation(target.modelName, target.methodName),
          startedAt,
          error,
        );
      } else {
        await runService.recordSuccess(
          buildMethodRunInvocation(target.modelName, target.methodName),
          startedAt,
        );
      }
    },
  };
}

/**
 * each run gets its own forked service so child invocations parent to a per-run
 * identity; the daemon's process invocation is not written until serve exits.
 * With telemetry disabled serve stays silent
 */
export function createRunTelemetry(
  triggerSource: WorkflowTriggerSource,
  workflowName: string,
  options?: { initiatedBy?: string; startedAt?: Date },
): RunTelemetry | undefined {
  const service = getActiveTelemetryService();
  if (!service) return undefined;

  const startedAt = options?.startedAt ?? new Date();
  const runService = service.forkForRun(triggerSource, options?.initiatedBy);

  return {
    sink: {
      parentInvocationId: runService.invocationId,
      recordChildInvocation: runService.recordChildInvocation.bind(runService),
    },
    finish: async (error: Error | null): Promise<void> => {
      if (error) {
        await runService.recordError(
          buildRunInvocation(workflowName),
          startedAt,
          error,
        );
      } else {
        await runService.recordSuccess(
          buildRunInvocation(workflowName),
          startedAt,
        );
      }
    },
  };
}
