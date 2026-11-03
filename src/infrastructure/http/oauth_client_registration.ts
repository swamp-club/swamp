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

import { getSwampLogger } from "../logging/logger.ts";

const logger = getSwampLogger(["serve", "oauth-registration"]);

export async function registerClientWithApiKey(
  providerUrl: string,
  apiKey: string,
  clientName: string,
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
      client_name: clientName,
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
