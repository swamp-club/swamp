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

import type { AdmissionResult } from "../domain/access/admission.ts";
import { checkAdmission } from "../domain/access/admission.ts";
import type { ServeAuthConfig } from "../domain/access/serve_auth_config.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import {
  DeviceGrantPollError,
  type DeviceGrantResponse,
  getUserInfo as oauthGetUserInfo,
  type OAuthTokenResponse,
  type OAuthUserInfo,
  pollForToken as oauthPollForToken,
  startDeviceGrant as oauthStartDeviceGrant,
} from "./oauth_client.ts";
import { generateOpaqueToken } from "../domain/remote/session_credential.ts";
import { Definition } from "../domain/definitions/definition.ts";
import {
  SERVER_TOKEN_MODEL_TYPE,
  serverTokenModel,
  serverTokenSecretKey,
} from "../domain/models/access/server_token_model.ts";
import { createResourceWriter } from "../domain/models/data_writer.ts";
import { VaultService } from "../domain/vaults/vault_service.ts";

const logger = getSwampLogger(["serve", "device-auth"]);

/**
 * Dependencies injected into the device auth handler for testability.
 * Production callers should use {@link createDeviceAuthDeps} to wire up
 * real implementations.
 */
export interface DeviceAuthDeps {
  readonly authConfig: ServeAuthConfig;
  readonly repoDir: string;
  readonly repoContext: RepositoryContext;
  readonly startDeviceGrant: (
    providerUrl: string,
    clientId: string,
    signal: AbortSignal,
  ) => Promise<DeviceGrantResponse>;
  readonly pollForToken: (
    providerUrl: string,
    clientId: string,
    clientSecret: string,
    deviceCode: string,
    signal: AbortSignal,
  ) => Promise<OAuthTokenResponse>;
  readonly getUserInfo: (
    providerUrl: string,
    accessToken: string,
    groupsField: string,
    signal: AbortSignal,
  ) => Promise<OAuthUserInfo>;
  readonly checkAdmission: (
    userSub: string,
    collectives: readonly string[],
    allowedCollectives: readonly string[],
    allowedUsers: readonly string[],
  ) => AdmissionResult;
  readonly mintServerToken: (
    principalId: string,
    principalEmail: string,
    collectives: string[],
    repoDir: string,
    repoContext: RepositoryContext,
  ) => Promise<string>;
  readonly clientSecret: string;
}

function jsonResponse(
  status: number,
  body: Record<string, unknown>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Handles HTTP requests for the OAuth device authorization flow.
 *
 * Matches:
 * - `POST /auth/device` — starts the device grant flow
 * - `POST /auth/device/token` — polls for completion, checks admission,
 *   mints a server token
 *
 * Returns `null` for paths that do not match, allowing the caller to
 * fall through to other handlers.
 */
export async function handleDeviceAuth(
  req: Request,
  deps: DeviceAuthDeps,
): Promise<Response | null> {
  const url = new URL(req.url);

  if (url.pathname === "/auth/device") {
    if (req.method !== "POST") {
      return jsonResponse(405, { error: "Method not allowed" });
    }
    return await handleStartDeviceGrant(deps);
  }

  if (url.pathname === "/auth/device/token") {
    if (req.method !== "POST") {
      return jsonResponse(405, { error: "Method not allowed" });
    }
    return await handleDeviceToken(req, deps);
  }

  return null;
}

async function handleStartDeviceGrant(
  deps: DeviceAuthDeps,
): Promise<Response> {
  try {
    const signal = AbortSignal.timeout(30_000);
    const grant = await deps.startDeviceGrant(
      deps.authConfig.oauthProvider,
      deps.authConfig.oauthClientId!,
      signal,
    );
    logger.info("Device grant started for provider {provider}", {
      provider: deps.authConfig.oauthProvider,
    });
    return jsonResponse(200, {
      deviceCode: grant.deviceCode,
      userCode: grant.userCode,
      verificationUri: grant.verificationUri,
      verificationUriComplete: grant.verificationUriComplete,
      expiresIn: grant.expiresIn,
      interval: grant.interval,
    });
  } catch (err) {
    logger.error`Failed to start device authorization: ${
      err instanceof Error ? err.message : String(err)
    }`;
    return jsonResponse(502, {
      error: "Failed to start device authorization",
    });
  }
}

async function handleDeviceToken(
  req: Request,
  deps: DeviceAuthDeps,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  if (!body.deviceCode || typeof body.deviceCode !== "string") {
    return jsonResponse(400, { error: "Missing or invalid deviceCode" });
  }
  const deviceCode = body.deviceCode;

  try {
    const signal = AbortSignal.timeout(30_000);
    const tokenResponse = await deps.pollForToken(
      deps.authConfig.oauthProvider,
      deps.authConfig.oauthClientId!,
      deps.clientSecret,
      deviceCode,
      signal,
    );

    const userInfo = await deps.getUserInfo(
      deps.authConfig.oauthProvider,
      tokenResponse.accessToken,
      deps.authConfig.groupsField,
      signal,
    );

    const admissionResult = deps.checkAdmission(
      userInfo.sub,
      userInfo.collectives,
      deps.authConfig.allowedCollectives,
      deps.authConfig.allowedUsers,
    );

    if (!admissionResult.admitted) {
      logger.info("Admission denied for {sub}: {reason}", {
        sub: userInfo.sub,
        reason: admissionResult.reason,
      });
      return jsonResponse(403, {
        error: "Not admitted",
        reason: admissionResult.reason,
      });
    }

    const principalId = `user:${userInfo.sub}`;
    const token = await deps.mintServerToken(
      principalId,
      userInfo.email,
      [...userInfo.collectives],
      deps.repoDir,
      deps.repoContext,
    );

    logger.info("OAuth device flow completed for {principal}", {
      principal: principalId,
    });
    return jsonResponse(200, {
      token,
      principal: {
        id: principalId,
        email: userInfo.email,
        name: userInfo.name,
        collectives: userInfo.collectives,
      },
    });
  } catch (err) {
    if (err instanceof DeviceGrantPollError) {
      switch (err.code) {
        case "authorization_pending":
          return jsonResponse(202, { status: "pending" });
        case "slow_down":
          return jsonResponse(202, { status: "pending", slowDown: true });
        case "expired_token":
          return jsonResponse(410, { error: "Device code expired" });
        case "access_denied":
          return jsonResponse(403, {
            error: "Authorization denied by user",
          });
      }
    }
    logger.error`Token exchange error: ${
      err instanceof Error ? err.message : String(err)
    }`;
    return jsonResponse(500, {
      error: "Internal error during token exchange",
    });
  }
}

/**
 * Creates production {@link DeviceAuthDeps} wired to real implementations
 * from `oauth_client.ts` and `admission.ts`.
 */
const TOKEN_DATA_NAME = "token-main";
const DEFAULT_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

async function mintServerTokenImpl(
  principalId: string,
  principalEmail: string,
  collectives: string[],
  repoDir: string,
  repoContext: RepositoryContext,
): Promise<string> {
  const tokenName = `oauth-${crypto.randomUUID().slice(0, 8)}`;
  const secretKey = serverTokenSecretKey(tokenName);
  const plaintext = generateOpaqueToken();

  const vaultService = await VaultService.fromRepository(repoDir);
  const vaultNames = vaultService.getVaultNames();
  if (vaultNames.length === 0) {
    throw new Error(
      "No vaults configured — create one with: swamp vault create local default",
    );
  }
  const vaultName = vaultNames[0];

  await vaultService.put(vaultName, secretKey, plaintext);

  const defRepo = repoContext.definitionRepo;
  let def = await defRepo.findByName(SERVER_TOKEN_MODEL_TYPE, tokenName);
  if (!def) {
    def = Definition.create({
      type: SERVER_TOKEN_MODEL_TYPE.normalized,
      name: tokenName,
    });
    await defRepo.save(SERVER_TOKEN_MODEL_TYPE, def);
  }

  const now = Date.now();
  const tokenData = {
    name: tokenName,
    state: "active" as const,
    principalId,
    principalEmail,
    collectives,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + DEFAULT_DURATION_MS).toISOString(),
    vaultName,
    secretKey,
  };

  const { writeResource } = createResourceWriter(
    repoContext.unifiedDataRepo,
    SERVER_TOKEN_MODEL_TYPE,
    def.id,
    serverTokenModel.resources!,
    undefined,
    undefined,
    undefined,
    undefined,
    tokenName,
  );
  await writeResource(
    "token",
    TOKEN_DATA_NAME,
    tokenData as unknown as Record<string, unknown>,
  );

  logger.info("Minted OAuth server token {name} for {principal}", {
    name: tokenName,
    principal: principalId,
  });

  return `${tokenName}.${plaintext}`;
}

export function createDeviceAuthDeps(
  authConfig: ServeAuthConfig,
  clientSecret: string,
  repoDir: string,
  repoContext: RepositoryContext,
): DeviceAuthDeps {
  return {
    authConfig,
    repoDir,
    repoContext,
    clientSecret,
    startDeviceGrant: oauthStartDeviceGrant,
    pollForToken: oauthPollForToken,
    getUserInfo: oauthGetUserInfo,
    checkAdmission,
    mintServerToken: mintServerTokenImpl,
  };
}
