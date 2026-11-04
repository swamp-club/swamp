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

import { UserError } from "../domain/errors.ts";
import { loadClientIdentity } from "../infrastructure/http/load_client_identity.ts";
import type { ClientIdentity } from "../infrastructure/http/client_identity.ts";
import { processOwnsConfigDir } from "../infrastructure/persistence/config_dir_ownership.ts";
import { resolveAccountAuthentication } from "../libswamp/auth/account.ts";
import {
  requireAuthenticated,
  requireScope,
} from "../libswamp/auth/context.ts";
import {
  type AuthGateDeps,
  type AuthGateOutcome,
  blockMessage,
  createAuthGateDeps,
  runAuthGate,
} from "../libswamp/auth/gate.ts";

/** Only admission errors constructed here may cross the private startup RPC. */
export class EngineOperatorAuthError extends UserError {
  declare readonly code: string;

  constructor(message: string, code: string) {
    super(message, code);
  }
}

export interface EngineOperatorAuthDeps {
  gate: AuthGateDeps;
  canWrite: boolean;
  loadIdentity: () => Promise<ClientIdentity>;
}

/** Keep the shared best-effort refresh inside the runtime's total disposal budget. */
export async function disposeEngineWithOperatorRefresh(
  dispose: () => Promise<void>,
  admission: Extract<AuthGateOutcome, { kind: "pass" }>,
): Promise<void> {
  await dispose();
  try {
    await admission.refresh?.();
  } catch {
    // As in ordinary serve, a failed refresh is retried on the next invocation.
  }
}

function createOperatorAuthDeps(version: string): EngineOperatorAuthDeps {
  const canWrite = processOwnsConfigDir();
  const loadIdentity = () => loadClientIdentity(`swamp-cli/${version}`);
  return {
    gate: createAuthGateDeps({ liveChecks: true, canWrite }, loadIdentity),
    canWrite,
    loadIdentity,
  };
}

/** Run the ordinary CLI account gate and token-serve scope checks before loading extensions. */
export async function admitEngineOperator(
  version: string,
  deps: EngineOperatorAuthDeps = createOperatorAuthDeps(version),
): Promise<Extract<AuthGateOutcome, { kind: "pass" }>> {
  let outcome: AuthGateOutcome;
  try {
    outcome = await runAuthGate(deps.gate);
  } catch {
    // Credential files and provider failures may contain secrets or local paths.
    throw new EngineOperatorAuthError(
      "Cannot read or verify the swamp operator account. Check SWAMP_API_KEY, SWAMP_API_KEY_FILE and swamp auth whoami before retrying.",
      "auth_configuration_invalid",
    );
  }
  if (outcome.kind === "block") {
    throw new EngineOperatorAuthError(
      blockMessage(outcome.reason),
      "auth_gate_blocked",
    );
  }
  try {
    await resolveAccountAuthentication({
      gateOutcome: outcome,
      canWrite: deps.canWrite,
      loadIdentity: deps.loadIdentity,
    });
    requireAuthenticated("swamp serve is a team feature", "serve:*");
    requireScope("serve:*");
  } catch (error) {
    // These three messages are authored by the shared account admission policy.
    if (
      error instanceof UserError &&
      (error.code === "auth_required" || error.code === "missing_scope" ||
        error.code === "scope_unverified")
    ) {
      throw new EngineOperatorAuthError(error.message, error.code);
    }
    throw new EngineOperatorAuthError(
      "Cannot resolve the swamp operator account. Check SWAMP_API_KEY, SWAMP_API_KEY_FILE and swamp auth whoami before retrying.",
      "auth_configuration_invalid",
    );
  }
  return outcome;
}
