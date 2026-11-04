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
 * serve hands its pass to enrolled workers, and a credential-less worker
 * connect is admitted at enrollment; runCli sets this after the gate runs and
 * clears it at the end
 */

import {
  admitOrchestratorPass,
  type AuthGateDeps,
  type AuthGateOutcome,
  type GateHandoff,
  orchestratorBlockedError,
  publishNestedGatePass,
} from "./auth_gate.ts";
import { getActiveTelemetryService } from "./telemetry_integration.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["auth", "gate"]);

export interface AuthGateSession {
  readonly deps: AuthGateDeps;
  readonly outcome: AuthGateOutcome;
  readonly gateTime: number;
  /**
   * True for a `worker connect` with no credential: the gate's
   * `no_credential` block waits for the orchestrator's pass.
   */
  readonly deferred: boolean;
}

export { publishNestedGatePass } from "../libswamp/auth/gate.ts";

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
 * checks the pass an orchestrator sent: throws the gate's block error, or
 * records the run as verified and publishes the worker's own pass; undefined
 * when not deferred. Call after runCli begins
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
