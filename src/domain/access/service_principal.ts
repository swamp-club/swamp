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
 * Service principals are the identities serve itself acts as when it starts a
 * run with no client behind it. They exist only in-process: no credential can
 * be minted for one and no request can authenticate as one.
 */

/** The principal a cron-scheduled workflow run is attributed to. */
export const SCHEDULER_PRINCIPAL: Principal = Object.freeze({
  kind: "service",
  id: "scheduler",
});

/** The principal a webhook-triggered workflow run is attributed to. */
export const WEBHOOK_PRINCIPAL: Principal = Object.freeze({
  kind: "service",
  id: "webhook",
});

export function isServicePrincipal(principal: Principal): boolean {
  return principal.kind === "service";
}

/**
 * Throws when a credential would be issued to, or accepted for, a service
 * principal. Every token mint and token authentication path calls this so a
 * caller can never act as the scheduler or the webhook receiver.
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

/**
 * Parses a principal a credential may be issued to: `user` or `worker`.
 * A service principal is refused by name, and parse errors name only the
 * kinds a token can hold.
 */
export function parseCredentialPrincipal(value: string): Principal {
  if (value.startsWith("service:")) {
    throw new Error(
      `Principal "${value}" is a built-in service principal and cannot hold a credential`,
    );
  }
  return parsePrincipalOfKinds(value, ["user", "worker"]);
}
