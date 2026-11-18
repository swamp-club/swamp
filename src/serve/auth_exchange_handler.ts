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

import {
  type AdmissionLists,
  checkPrincipalAdmission,
} from "../domain/access/admission.ts";
import { parsePrincipal } from "../domain/access/principal.ts";
import type {
  AuthMode,
  ServeAuthConfig,
} from "../domain/access/serve_auth_config.ts";
import type { SignInGrant } from "../domain/access/sign_in_code.ts";
import { UserError } from "../domain/errors.ts";
import type { AuditEmitter } from "../domain/serve_audit/audit_emitter.ts";
import type { AuditOutcome } from "../domain/serve_audit/audit_event.ts";
import { buildAuditEvent } from "../domain/serve_audit/audit_event_builder.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import {
  type ExchangeMinted,
  type ExchangeMintInput,
  MAX_AUTH_BODY_BYTES,
} from "./device_auth_handler.ts";
import { ROOT_ADDRESS_FLAG } from "./host/serve_process.ts";
import { workspaceNameUnder } from "./host/workspace_path.ts";
import {
  displayPrincipal,
  usernameFromLogin,
  type UsernamesResolved,
} from "./known_usernames.ts";
import { AUTH_EXCHANGE_PATH } from "./protocol.ts";
import { failedAttemptKey, limitFailedAttempts } from "./rate_limiter.ts";
import type { SignInCodeRedeemClient } from "./sign_in_code_redeem_client.ts";
import { readBodyWithLimit } from "./webhook.ts";

const logger = getSwampLogger(["serve", "auth-exchange"]);

const MAX_CODE_LENGTH = 256;

export interface ExchangeTarget {
  readonly rootAddress: string;
  readonly workspace: string;
}

/** undefined when the host passed no root address: such a serve offers no exchange */
export function exchangeTarget(
  rootAddress: string | undefined,
  address: string | undefined,
): ExchangeTarget | undefined {
  if (rootAddress === undefined) return undefined;
  const workspace = address === undefined
    ? null
    : workspaceNameUnder(rootAddress, address);
  if (workspace === null) {
    throw new UserError(
      `${ROOT_ADDRESS_FLAG} is given by a host to a workspace whose --address is <root address>/w/<name>.`,
    );
  }
  return { rootAddress, workspace };
}

export function exchangeOffered(
  target: ExchangeTarget | undefined,
  mode: AuthMode,
): boolean {
  return target !== undefined && mode !== "none";
}

export function authInfoBody(
  authConfig: Pick<ServeAuthConfig, "mode" | "oauthProvider">,
  offersExchange: boolean,
): Record<string, string | boolean> {
  return {
    mode: authConfig.mode,
    ...(authConfig.mode === "oauth"
      ? { verificationBaseUri: authConfig.oauthProvider }
      : {}),
    ...(offersExchange ? { exchange: true } : {}),
  };
}

export interface AuthExchangeDeps {
  readonly mode: "token" | "oauth";
  /** the workspace's own lists, read per exchange; oauth only */
  readonly admissionLists: () => AdmissionLists;
  readonly redeemer: SignInCodeRedeemClient;
  readonly mint: (input: ExchangeMintInput) => Promise<ExchangeMinted>;
  readonly sourceIp: string;
  readonly now?: () => number;
  readonly auditEmitter?: AuditEmitter;
  readonly instanceId?: string;
  readonly onUsernamesResolved?: UsernamesResolved;
}

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function audit(
  deps: AuthExchangeDeps,
  action: string,
  outcome: AuditOutcome,
  grant: SignInGrant | null,
  detail?: string,
  tokenName?: string,
): void {
  if (deps.auditEmitter === undefined) return;
  const principal = grant === null ? null : parsePrincipal(grant.principal);
  deps.auditEmitter.emit(buildAuditEvent({
    instanceId: deps.instanceId ?? "unknown",
    category: "auth",
    stage: "response",
    outcome,
    action,
    resourceKind: tokenName ? "server-token" : "server",
    resourceName: tokenName ?? deps.instanceId ?? "unknown",
    principalKind: principal?.kind ?? "anonymous",
    principalId: principal?.id ?? "anonymous",
    initiatedBy: principal === null ? "anonymous" : displayPrincipal(
      principal,
      grant?.username ? { [principal.id]: grant.username } : undefined,
    ),
    ...(grant !== null && (grant.username || grant.email)
      ? {
        actor: {
          ...(grant.username ? { username: grant.username } : {}),
          ...(grant.email ? { email: grant.email } : {}),
        },
      }
      : {}),
    sourceIp: deps.sourceIp,
    requestId: crypto.randomUUID(),
    detail,
  }));
}

/**
 * null for any other path; `deps` is null on a serve that offers no exchange.
 * The caller's root token never reaches here: only the code does.
 */
export async function handleAuthExchange(
  req: Request,
  deps: AuthExchangeDeps | null,
): Promise<Response | null> {
  if (new URL(req.url).pathname !== AUTH_EXCHANGE_PATH) return null;
  if (deps === null) return json(404, { error: "exchange_not_offered" });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  const bytes = await readBodyWithLimit(req, MAX_AUTH_BODY_BYTES);
  if (bytes === null) return json(413, { error: "body_too_large" });
  let code: unknown;
  try {
    code = (JSON.parse(new TextDecoder().decode(bytes)) ?? {}).code;
  } catch {
    return json(400, { error: "invalid_body" });
  }
  if (
    typeof code !== "string" || code.length === 0 ||
    code.length > MAX_CODE_LENGTH
  ) {
    return json(400, { error: "invalid_body" });
  }

  const now = deps.now ?? Date.now;
  // only a refused code counts, so the root being down never locks a caller out
  const guarded = await limitFailedAttempts(
    failedAttemptKey(null, deps.sourceIp, "auth-exchange"),
    async () => {
      const outcome = await deps.redeemer.redeem(code, req.signal);
      return { ok: outcome.ok || outcome.reason !== "refused", outcome };
    },
  );
  if (guarded.limited) {
    return json(429, { error: "too_many_requests" }, {
      "Retry-After": String(guarded.retryAfterSeconds),
    });
  }
  const { outcome } = guarded.result;
  if (!outcome.ok) {
    if (outcome.reason === "unavailable") {
      logger.warn("Sign-in exchange could not redeem at the root: {detail}", {
        detail: outcome.detail,
      });
      return json(502, { error: "root_unavailable" });
    }
    audit(deps, "auth.exchange.denied", "denied", null, "code refused");
    return json(401, { error: "code_refused" });
  }
  const grant = outcome.grant;
  if (!(Date.parse(grant.expiresAt) > now())) {
    audit(deps, "auth.exchange.denied", "denied", grant, "root token expired");
    return json(401, { error: "code_refused" });
  }

  if (deps.mode === "oauth") {
    const reason = !grant.email
      ? "the root holds no login identity for this principal"
      : (() => {
        const result = checkPrincipalAdmission(
          grant.principal,
          grant.collectives,
          deps.admissionLists(),
        );
        return result.admitted ? null : result.reason;
      })();
    if (reason !== null) {
      logger.info("Sign-in exchange denied for {principal}: {reason}", {
        principal: grant.principal,
        reason,
      });
      audit(deps, "auth.exchange.denied", "denied", grant, reason);
      return json(403, { error: "not_admitted", reason });
    }
  }

  let minted: ExchangeMinted;
  try {
    minted = await deps.mint({
      principalId: grant.principal,
      email: grant.email,
      username: grant.username,
      collectives: grant.collectives,
      groups: grant.groups,
      notAfter: grant.expiresAt,
      oauthIdentity: deps.mode === "oauth",
    });
  } catch (error) {
    logger.error("Sign-in exchange could not mint a token: {error}", {
      error: error instanceof Error ? error.message : String(error),
    });
    return json(500, { error: "internal_error" });
  }
  const tokenName = minted.token.split(".")[0];
  const learned = usernameFromLogin(
    grant.principal,
    grant.username ? { username: grant.username } : undefined,
  );
  if (Object.keys(learned).length > 0) deps.onUsernamesResolved?.(learned);
  logger.info("Sign-in exchange minted {name} for {principal}", {
    name: tokenName,
    principal: grant.principal,
  });
  audit(
    deps,
    "auth.exchange.completed",
    "success",
    grant,
    undefined,
    tokenName,
  );
  return json(200, {
    token: minted.token,
    expiresAt: minted.expiresAt,
    principal: {
      id: grant.principal,
      email: grant.email,
      username: grant.username,
      collectives: grant.collectives,
      groups: grant.groups,
    },
  });
}
