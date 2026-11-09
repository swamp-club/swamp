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
import { withSpan } from "../infrastructure/tracing/mod.ts";
import type { AuditEmitter } from "../domain/serve_audit/audit_emitter.ts";
import type {
  AuditEvent,
  AuditOutcome,
} from "../domain/serve_audit/audit_event.ts";
import { buildAuditEvent } from "../domain/serve_audit/audit_event_builder.ts";
import { resolveActorIdentity } from "../domain/serve_audit/actor_identity.ts";
import { DIRECT_CLI_CLIENT } from "../domain/access/client.ts";
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
  serverTokenSecretFingerprint,
  serverTokenSecretKey,
} from "../domain/models/access/server_token_model.ts";
import { createResourceWriter } from "../domain/models/data_writer.ts";
import { VaultService } from "../domain/vaults/vault_service.ts";
import { TOKEN_SECRETS_VAULT_NAME } from "../domain/vaults/control_plane_vault_provider.ts";
import { YamlDefinitionRepository } from "../infrastructure/persistence/yaml_definition_repository.ts";
import { runInRootUnitOfWork } from "../infrastructure/persistence/repo_unit_of_work.ts";
import { stageWritesThenPush } from "./stage_writes_then_push.ts";
import type { DatastoreSyncService } from "../domain/datastore/datastore_sync_service.ts";
import { findDefinitionByIdOrName } from "../domain/models/model_lookup.ts";

import { type SyncGate, withSyncGate } from "./sync_gate.ts";
import { pushNamespace } from "../infrastructure/persistence/push_paths.ts";
import { readBodyWithLimit } from "./webhook.ts";
import {
  displayPrincipal,
  usernameFromLogin,
  type UsernamesResolved,
} from "./known_usernames.ts";

const logger = getSwampLogger(["serve", "device-auth"]);

export interface DeviceAuthDeps {
  readonly authConfig: Omit<ServeAuthConfig, "oauthClientId"> & {
    oauthClientId: string;
  };
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
    groups: string[],
    repoDir: string,
    repoContext: RepositoryContext,
    username?: string,
    client?: string,
  ) => Promise<string>;
  readonly storeAccessToken: (
    tokenName: string,
    accessToken: string,
  ) => Promise<void>;
  readonly clientSecret: string;
  readonly auditEmitter?: AuditEmitter;
  readonly instanceId?: string;
  readonly sourceIp?: string;
  readonly resolvedUserNames?: Readonly<Record<string, string>>;
  readonly onUsernamesResolved?: UsernamesResolved;
}

export interface DeviceAuthRoutes {
  readonly startPath: string;
  readonly tokenPath: string;
  /** fixed per route, so nothing in a sign-in request can choose it */
  readonly client: string;
  readonly onAuthenticated?: (token: string) => Promise<Response>;
}

function emitAuthAuditEvent(
  deps: DeviceAuthDeps,
  action: string,
  outcome: AuditOutcome,
  principalId?: string,
  detail?: string,
  tokenName?: string,
  userInfo?: Pick<OAuthUserInfo, "email" | "username">,
): AuditEvent | undefined {
  if (!deps.auditEmitter) return undefined;
  const event = buildAuditEvent({
    instanceId: deps.instanceId ?? "unknown",
    category: "auth",
    stage: "response",
    outcome,
    action,
    resourceKind: tokenName ? "server-token" : "server",
    resourceName: tokenName ?? deps.instanceId ?? "unknown",
    principalKind: principalId ? "user" : "anonymous",
    principalId: principalId ?? "anonymous",
    initiatedBy: principalId
      ? displayPrincipal(
        { kind: "user", id: principalId },
        userInfo?.username
          ? { [principalId]: userInfo.username }
          : deps.resolvedUserNames,
      )
      : "anonymous",
    actor: principalId && userInfo
      ? resolveActorIdentity(
        { kind: "user", id: principalId },
        deps.resolvedUserNames,
        {
          email: userInfo.email,
          ...(userInfo.username !== undefined
            ? { username: userInfo.username }
            : {}),
        },
      )
      : undefined,
    sourceIp: deps.sourceIp ?? "unknown",
    requestId: crypto.randomUUID(),
    detail,
  });
  deps.auditEmitter.emit(event);
  return event;
}

function collectivesRead(
  userInfo: Pick<OAuthUserInfo, "collectives" | "collectivesFieldAbsent">,
  groupsField: string,
): string {
  if (userInfo.collectivesFieldAbsent) {
    return `userinfo has no ${groupsField} field`;
  }
  return userInfo.collectives.length > 0
    ? `${groupsField} read from userinfo: ${userInfo.collectives.join(", ")}`
    : `${groupsField} read from userinfo: none`;
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

export async function handleDeviceAuth(
  req: Request,
  deps: DeviceAuthDeps,
  routes: DeviceAuthRoutes = {
    startPath: "/auth/device",
    tokenPath: "/auth/device/token",
    client: DIRECT_CLI_CLIENT,
  },
): Promise<Response | null> {
  const url = new URL(req.url);

  if (url.pathname === routes.startPath) {
    if (req.method !== "POST") {
      return jsonResponse(405, { error: "Method not allowed" });
    }
    return await handleStartDeviceGrant(deps);
  }

  if (url.pathname === routes.tokenPath) {
    if (req.method !== "POST") {
      return jsonResponse(405, { error: "Method not allowed" });
    }
    return await handleDeviceToken(
      req,
      deps,
      routes.client,
      routes.onAuthenticated,
    );
  }

  return null;
}

async function handleStartDeviceGrant(
  deps: DeviceAuthDeps,
): Promise<Response> {
  try {
    const signal = AbortSignal.timeout(30_000);
    const grant = await withSpan(
      "swamp.serve.auth.device_start",
      {},
      () =>
        deps.startDeviceGrant(
          deps.authConfig.oauthProvider,
          deps.authConfig.oauthClientId,
          signal,
        ),
    );
    logger.info("Device grant started for provider {provider}", {
      provider: deps.authConfig.oauthProvider,
    });
    emitAuthAuditEvent(deps, "auth.login.started", "success");
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

/**
 * largest body the unauthenticated sign-in routes read: each carries one device
 * code or token
 */
export const MAX_AUTH_BODY_BYTES = 16 * 1024;

async function handleDeviceToken(
  req: Request,
  deps: DeviceAuthDeps,
  client: string,
  onAuthenticated?: (token: string) => Promise<Response>,
): Promise<Response> {
  const bytes = await readBodyWithLimit(req, MAX_AUTH_BODY_BYTES);
  if (bytes === null) {
    return jsonResponse(413, {
      error: `Request body exceeds ${MAX_AUTH_BODY_BYTES} bytes`,
    });
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes)) as Record<
      string,
      unknown
    >;
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  if (!body.deviceCode || typeof body.deviceCode !== "string") {
    return jsonResponse(400, { error: "Missing or invalid deviceCode" });
  }
  const deviceCode = body.deviceCode;

  try {
    const signal = AbortSignal.timeout(30_000);
    const polled = await withSpan(
      "swamp.serve.auth.poll_token",
      {},
      async (span) => {
        try {
          const tokenResponse = await deps.pollForToken(
            deps.authConfig.oauthProvider,
            deps.authConfig.oauthClientId,
            deps.clientSecret,
            deviceCode,
            signal,
          );
          span.setAttribute("oauth.poll.outcome", "granted");
          return { tokenResponse };
        } catch (err) {
          if (!(err instanceof DeviceGrantPollError)) throw err;
          span.setAttribute("oauth.poll.outcome", err.code);
          // Pending, slow_down, expired and denied are the normal outcomes of
          // polling a device grant, so they must not mark the span ERROR — a
          // login polls pending every few seconds. The error is handed out
          // and rethrown below, after the span has ended.
          if (err.code === "unknown") throw err;
          return { pollError: err };
        }
      },
    );
    if ("pollError" in polled) throw polled.pollError;
    const { tokenResponse } = polled;

    const userInfo = await withSpan(
      "swamp.serve.auth.userinfo",
      {},
      () =>
        deps.getUserInfo(
          deps.authConfig.oauthProvider,
          tokenResponse.accessToken,
          deps.authConfig.groupsField,
          signal,
        ),
    );

    const admissionResult = deps.checkAdmission(
      userInfo.sub,
      userInfo.collectives,
      deps.authConfig.allowedCollectives,
      deps.authConfig.allowedUsers,
    );

    if (!admissionResult.admitted) {
      const read = collectivesRead(userInfo, deps.authConfig.groupsField);
      if (deps.authConfig.allowedCollectives.length > 0) {
        logger.info(
          "Admission denied for {sub}: {reason}; {read}. swamp-club leaves personal collectives out of userinfo; admit a personal collective owner with --allowed-users",
          { sub: userInfo.sub, reason: admissionResult.reason, read },
        );
      } else {
        logger.info("Admission denied for {sub}: {reason}; {read}", {
          sub: userInfo.sub,
          reason: admissionResult.reason,
          read,
        });
      }
      emitAuthAuditEvent(
        deps,
        "auth.login.denied",
        "denied",
        userInfo.sub,
        `${admissionResult.reason}; ${read}`,
        undefined,
        userInfo,
      );
      return jsonResponse(403, {
        error: "Not admitted",
        reason: admissionResult.reason,
      });
    }

    const principalId = oauthPrincipalId(userInfo.sub);
    const token = await withSpan(
      "swamp.serve.auth.mint",
      { "auth.principal.id": principalId },
      async (span) => {
        const minted = await deps.mintServerToken(
          principalId,
          userInfo.email,
          [...userInfo.collectives],
          [...userInfo.groups],
          deps.repoDir,
          deps.repoContext,
          userInfo.username,
          client,
        );
        span.setAttribute("token.name", minted.split(".")[0]);
        return minted;
      },
    );

    const tokenName = token.split(".")[0];
    await withSpan(
      "swamp.serve.auth.store_access_token",
      { "token.name": tokenName },
      () => deps.storeAccessToken(tokenName, tokenResponse.accessToken),
    );
    logger.info("Stored OAuth access token for {name}", {
      name: tokenName,
    });

    logger.info("OAuth device flow completed for {principal}", {
      principal: principalId,
    });
    const learned = usernameFromLogin(principalId, userInfo);
    if (Object.keys(learned).length > 0) deps.onUsernamesResolved?.(learned);
    emitAuthAuditEvent(
      deps,
      "auth.login.completed",
      "success",
      userInfo.sub,
      undefined,
      tokenName,
      userInfo,
    );
    if (onAuthenticated) return await onAuthenticated(token);
    return jsonResponse(200, {
      token,
      principal: {
        id: principalId,
        email: userInfo.email,
        name: userInfo.name,
        collectives: userInfo.collectives,
        groups: userInfo.groups,
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
          emitAuthAuditEvent(deps, "auth.login.expired", "failure");
          return jsonResponse(410, { error: "Device code expired" });
        case "access_denied":
          emitAuthAuditEvent(deps, "auth.login.denied", "denied");
          return jsonResponse(403, {
            error: "Authorization denied by user",
          });
        case "unknown":
          return jsonResponse(502, {
            error: "Upstream provider returned an unexpected error",
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

const TOKEN_DATA_NAME = "token-main";
const DEFAULT_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

async function mintServerTokenImpl(
  principalId: string,
  principalEmail: string,
  collectives: string[],
  groups: string[],
  repoDir: string,
  repoContext: RepositoryContext,
  defaultVault?: string,
  syncService?: DatastoreSyncService,
  namespace?: string,
  username?: string,
  client: string = DIRECT_CLI_CLIENT,
): Promise<string> {
  const tokenName = `oauth-${crypto.randomUUID().slice(0, 8)}`;
  const secretKey = serverTokenSecretKey(tokenName);
  const plaintext = generateOpaqueToken();

  const vaultName = TOKEN_SECRETS_VAULT_NAME;
  await withSpan("swamp.serve.auth.mint.vault_put", {}, async () => {
    const vaultService = await VaultService.fromRepository(
      repoDir,
      { defaultVaultName: defaultVault },
    );
    await vaultService.put(vaultName, secretKey, plaintext);
  });

  // writes run in a root unit of work with no push, so marks stage into it
  // instead of signalChange's fallback; the push below opens its own root
  const { def, savedDefinitionPath } = await runInRootUnitOfWork(
    repoContext,
    { flush: undefined },
    async () => {
      const saved = await withSpan(
        "swamp.serve.auth.mint.definition_save",
        {},
        async () => {
          const defRepo = repoContext.definitionRepo;
          const existing = await defRepo.findByName(
            SERVER_TOKEN_MODEL_TYPE,
            tokenName,
          );
          if (existing) {
            return { def: existing, savedDefinitionPath: undefined };
          }
          const created = Definition.create({
            type: SERVER_TOKEN_MODEL_TYPE.normalized,
            name: tokenName,
            typeVersion: serverTokenModel.version,
          });
          const autoDefRepo = new YamlDefinitionRepository(
            repoDir,
            repoContext.eventBus,
            repoContext.autoDefinitionsDir,
            false,
            repoContext.markDirty,
          );
          await autoDefRepo.save(SERVER_TOKEN_MODEL_TYPE, created);
          return {
            def: created,
            savedDefinitionPath: autoDefRepo.getPath(
              SERVER_TOKEN_MODEL_TYPE,
              created.id,
            ),
          };
        },
      );

      const now = Date.now();
      const tokenData = {
        name: tokenName,
        state: "active" as const,
        principalId,
        principalEmail,
        // only this OAuth login sets it, so audit events name a user by what
        // the provider said, not an operator-typed email
        oauthIdentity: {
          email: principalEmail,
          ...(username !== undefined ? { username } : {}),
        },
        client,
        collectives,
        groups,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + DEFAULT_DURATION_MS).toISOString(),
        vaultName,
        secretKey,
        secretFingerprint: await serverTokenSecretFingerprint(plaintext),
      };

      await withSpan("swamp.serve.auth.mint.token_write", {}, async () => {
        const { writeResource } = createResourceWriter(
          repoContext.unifiedDataRepo,
          SERVER_TOKEN_MODEL_TYPE,
          saved.def.id,
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
      });
      return saved;
    },
  );

  if (syncService) {
    // the push runs inside this span so the datastore's push span is parented
    // to the login rather than starting a root trace
    await withSpan("swamp.serve.auth.mint.push", {}, async () => {
      // an ungated push between mark and write clears the mark, so mark the
      // token's paths again; per path, as a bare markDirty() turns every
      // login's push into a walk of the whole cache
      await stageWritesThenPush(
        repoContext,
        [
          ...(savedDefinitionPath ? [savedDefinitionPath] : []),
          repoContext.unifiedDataRepo.getDataNameDir(
            SERVER_TOKEN_MODEL_TYPE,
            def.id,
            TOKEN_DATA_NAME,
          ),
        ],
        { flush: () => pushNamespace(syncService, namespace) },
      );
    });

    await withSpan("swamp.serve.auth.mint.verify", {}, async () => {
      repoContext.catalogStore.invalidate();
      const verifyResult = await findDefinitionByIdOrName(
        repoContext.definitionRepo,
        tokenName,
      );
      if (!verifyResult) {
        logger.warn(
          "OAuth server token {name} was minted but its definition could not be read back — it may not survive a pod restart",
          { name: tokenName },
        );
      }
    });
  }

  logger.info("Minted OAuth server token {name} for {principal}", {
    name: tokenName,
    principal: principalId,
  });

  return `${tokenName}.${plaintext}`;
}

export function oauthPrincipalId(sub: string): string {
  return `user:${sub}`;
}

export function oauthAccessTokenKey(tokenName: string): string {
  return `oauth-access-token-${tokenName}`;
}

export function createDeviceAuthDeps(
  authConfig: ServeAuthConfig & { oauthClientId: string },
  clientSecret: string,
  repoDir: string,
  repoContext: RepositoryContext,
  defaultVault?: string,
  syncService?: DatastoreSyncService,
  namespace?: string,
  syncGate?: SyncGate,
  auditEmitter?: AuditEmitter,
  instanceId?: string,
  sourceIp?: string,
  resolvedUserNames?: Readonly<Record<string, string>>,
  confirmReplicated?: () => Promise<void>,
  onUsernamesResolved?: UsernamesResolved,
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
    mintServerToken: (
      principalId: string,
      principalEmail: string,
      collectives: string[],
      groups: string[],
      rd: string,
      rc: RepositoryContext,
      username?: string,
      client?: string,
    ) =>
      // mint and push are one unit a poller pull must not interleave with;
      // never reached from a gated handler, so the non-reentrant gate is safe;
      // the token is handed out outside the gate once replicated
      withSyncGate(syncGate, () =>
        mintServerTokenImpl(
          principalId,
          principalEmail,
          collectives,
          groups,
          rd,
          rc,
          defaultVault,
          syncService,
          namespace,
          username,
          client,
        )).then(async (minted) => {
          await confirmReplicated?.();
          return minted;
        }),
    storeAccessToken: async (tokenName: string, accessToken: string) => {
      const vaultService = await VaultService.fromRepository(
        repoDir,
        { defaultVaultName: defaultVault },
      );
      await vaultService.put(
        TOKEN_SECRETS_VAULT_NAME,
        oauthAccessTokenKey(tokenName),
        accessToken,
      );
    },
    auditEmitter,
    instanceId,
    sourceIp,
    resolvedUserNames,
    onUsernamesResolved,
  };
}
