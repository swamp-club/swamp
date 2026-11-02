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

import {
  parsePrincipalOfKinds,
  type Principal,
  principalToString,
} from "./principal.ts";

/**
 * identities serve itself acts as for a run with no client behind it; they
 * exist only in-process, so no credential can be minted for one and no request
 * can authenticate as one
 */

export const SCHEDULER_PRINCIPAL: Principal = Object.freeze({
  kind: "service",
  id: "scheduler",
});

export const WEBHOOK_PRINCIPAL: Principal = Object.freeze({
  kind: "service",
  id: "webhook",
});

export function isServicePrincipal(principal: Principal): boolean {
  return principal.kind === "service";
}

/**
 * every token mint and token authentication path calls this so a caller can
 * never act as the scheduler or the webhook receiver
 */
export function assertAuthenticatablePrincipal(principal: Principal): void {
  if (isServicePrincipal(principal)) {
    throw new Error(
      `Principal "${
        principalToString(principal)
      }" is a built-in service principal and cannot hold a credential`,
    );
  }
}

export function parseCredentialPrincipal(value: string): Principal {
  if (value.startsWith("service:")) {
    throw new Error(
      `Principal "${value}" is a built-in service principal and cannot hold a credential`,
    );
  }
  return parsePrincipalOfKinds(value, ["user", "worker"]);
}
