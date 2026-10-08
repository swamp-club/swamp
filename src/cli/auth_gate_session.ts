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
 * What the auth gate decided for this invocation, for the commands that act
 * on it after it ran: `serve` hands its pass to the workers it enrolls, and
 * a `worker connect` without a credential is admitted at enrollment
 * (design/surfaces/auth-gate.md, "Remote workers"). runCli sets it once the
 * gate has run and clears it when the invocation ends.
 */

import { NESTED_GATE_PASS_ENV } from "../domain/auth/nested_gate_pass.ts";
import {
  admitOrchestratorPass,
  type AuthGateDeps,
  type AuthGateOutcome,
  type GateHandoff,
  nestedGatePassValue,
  orchestratorBlockedError,
} from "./auth_gate.ts";
import { getActiveTelemetryService } from "./telemetry_integration.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["auth", "gate"]);

export interface AuthGateSession {
  readonly deps: AuthGateDeps;
  /** The gate's outcome; a block only when admission is deferred. */
  readonly outcome: AuthGateOutcome;
  /** When the gate ran, in Unix seconds. */
  readonly gateTime: number;
  /**
   * True for a `worker connect` with no credential: the gate's
   * `no_credential` block waits for the orchestrator's pass.
   */
  readonly deferred: boolean;
}

let session: AuthGateSession | undefined;

export function beginAuthGateSession(value: AuthGateSession): void {
  session = value;
}

export function endAuthGateSession(): void {
  session = undefined;
}

export function currentAuthGateSession(): AuthGateSession | undefined {
  return session;
}

/**
 * Hand this run's pass down to any swamp it starts (design/surfaces/
 * auth-gate.md, "Nested runs"), through the process env as
 * SWAMP_LOCK_HOLDER_PID is (see `nestedGatePassValue`). A run with nothing
 * to hand down clears any pass it inherited. Set once per process: when the
 * gate passes, or for a worker without a credential, when its orchestrator
 * admits it.
 */
export function publishNestedGatePass(handoff: GateHandoff | undefined): void {
  const value = nestedGatePassValue(handoff, Deno.pid);
  if (value) {
    Deno.env.set(NESTED_GATE_PASS_ENV, value);
  } else {
    Deno.env.delete(NESTED_GATE_PASS_ENV);
  }
}

/**
 * For a `worker connect` whose gate was deferred, the check it runs on the
 * pass its orchestrator sent at enrollment: it throws the gate's block
 * error, or records the run as verified and publishes the worker's own
 * nested pass for the dispatch runners it starts. Undefined when the gate
 * was not deferred: the worker passed on its own credential. Call it from
 * the command's action, after runCli has begun the session.
 */
export function deferredWorkerAdmission(
  publish: (handoff: GateHandoff) => void = publishNestedGatePass,
):
  | ((passValue: string | undefined, serveRefused?: boolean) => Promise<void>)
  | undefined {
  const current = session;
  if (!current?.deferred) return undefined;
  return async (passValue, serveRefused) => {
    const admission = await admitOrchestratorPass(
      current.deps.verificationRepo,
      passValue,
      current.gateTime,
      serveRefused,
    );
    if (admission.kind === "block") {
      throw orchestratorBlockedError(admission.cause, admission.detail);
    }
    getActiveTelemetryService()?.setAuthMode("verified");
    publish(admission.handoff);
    logger.info("Passed the auth gate on the orchestrator's pass");
  };
}
