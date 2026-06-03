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

/** `User-Agent` sent on every swamp-club request, e.g. `swamp-cli/<version>`. */
export const USER_AGENT = `swamp-cli/${VERSION}`;

/**
 * Resolve the device/user identity to attach to outbound swamp-club
 * HTTP traffic. Returns `bearerToken` (the personal-key value from
 * auth.json or SWAMP_API_KEY) when the user is authenticated, and
 * `distinctId` (the per-device UUID from identity.json) when available.
 *
 * Either field may be undefined — anonymous-but-attributed flows (no
 * login, only distinctId) and rare "no identity at all" flows
 * (UserIdentityRepository read failed and no auth) are both supported
 * by the downstream `ClientIdentity` shape.
 *
 * Always sets `userAgent` (`swamp-cli/<version>`) regardless of whether
 * the auth/device identity resolves — version attribution is independent
 * of the file system and must survive the best-effort failure paths.
 *
 * This helper is the composition root for identity. libswamp and the
 * HTTP clients themselves never touch the file system to discover it.
 *
 * Errors swallowed: AuthRepository.load() re-throws anything other
 * than NotFound (including the "HOME environment variable is not set"
 * thrown by getSwampConfigDir() on minimal Windows test envs that
 * have USERPROFILE but no HOME). Identity resolution is best-effort
 * — every CLI command runs through this, so a missing config-dir env
 * must never crash the CLI. Returns `{}` on any failure.
 */
export async function loadIdentity(): Promise<ClientIdentity> {
  let bearerToken: string | undefined;
  try {
    const credentials = await new AuthRepository().load();
    bearerToken = credentials?.apiKey;
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
