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
  ServeEventFields,
  WorkflowTriggerSource,
} from "../domain/telemetry/mod.ts";
import { getActiveTelemetryService } from "../cli/telemetry_integration.ts";
import { telemetryClientOf } from "../domain/access/client.ts";
import { concealedModelLabel } from "../domain/telemetry/concealed_models.ts";
import { UserError } from "../domain/errors.ts";

export interface RunTelemetry {
  readonly sink: WorkflowTelemetrySink;
  finish(error: Error | null): Promise<void>;
}

/** who asked serve for something; delegation ids are never part of it */
export interface ServeTelemetryCaller {
  readonly initiatedBy?: string;
  readonly client?: string;
}

let serveCollectivesSource: () => readonly string[] = () => [];

/** read at each event, since a reload changes serve's collectives */
export function setServeCollectivesSource(
  source: () => readonly string[],
): () => void {
  const previous = serveCollectivesSource;
  serveCollectivesSource = source;
  return () => {
    serveCollectivesSource = previous;
  };
}

function serveFieldsFor(client: string | undefined): ServeEventFields {
  const collectives = serveCollectivesSource();
  return {
    ...telemetryClientOf(client),
    ...(collectives.length > 0 ? { serveCollectives: [...collectives] } : {}),
  };
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
  /**
   * the behavior's type, once known: an integration's or group's name is
   * replaced by its type and its error messages are not sent
   */
  resolveType(modelType: string | undefined): void;
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
  caller: ServeTelemetryCaller = {},
  startedAt: Date = new Date(),
): CommandTelemetry | undefined {
  const service = getActiveTelemetryService();
  if (!service) return undefined;

  const runService = service.forkForRun(
    "api",
    caller.initiatedBy,
    serveFieldsFor(caller.client),
  );
  let label = concealedModelLabel(undefined, target.modelName);

  return {
    resolveType: (modelType) => {
      label = concealedModelLabel(modelType, target.modelName);
    },
    finish: async (error: Error | null): Promise<void> => {
      const invocation = buildMethodRunInvocation(
        label ?? target.modelName,
        target.methodName,
      );
      if (!error) {
        await runService.recordSuccess(invocation, startedAt);
      } else if (label !== undefined) {
        // these methods name the integration or group in their messages
        await runService.recordOutcome(invocation, startedAt, {
          status: error instanceof UserError ? "user_error" : "error",
          errorType: error.constructor.name,
        });
      } else {
        await runService.recordError(invocation, startedAt, error);
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
  options?: { initiatedBy?: string; client?: string; startedAt?: Date },
): RunTelemetry | undefined {
  const service = getActiveTelemetryService();
  if (!service) return undefined;

  const startedAt = options?.startedAt ?? new Date();
  const runService = service.forkForRun(
    triggerSource,
    options?.initiatedBy,
    serveFieldsFor(options?.client),
  );

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

export type ControlAction =
  | "approve"
  | "reject"
  | "resume"
  | "signal"
  | "cancel"
  | "method cancel"
  | "cancel all";

export type ControlOutcome =
  | { readonly status: "success"; readonly cancelledCount?: number }
  | {
    readonly status: "user_error" | "error";
    /** a serve error code, never a message */
    readonly errorType: string;
    readonly cancelledCount?: number;
  };

export interface ControlTelemetry {
  /** only the first outcome is recorded */
  finish(outcome: ControlOutcome): Promise<void>;
  /** the request went to another node, which records it */
  discard(): void;
}

/** run ids and workflow names are not sent: the action and outcome are */
function buildControlInvocation(action: ControlAction): CommandInvocationData {
  const commandPath = action === "method cancel"
    ? ["model", "method", "cancel"]
    : action === "cancel all"
    ? ["cancel", "all"]
    : ["workflow", action];
  return {
    command: commandPath[0],
    subcommand: commandPath.slice(1).join(" "),
    args: [],
    optionKeys: [],
    globalOptions: [],
    commandPath,
  };
}

export function createControlTelemetry(
  action: ControlAction,
  caller: ServeTelemetryCaller,
  startedAt: Date = new Date(),
): ControlTelemetry {
  const service = getActiveTelemetryService();
  let done = service === undefined;
  return {
    finish: async (outcome: ControlOutcome): Promise<void> => {
      if (done || !service) return;
      done = true;
      await service
        .forkForRun("api", caller.initiatedBy, serveFieldsFor(caller.client))
        .recordOutcome(buildControlInvocation(action), startedAt, outcome);
    },
    discard: () => {
      done = true;
    },
  };
}
