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

/**
 * Telemetry for runs that `swamp serve` executes — scheduled fires, verified
 * webhooks, and API/WebSocket requests for both workflow and model method runs.
 *
 * The interactive CLI commands bind the active TelemetryService as a sink so
 * each invocation is recorded. Serve never did, so every run it executed was
 * invisible. This is the serve-side counterpart of that binding.
 */

import type { WorkflowTelemetrySink } from "../libswamp/mod.ts";
import type {
  CommandInvocationData,
  WorkflowTriggerSource,
} from "../domain/telemetry/mod.ts";
import { getActiveTelemetryService } from "../cli/telemetry_integration.ts";

/**
 * Telemetry scoped to a single serve-executed workflow run.
 */
export interface RunTelemetry {
  /** Passed to libswamp so per-method child invocations are recorded. */
  readonly sink: WorkflowTelemetrySink;
  /**
   * Records the run's own parent entry. Call exactly once, when the run
   * settles.
   *
   * @param error - The error that ended the run, or null if it succeeded
   */
  finish(error: Error | null): Promise<void>;
}

/**
 * The parent entry for a serve-executed run, shaped like the interactive
 * `swamp workflow run` invocation it stands in for.
 *
 * The workflow name is redacted, matching the default sensitivity the CLI
 * applies to positional arguments — serve-side entries are generated with no
 * human present, so redaction cannot be reviewed at authoring time and the
 * conservative default is the right one. The name still reaches telemetry via
 * the child entries' `workflowContext`, exactly as it does for interactive
 * runs.
 */
function buildRunInvocation(): CommandInvocationData {
  return {
    command: "workflow",
    subcommand: "run",
    args: ["<REDACTED>"],
    optionKeys: [],
    globalOptions: [],
  };
}

/**
 * Telemetry scoped to a single serve-executed command (model method run).
 */
export interface CommandTelemetry {
  finish(error: Error | null): Promise<void>;
}

function buildMethodRunInvocation(): CommandInvocationData {
  return {
    command: "model",
    subcommand: "method run",
    args: ["<REDACTED>", "<REDACTED>"],
    optionKeys: [],
    globalOptions: [],
  };
}

/**
 * Creates telemetry for one serve-executed model method run, or `undefined`
 * when telemetry is disabled.
 *
 * @param initiatedBy - The principal who triggered this run
 * @param startedAt - When the run began; defaults to now
 */
export function createCommandTelemetry(
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
          buildMethodRunInvocation(),
          startedAt,
          error,
        );
      } else {
        await runService.recordSuccess(buildMethodRunInvocation(), startedAt);
      }
    },
  };
}

/**
 * Creates telemetry for one serve-executed workflow run, or `undefined` when
 * telemetry is disabled for this process — `--no-telemetry`, the repo
 * marker's `telemetryDisabled`, the user-level opt-out, or an initialization
 * failure all leave no active service, and serve must then stay exactly as
 * silent as it was before.
 *
 * Each run gets its own forked service so it can parent its child method
 * invocations to a per-run identity. Hanging them off the daemon's own
 * process invocation instead would leave every child pointing at an entry
 * that is not written until serve exits — possibly weeks later.
 *
 * @param triggerSource - What caused this run (schedule, webhook, or api)
 * @param options - Optional initiatedBy and startedAt overrides
 */
export function createRunTelemetry(
  triggerSource: WorkflowTriggerSource,
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
        await runService.recordError(buildRunInvocation(), startedAt, error);
      } else {
        await runService.recordSuccess(buildRunInvocation(), startedAt);
      }
    },
  };
}
