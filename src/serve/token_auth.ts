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

import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import {
  SERVER_TOKEN_MODEL_TYPE,
  type ServerToken,
  ServerTokenSchema,
  validateServerToken,
} from "../domain/models/access/server_token_model.ts";
import { VaultService } from "../domain/vaults/vault_service.ts";
import type { AuditEmitter } from "../domain/serve_audit/audit_emitter.ts";
import type { AuditEvent } from "../domain/serve_audit/audit_event.ts";
import { buildAuditEvent } from "../domain/serve_audit/audit_event_builder.ts";
import { parsePrincipal } from "../domain/access/principal.ts";

const logger = getSwampLogger(["serve", "token-auth"]);

const TOKEN_DATA_NAME = "token-main";

export interface ServerTokenAuthDeps {
  readonly readToken: (name: string) => Promise<ServerToken>;
  readonly readSecret: (
    vaultName: string,
    secretKey: string,
  ) => Promise<string>;
}

export interface TokenAuthAuditContext {
  readonly emitter?: Pick<AuditEmitter, "emit">;
  readonly instanceId?: string;
  readonly sourceIp?: string;
  readonly requestId?: string;
  readonly ingress?: string;
}

/**
 * Reads a server token's lifecycle record from the repository. Both
 * authentication at upgrade and the revalidation of open sessions read through
 * here, so the two paths always agree on what a token's state is. A token whose
 * definition or record is gone throws a "does not exist" error.
 */
export async function readServerTokenRecord(
  repoContext: RepositoryContext,
  name: string,
): Promise<ServerToken> {
  const definition = await repoContext.definitionRepo.findByName(
    SERVER_TOKEN_MODEL_TYPE,
    name,
  );
  if (definition === null) {
    throw new Error(
      `Server token '${name}' does not exist — mint it first`,
    );
  }
  const content = await repoContext.unifiedDataRepo.getContent(
    SERVER_TOKEN_MODEL_TYPE,
    definition.id,
    TOKEN_DATA_NAME,
  );
  if (content === null) {
    throw new Error(
      `Server token '${name}' does not exist — mint it first`,
    );
  }
  return ServerTokenSchema.parse(
    JSON.parse(new TextDecoder().decode(content)),
  );
}

export async function createServerTokenAuthDeps(
  repoDir: string,
  repoContext: RepositoryContext,
): Promise<ServerTokenAuthDeps> {
  const vaultService = await VaultService.fromRepository(repoDir);
  return {
    readToken: (name) => readServerTokenRecord(repoContext, name),
    readSecret: (vaultName, secretKey) =>
      vaultService.get(
        vaultName,
        secretKey,
        "model:server-token-verify",
      ),
  };
}

/**
 * Splits a presented server token of the form `<name>.<secret>`.
 * The name half addresses the token aggregate; the secret half is compared
 * against the vault-stored plaintext.
 */
export function splitServerToken(
  presented: string,
): { name: string; secret: string } | null {
  const dot = presented.indexOf(".");
  if (dot <= 0 || dot === presented.length - 1) {
    return null;
  }
  return { name: presented.slice(0, dot), secret: presented.slice(dot + 1) };
}

export type WebSocketTokenTransport = "bearer" | "subprotocol" | "query";

export interface ExtractedWebSocketToken {
  token: string;
  transport: WebSocketTokenTransport;
}

const BEARER_PREFIX_LEN = "Bearer ".length;
const SUBPROTOCOL_PREFIX = "bearer.";

export function extractWebSocketToken(
  req: Request,
): ExtractedWebSocketToken | null {
  const authHeader = req.headers.get("authorization");
  if (
    authHeader !== null &&
    authHeader.slice(0, BEARER_PREFIX_LEN).toLowerCase() === "bearer "
  ) {
    const token = authHeader.slice(BEARER_PREFIX_LEN);
    if (token.length > 0) {
      return { token, transport: "bearer" };
    }
  }

  const protocols = req.headers.get("sec-websocket-protocol");
  if (protocols !== null) {
    for (const entry of protocols.split(",")) {
      const trimmed = entry.trim();
      if (trimmed.startsWith(SUBPROTOCOL_PREFIX)) {
        const token = trimmed.slice(SUBPROTOCOL_PREFIX.length);
        if (token.length > 0) {
          return { token, transport: "subprotocol" };
        }
      }
    }
  }

  const url = new URL(req.url);
  const tokenParam = url.searchParams.get("token");
  if (tokenParam !== null && tokenParam.length > 0) {
    return { token: tokenParam, transport: "query" };
  }

  return null;
}

export type TokenAuthRejectionReason =
  | "expired"
  | "revoked"
  | "secret-mismatch"
  | "invalid-principal"
  | "no-definition"
  | "invalid-format"
  | "vault-error"
  | "unknown";

export type ServerTokenAuthResult =
  | {
    ok: true;
    principalId: string;
    collectives: readonly string[];
    groups: readonly string[];
    /** Name of the token that authenticated. */
    tokenName: string;
    /**
     * The token record's `createdAt`. Rotation rewrites it, so it identifies
     * which mint of the name a session was opened with.
     */
    tokenCreatedAt: string;
  }
  | { ok: false; error: string; reason: TokenAuthRejectionReason };

export function classifyRedeemError(message: string): TokenAuthRejectionReason {
  if (message.includes("has expired")) return "expired";
  if (message.includes("has been revoked")) return "revoked";
  if (message.includes("does not match")) return "secret-mismatch";
  if (message.includes("does not exist")) return "no-definition";
  if (message.includes("Invalid token format")) return "invalid-format";
  if (
    message.includes("not found") || message.includes("Vault") ||
    message.includes("vault")
  ) {
    return "vault-error";
  }
  return "unknown";
}

/**
 * Validates a presented `<name>.<secret>` server token directly against its
 * lifecycle resource. Authentication is read-only; explicit model `redeem`
 * calls retain their `lastUsedAt` update behavior.
 */
const MAX_TOKEN_LENGTH = 512;

export async function authenticateServerToken(
  presented: string,
  repoDir: string,
  repoContext: RepositoryContext,
  auditContext?: TokenAuthAuditContext,
  authDeps?: ServerTokenAuthDeps,
): Promise<ServerTokenAuthResult> {
  if (presented.length > MAX_TOKEN_LENGTH) {
    return {
      ok: false,
      error: "Token exceeds maximum length",
      reason: "invalid-format",
    };
  }

  const split = splitServerToken(presented);
  if (split === null) {
    return {
      ok: false,
      error: "Invalid token format: expected <name>.<secret>",
      reason: "invalid-format",
    };
  }

  try {
    const deps = authDeps ??
      await createServerTokenAuthDeps(repoDir, repoContext);
    const token = await deps.readToken(split.name);
    const nowMs = Date.now();
    validateServerToken(token, split.name, presented, nowMs);
    const secret = await deps.readSecret(token.vaultName, token.secretKey);
    validateServerToken(token, split.name, presented, nowMs, secret);

    // Every caller parses the principal after a successful authentication;
    // a stored principal that does not parse (minted before mint validated
    // it, or hand-edited) must be a rejection, not a crash (swamp-club#2383).
    try {
      parsePrincipal(token.principalId);
    } catch (error) {
      logger.warn(
        "Token authentication rejected for {name} (invalid-principal): {error}",
        {
          name: split.name,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return {
        ok: false,
        error: "Authentication failed",
        reason: "invalid-principal",
      };
    }

    emitTokenUseAuditEvent(auditContext, split.name, token.principalId);
    logger.info("Authenticated token {name} as {principal}", {
      name: split.name,
      principal: token.principalId,
    });
    return {
      ok: true,
      principalId: token.principalId,
      collectives: token.collectives,
      groups: token.groups,
      tokenName: split.name,
      tokenCreatedAt: token.createdAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = classifyRedeemError(message);
    logger.warn(
      "Token authentication failed for {name} ({reason}): {error}",
      { name: split.name, reason, error: message },
    );
    return { ok: false, error: "Authentication failed", reason };
  }
}

function emitTokenUseAuditEvent(
  auditContext: TokenAuthAuditContext | undefined,
  tokenName: string,
  principalId: string,
): void {
  if (!auditContext?.emitter) return;
  try {
    const event: AuditEvent = buildAuditEvent({
      instanceId: auditContext.instanceId ?? "unknown",
      category: "auth",
      stage: "response",
      outcome: "success",
      action: "auth.token.used",
      resourceKind: "server-token",
      resourceName: tokenName,
      principalKind: "user",
      principalId,
      initiatedBy: principalId,
      sourceIp: auditContext.sourceIp ?? "unknown",
      requestId: auditContext.requestId ?? crypto.randomUUID(),
      detail: auditContext.ingress,
    });
    auditContext.emitter.emit(event);
  } catch (error) {
    logger.warn("Failed to emit server-token auth audit event: {error}", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
