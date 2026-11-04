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

import type { ClientIdentity } from "./client_identity.ts";
import { AuthRepository } from "../persistence/auth_repository.ts";
import { UserIdentityRepository } from "../persistence/user_identity_repository.ts";

/**
 * best-effort: any failure (e.g. HOME unset) returns {} so a missing config-dir
 * env never crashes a command; userAgent is always set
 */
export async function loadClientIdentity(
  userAgent: string,
): Promise<ClientIdentity> {
  let bearerToken: string | undefined;
  try {
    const credentials = await new AuthRepository().load();
    bearerToken = credentials?.apiKey || undefined;
  } catch {
    bearerToken = undefined;
  }
  const distinctId = await new UserIdentityRepository().getUserId();
  return {
    bearerToken,
    distinctId: distinctId ?? undefined,
    userAgent,
  };
}
