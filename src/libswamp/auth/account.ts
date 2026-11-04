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

import type { ClientIdentity } from "../../infrastructure/http/client_identity.ts";
import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import { hasApiKeySource } from "../../infrastructure/persistence/api_key_source.ts";
import { keyFingerprint } from "../../domain/auth/auth_credentials.ts";
import {
  getCollectives,
  SwampClubClient,
  type WhoamiResponse,
} from "../../infrastructure/http/swamp_club_client.ts";
import {
  isCollectiveToken,
  setAuthenticated,
  setAuthScopes,
  setCollectiveToken,
  setScopeResolutionFailed,
} from "./context.ts";
import type { AuthGateOutcome } from "./gate.ts";

/** saves a CI run, which checks its signin token live, a second call */
async function gateWhoamiOr(
  outcome: AuthGateOutcome | undefined,
  serverUrl: string,
  apiKey: string,
  loadIdentity: () => Promise<ClientIdentity>,
): Promise<WhoamiResponse> {
  if (outcome?.kind === "pass" && outcome.liveResponse) {
    return outcome.liveResponse;
  }
  const client = new SwampClubClient(serverUrl, await loadIdentity());
  return await client.whoami(apiKey, AbortSignal.timeout(10_000));
}

/** Resolve operator identity and cached scopes with the CLI's existing key-source semantics. */
export async function resolveAccountAuthentication(options: {
  gateOutcome?: AuthGateOutcome;
  canWrite: boolean;
  loadIdentity: () => Promise<ClientIdentity>;
  onScopeResolutionFailure?: (error: unknown) => void;
}): Promise<{ identity: ClientIdentity; collectives: string[] | undefined }> {
  // whoami is called only when the cache is stale. scopes are set from the
  // response to avoid cache round-trip issues with --unstable-bundle module
  // duplication. must run before the authCollectives read
  let uncachedCollectives: string[] | undefined;
  if (hasApiKeySource()) {
    try {
      const authRepo = new AuthRepository();
      const creds = await authRepo.load();
      if (creds) {
        if (creds.apiKey) setCollectiveToken(creds.apiKey);
        if (isCollectiveToken()) {
          const scopeFingerprint = await keyFingerprint(creds.apiKey);
          const cachedScopes = await authRepo.loadScopeCache(scopeFingerprint);
          if (cachedScopes) {
            setAuthScopes(cachedScopes);
          } else {
            const response = await gateWhoamiOr(
              options.gateOutcome,
              creds.serverUrl,
              creds.apiKey,
              options.loadIdentity,
            );
            if (response.authenticated) {
              setAuthScopes(response.scopes);
              if (response.scopes && options.canWrite) {
                await authRepo.saveScopeCache(
                  scopeFingerprint,
                  response.scopes,
                );
              }
            }
          }
        } else if (!creds.username) {
          const response = await gateWhoamiOr(
            options.gateOutcome,
            creds.serverUrl,
            creds.apiKey,
            options.loadIdentity,
          );
          if (response.authenticated && response.username) {
            const collectives = getCollectives(response) ?? [];
            // A process that does not own the config dir must not write the
            // cache, so it keeps this run's collectives in memory instead.
            uncachedCollectives = collectives;
            if (options.canWrite) {
              await authRepo.saveIdentityCache(
                creds.serverUrl,
                response.username,
                collectives,
                await keyFingerprint(creds.apiKey),
                response.scopes,
              );
            }
          }
        }
      }
    } catch (err) {
      setScopeResolutionFailed(true);
      options.onScopeResolutionFailure?.(err);
    }
  }

  let authCollectives: string[] | undefined;
  try {
    const authRepo = new AuthRepository();
    const creds = await authRepo.load();
    authCollectives = creds?.collectives ?? uncachedCollectives;
    if (!hasApiKeySource()) {
      if (creds?.apiKey) setCollectiveToken(creds.apiKey);
      setAuthScopes(creds?.scopes);
    }
  } catch {
    // Auth file unreadable — continue without membership collectives
  }

  const identity = await options.loadIdentity();
  setAuthenticated(Boolean(identity.bearerToken));
  return { identity, collectives: authCollectives };
}
