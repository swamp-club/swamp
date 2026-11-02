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

import type { ClientIdentity } from "../infrastructure/http/client_identity.ts";
import { AuthRepository } from "../infrastructure/persistence/auth_repository.ts";
import { UserIdentityRepository } from "../infrastructure/persistence/user_identity_repository.ts";
import { VERSION } from "./commands/version.ts";

export const USER_AGENT = `swamp-cli/${VERSION}`;

/**
 * best-effort: any failure (e.g. HOME unset) returns {} so a missing config-dir
 * env never crashes a command; userAgent is always set
 */
export async function loadIdentity(): Promise<ClientIdentity> {
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
    userAgent: USER_AGENT,
  };
}
