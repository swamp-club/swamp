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

import type { Principal } from "../access/principal.ts";
import type { ActorIdentity } from "./audit_event.ts";

/**
 * a user the provider gave no username falls back to the name configured for
 * their id; undefined when nothing is known
 */
export function resolveActorIdentity(
  principal: Principal | null,
  resolvedUserNames: Readonly<Record<string, string>> | undefined,
  loginIdentity: ActorIdentity | undefined,
): ActorIdentity | undefined {
  if (principal?.kind !== "user") return undefined;
  const username = loginIdentity?.username ?? resolvedUserNames?.[principal.id];
  const email = loginIdentity?.email;
  if (username === undefined && email === undefined) return undefined;
  return {
    ...(username !== undefined ? { username } : {}),
    ...(email !== undefined ? { email } : {}),
  };
}
