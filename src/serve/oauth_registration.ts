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

import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["serve", "oauth-registration"]);

export const OAUTH_CLIENT_ID_KEY = "oauth-client-id";
export const OAUTH_CLIENT_SECRET_KEY = "oauth-client-secret";
export const OAUTH_RESOLVED_ADMINS_KEY = "oauth-resolved-admins";
export const OAUTH_BOOTSTRAP_ACCESS_TOKEN_KEY = "oauth-bootstrap-access-token";

// Well-known bootstrap client ID for first-time OAuth registration.
// This is a public client ID baked into the binary — the same pattern
// used by GitHub CLI (client ID 178c6fc778ccc68e1d6a), Claude Code,
// and other CLI tools that authenticate via OAuth device grant.
// Security is in the device grant approval (user must approve in browser),
// not in the client ID secrecy.
export const BOOTSTRAP_CLIENT_ID = "swamp-serve-bootstrap";

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
  signal: AbortSignal,
): Promise<OAuthClientCredentials> {
  const storedClientId = await deps.getVaultSecret(
    vaultName,
    OAUTH_CLIENT_ID_KEY,
  );
  const storedClientSecret = await deps.getVaultSecret(
    vaultName,
    OAUTH_CLIENT_SECRET_KEY,
  );

  const storedAdminsRaw = await deps.getVaultSecret(
    vaultName,
    OAUTH_RESOLVED_ADMINS_KEY,
  );
  const resolvedAdmins = storedAdminsRaw
    ? JSON.parse(storedAdminsRaw) as Record<string, string>
    : null;

  if (explicitClientId && storedClientSecret) {
    logger.info("Using explicit --oauth-client-id with stored client secret");
    const storedAccessToken = resolvedAdmins
      ? null
      : await deps.getVaultSecret(vaultName, OAUTH_BOOTSTRAP_ACCESS_TOKEN_KEY);
    return {
      clientId: explicitClientId,
      clientSecret: storedClientSecret,
      accessToken: storedAccessToken,
      resolvedAdmins,
    };
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

export async function registerClientWithApiKey(
  providerUrl: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<{ clientId: string; clientSecret: string }> {
  const verifyResp = await fetch(`${providerUrl}/api/whoami`, {
    headers: { "authorization": `Bearer ${apiKey}` },
    signal,
  });
  if (!verifyResp.ok) {
    const body = await verifyResp.text().catch(() => "");
    throw new Error(
      `SWAMP_API_KEY validation failed: ${verifyResp.status} ${verifyResp.statusText}${
        body ? ` — ${body}` : ""
      }`,
    );
  }
  const whoami = await verifyResp.json() as {
    scopes?: string[];
  };
  const scopes = whoami.scopes ?? [];
  if (!scopes.includes("oauth:manage")) {
    throw new Error(
      `SWAMP_API_KEY is missing the "oauth:manage" scope required for headless OAuth client registration. ` +
        `Generate a new collective API token that includes "oauth:manage".`,
    );
  }

  logger.info(
    "SWAMP_API_KEY verified with oauth:manage scope — registering OAuth client (headless)",
  );

  const resp = await fetch(`${providerUrl}/api/auth/oauth2/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      client_name: `swamp-serve-${crypto.randomUUID().slice(0, 8)}`,
      redirect_uris: ["http://localhost"],
      grant_types: ["authorization_code"],
      scope: "openid profile email collectives",
    }),
    signal,
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      `OAuth client registration via API key failed: ${resp.status} ${resp.statusText}${
        body ? ` — ${body}` : ""
      }`,
    );
  }
  const data = await resp.json() as Record<string, unknown>;
  if (
    typeof data.client_id !== "string" ||
    typeof data.client_secret !== "string"
  ) {
    throw new Error(
      "OAuth registration response missing client_id or client_secret",
    );
  }
  logger.info(
    "Registered OAuth client {clientId} via SWAMP_API_KEY (headless)",
    { clientId: data.client_id },
  );
  return {
    clientId: data.client_id,
    clientSecret: data.client_secret,
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
