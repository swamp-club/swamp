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

import { createAuthGateDeps as createSharedAuthGateDeps } from "../libswamp/auth/gate.ts";
import { loadIdentity } from "./load_identity.ts";

export {
  admitOrchestratorPass,
  type AncestorCheck,
  authGateBlockedError,
  type AuthGateCredential,
  type AuthGateDeps,
  type AuthGateOutcome,
  BLOCKING_CHECK_TIMEOUT_MS,
  blockMessage,
  createGatePassKeeper,
  GATE_PASS_KEEPER_INTERVAL_MS,
  type GateHandoff,
  type GatePassKeeper,
  type NestedGateDeps,
  nestedGatePassValue,
  type OrchestratorAdmission,
  type OrchestratorBlockCause,
  orchestratorBlockedError,
  type ProofRefreshResult,
  publishNestedGatePass,
  runAuthGate,
  runProofRefresh,
  SHORT_CHECK_TIMEOUT_MS,
} from "../libswamp/auth/gate.ts";

/** CLI composition keeps the existing versioned identity loader. */
export function createAuthGateDeps(
  options: { liveChecks: boolean; canWrite: boolean },
) {
  return createSharedAuthGateDeps(options, loadIdentity);
}
