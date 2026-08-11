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
 * Telemetry for workflow runs that `swamp serve` executes on its own —
 * scheduled fires, verified webhooks, and API/WebSocket requests.
 *
 * The interactive `swamp workflow run` command binds the active
 * TelemetryService as a sink so each method invocation inside the run is
 * recorded (see cli/commands/workflow_run.ts). Serve never did, so every
 * run it executed was invisible: no parent entry, no child entries, nothing
 * to flush. This is the serve-side counterpart of that binding.
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
 * @param startedAt - When the run began; defaults to now
 */
export function createRunTelemetry(
  triggerSource: WorkflowTriggerSource,
  startedAt: Date = new Date(),
): RunTelemetry | undefined {
  const service = getActiveTelemetryService();
  if (!service) return undefined;

  const runService = service.forkForRun(triggerSource);

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
