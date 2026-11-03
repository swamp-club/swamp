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
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import { OAUTH_CLIENT_SECRET_SOURCES } from "./oauth_client_secret_source.ts";

const logger = getSwampLogger(["serve", "oauth-registration"]);

export const OAUTH_CLIENT_ID_KEY = "oauth-client-id";
export const OAUTH_CLIENT_SECRET_KEY = "oauth-client-secret";
export const OAUTH_RESOLVED_ADMINS_KEY = "oauth-resolved-admins";
export const OAUTH_BOOTSTRAP_ACCESS_TOKEN_KEY = "oauth-bootstrap-access-token";

// a public bootstrap client ID baked into the binary, as CLI tools do for
// device grant; security is in the browser approval, not in the ID being secret
export const BOOTSTRAP_CLIENT_ID = "swamp-serve-bootstrap";

export const SECRET_WITHOUT_CLIENT_ID_MESSAGE =
  "An OAuth client secret was supplied without a client id. Set --oauth-client-id or " +
  "SWAMP_OAUTH_CLIENT_ID to the client the secret belongs to.";

export interface OAuthClientCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly accessToken: string | null;
  readonly resolvedAdmins: Record<string, string> | null;
}

export interface OAuthRegistrationDeps {
  readonly getVaultSecret: (
    vaultName: string,
    key: string,
  ) => Promise<string | null>;
  readonly putVaultSecret: (
    vaultName: string,
    key: string,
    value: string,
  ) => Promise<void>;
  readonly registerClient: (
    providerUrl: string,
    signal: AbortSignal,
  ) => Promise<{
    clientId: string;
    clientSecret: string;
    accessToken: string | null;
  }>;
}

export async function resolveOAuthClientCredentials(
  deps: OAuthRegistrationDeps,
  providerUrl: string,
  vaultName: string,
  explicitClientId: string | undefined,
  suppliedClientSecret: string | undefined,
  signal: AbortSignal,
): Promise<OAuthClientCredentials> {
  if (suppliedClientSecret !== undefined && !explicitClientId) {
    throw new UserError(SECRET_WITHOUT_CLIENT_ID_MESSAGE);
  }

  const storedAdminsRaw = await deps.getVaultSecret(
    vaultName,
    OAUTH_RESOLVED_ADMINS_KEY,
  );
  const resolvedAdmins = storedAdminsRaw
    ? JSON.parse(storedAdminsRaw) as Record<string, string>
    : null;
  const readAccessToken = () =>
    resolvedAdmins
      ? Promise.resolve(null)
      : deps.getVaultSecret(vaultName, OAUTH_BOOTSTRAP_ACCESS_TOKEN_KEY);

  // A supplied pair is never stored: writing it would let any operator replace
  // the stored secret without proving it belongs to the client.
  if (explicitClientId && suppliedClientSecret !== undefined) {
    logger.info(
      "Using OAuth client {clientId} with the supplied client secret",
      { clientId: explicitClientId },
    );
    return {
      clientId: explicitClientId,
      clientSecret: suppliedClientSecret,
      accessToken: await readAccessToken(),
      resolvedAdmins,
    };
  }

  const storedClientId = await deps.getVaultSecret(
    vaultName,
    OAUTH_CLIENT_ID_KEY,
  );
  const storedClientSecret = await deps.getVaultSecret(
    vaultName,
    OAUTH_CLIENT_SECRET_KEY,
  );

  if (explicitClientId) {
    // A secret with no recorded id is a seeded one and cannot be checked; only a
    // different recorded id proves it belongs to another client.
    if (
      storedClientSecret &&
      (!storedClientId || storedClientId === explicitClientId)
    ) {
      logger.info(
        "Using OAuth client {clientId} with its stored client secret",
        { clientId: explicitClientId },
      );
      return {
        clientId: explicitClientId,
        clientSecret: storedClientSecret,
        accessToken: await readAccessToken(),
        resolvedAdmins,
      };
    }
    if (storedClientSecret) {
      throw new UserError(
        `The stored OAuth client is ${storedClientId}, not ${explicitClientId}, ` +
          `so its secret cannot be used. Supply the secret for ${explicitClientId} with ` +
          `${OAUTH_CLIENT_SECRET_SOURCES}. serve does not register a new client ` +
          "when a client id is set.",
      );
    }
    throw new UserError(
      `No client secret for OAuth client ${explicitClientId}. Supply it with ` +
        `${OAUTH_CLIENT_SECRET_SOURCES}. serve does not register a new client ` +
        "when a client id is set.",
    );
  }

  if (storedClientId && storedClientSecret) {
    logger.info("Using stored OAuth client credentials from vault");
    const storedAccessToken = resolvedAdmins
      ? null
      : await deps.getVaultSecret(vaultName, OAUTH_BOOTSTRAP_ACCESS_TOKEN_KEY);
    return {
      clientId: storedClientId,
      clientSecret: storedClientSecret,
      accessToken: storedAccessToken,
      resolvedAdmins,
    };
  }

  logger.info(
    "No stored OAuth client credentials found — first-time setup required",
  );

  const result = await deps.registerClient(providerUrl, signal);

  await deps.putVaultSecret(vaultName, OAUTH_CLIENT_ID_KEY, result.clientId);
  await deps.putVaultSecret(
    vaultName,
    OAUTH_CLIENT_SECRET_KEY,
    result.clientSecret,
  );
  if (result.accessToken) {
    await deps.putVaultSecret(
      vaultName,
      OAUTH_BOOTSTRAP_ACCESS_TOKEN_KEY,
      result.accessToken,
    );
  }

  logger.info(
    "Registered OAuth client {clientId} and stored credentials in vault",
    { clientId: result.clientId },
  );

  return {
    clientId: result.clientId,
    clientSecret: result.clientSecret,
    accessToken: result.accessToken,
    resolvedAdmins: null,
  };
}

export async function storeResolvedAdmins(
  deps: Pick<OAuthRegistrationDeps, "putVaultSecret">,
  vaultName: string,
  admins: Record<string, string>,
): Promise<void> {
  await deps.putVaultSecret(
    vaultName,
    OAUTH_RESOLVED_ADMINS_KEY,
    JSON.stringify(admins),
  );
  logger.info(
    "Stored {count} resolved admin mapping(s) in vault",
    { count: Object.keys(admins).length },
  );
}
