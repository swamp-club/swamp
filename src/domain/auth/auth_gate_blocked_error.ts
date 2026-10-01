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

import { UserError } from "../errors.ts";
import type { BlockReason } from "./auth_gate_policy.ts";

/**
 * True for a block a later run can clear on its own — swamp-club refusing,
 * unreachable or failing — rather than one that needs the user to act (no
 * credential, a revoked key). Temporary blocks exit with 75 (EX_TEMPFAIL) so
 * CI wrappers can retry them and fail fast on the rest.
 */
export function isTemporaryBlock(reason: BlockReason): boolean {
  return reason.kind === "refused" ||
    reason.kind === "unreachable_unverified" ||
    reason.kind === "unverified_for_a_day";
}

/**
 * The error a run the auth gate blocked exits with. It carries the reason,
 * so JSON output can report it as data and the exit code can tell a
 * temporary block from one that needs the user. Telemetry records the class
 * name, so blocks are countable by type.
 */
export class AuthGateBlockedError extends UserError {
  readonly reason: BlockReason;
  constructor(reason: BlockReason, message: string) {
    super(message, "auth_gate_blocked");
    this.name = "AuthGateBlockedError";
    this.reason = reason;
  }

  get temporary(): boolean {
    return isTemporaryBlock(this.reason);
  }
}
