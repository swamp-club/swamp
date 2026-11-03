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
import type {
  AccessResource,
  PolicySnapshotLoader,
} from "../domain/access/mod.ts";
import {
  authenticateDashboardSession,
  authenticateServerToken,
  type ServerTokenAuthResult,
  shouldInvalidateDashboardSession,
} from "./token_auth.ts";
import type { DashboardSession } from "./dashboard_session_store.ts";
import { parsePrincipal } from "../domain/access/principal.ts";
import {
  checkIpBurst,
  limitFailedAttempts,
  rateLimitKey,
} from "./rate_limiter.ts";
import type { AuditEmitter } from "../domain/serve_audit/audit_emitter.ts";
import type { UsernamesResolved } from "./known_usernames.ts";

export interface AdminAuthDeps {
  readonly authMode: string;
  readonly repoDir: string;
  readonly repoContext: RepositoryContext;
  readonly policySnapshotLoader: PolicySnapshotLoader | null;
  readonly trustProxy: boolean;
  readonly auditEmitter?: AuditEmitter;
  readonly instanceId?: string;
  readonly resolvedUserNames?: Readonly<Record<string, string>>;
  readonly onUsernamesResolved?: UsernamesResolved;
}

type AuthenticatedPrincipal = Omit<
  ServerTokenAuthResult & { ok: true },
  "tokenName" | "tokenCreatedAt"
>;

// Per-request HTTP admin auth holds no session, so the token identity that
// binds WebSocket sessions is not part of it (auth-mode none has no token).
export type AdminAuthResult =
  | { ok: true; authResult: AuthenticatedPrincipal }
  | { ok: false; response: Response };

export type TokenAuthResult =
  | {
    ok: true;
    authResult: AuthenticatedPrincipal;
    token: { name: string; createdAt: string } | null;
    clientAddr: string;
  }
  | { ok: false; response: Response };

export type DashboardSessionTokenAuthResult =
  | Extract<TokenAuthResult, { ok: true }>
  | { ok: false; response: Response; invalidateSession: boolean };

export type DashboardSessionIpBurstResult =
  | { ok: true; clientAddr: string }
  | { ok: false; response: Response };

/**
 * Applies the IP burst limit before a dashboard cookie causes any control-plane
 * lookup. Call this before resolving a dashboard session from its opaque ID.
 */
export function checkDashboardSessionIpBurst(
  req: Request,
  remoteAddr: string,
  deps: AdminAuthDeps,
): DashboardSessionIpBurstResult {
  const clientAddr = deps.trustProxy
    ? (req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? remoteAddr)
    : remoteAddr;
  const ipBurst = checkIpBurst(clientAddr);
  if (!ipBurst.allowed) {
    return {
      ok: false,
      response: new Response("Too Many Requests", {
        status: 429,
        headers: { "Retry-After": String(ipBurst.retryAfterSeconds) },
      }),
    };
  }
  return { ok: true, clientAddr };
}

export async function authenticateToken(
  req: Request,
  remoteAddr: string,
  deps: AdminAuthDeps,
): Promise<TokenAuthResult> {
  const clientAddr = deps.trustProxy
    ? (req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? remoteAddr)
    : remoteAddr;

  if (deps.authMode === "none") {
    return {
      ok: true,
      authResult: {
        ok: true,
        principalId: "@anonymous",
        collectives: [],
        groups: [],
      },
      token: null,
      clientAddr,
    };
  }

  const authHeader = req.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return {
      ok: false,
      response: new Response("Unauthorized: token required", { status: 401 }),
    };
  }

  const ipBurst = checkIpBurst(clientAddr);
  if (!ipBurst.allowed) {
    return {
      ok: false,
      response: new Response("Too Many Requests", {
        status: 429,
        headers: { "Retry-After": String(ipBurst.retryAfterSeconds) },
      }),
    };
  }

  const guarded = await limitFailedAttempts(
    rateLimitKey(token, clientAddr),
    () =>
      authenticateServerToken(
        token,
        deps.repoDir,
        deps.repoContext,
        {
          emitter: deps.auditEmitter,
          instanceId: deps.instanceId,
          sourceIp: clientAddr,
          ingress: new URL(req.url).pathname,
          resolvedUserNames: deps.resolvedUserNames,
          onUsernamesResolved: deps.onUsernamesResolved,
        },
      ),
  );
  if (guarded.limited) {
    return {
      ok: false,
      response: new Response("Too Many Requests", {
        status: 429,
        headers: { "Retry-After": String(guarded.retryAfterSeconds) },
      }),
    };
  }

  const authResult = guarded.result;
  if (!authResult.ok) {
    return {
      ok: false,
      response: new Response(
        `Unauthorized: ${authResult.reason}`,
        { status: 401 },
      ),
    };
  }

  const { tokenName, tokenCreatedAt, ...principal } = authResult;
  return {
    ok: true,
    authResult: principal,
    token: { name: tokenName, createdAt: tokenCreatedAt },
    clientAddr,
  };
}

/**
 * for an origin-validated, burst-limited dashboard session on the health
 * transports; never use for admin routes
 */
export async function authenticateDashboardSessionToken(
  req: Request,
  clientAddr: string,
  deps: AdminAuthDeps,
  session: DashboardSession,
): Promise<DashboardSessionTokenAuthResult> {
  const guarded = await limitFailedAttempts(
    rateLimitKey(`${session.tokenName}.${session.id}`, clientAddr),
    () =>
      authenticateDashboardSession(
        session,
        deps.repoContext,
        {
          emitter: deps.auditEmitter,
          instanceId: deps.instanceId,
          sourceIp: clientAddr,
          ingress: new URL(req.url).pathname,
          resolvedUserNames: deps.resolvedUserNames,
          onUsernamesResolved: deps.onUsernamesResolved,
        },
      ),
  );
  if (guarded.limited) {
    return {
      ok: false,
      invalidateSession: false,
      response: new Response("Too Many Requests", {
        status: 429,
        headers: { "Retry-After": String(guarded.retryAfterSeconds) },
      }),
    };
  }
  const authResult = guarded.result;
  if (!authResult.ok) {
    return {
      ok: false,
      invalidateSession: shouldInvalidateDashboardSession(authResult.reason),
      response: new Response(`Unauthorized: ${authResult.reason}`, {
        status: 401,
      }),
    };
  }
  const { tokenName, tokenCreatedAt, ...principal } = authResult;
  return {
    ok: true,
    authResult: principal,
    token: { name: tokenName, createdAt: tokenCreatedAt },
    clientAddr,
  };
}

export async function authenticateAdmin(
  req: Request,
  remoteAddr: string,
  deps: AdminAuthDeps,
): Promise<AdminAuthResult> {
  const authenticated = await authenticateToken(req, remoteAddr, deps);
  if (!authenticated.ok) return authenticated;
  if (deps.authMode === "none") {
    return { ok: true, authResult: authenticated.authResult };
  }
  const authResult = authenticated.authResult;

  if (!deps.policySnapshotLoader) {
    return {
      ok: false,
      response: Response.json({
        status: "error",
        message:
          "Authorization enforcement is enabled but no policy snapshot is available",
      }, { status: 403 }),
    };
  }

  const principal = parsePrincipal(authResult.principalId);
  const service = deps.policySnapshotLoader.decisionService;
  const decision = service.decide(
    {
      principal,
      collectives: [...authResult.collectives],
      groups: [...authResult.groups],
    },
    "admin",
    { kind: "access", name: "*", fields: {} },
  );

  if (!decision || decision.effect !== "allow") {
    return {
      ok: false,
      response: Response.json({
        status: "error",
        message: "Access denied: requires admin permission",
      }, { status: 403 }),
    };
  }

  return { ok: true, authResult };
}

/**
 * explicit allow or deny wins and a resource no grant covers is admin-only, as
 * filterByResources; each call reads the current snapshot so streams follow
 * grant changes
 */
export interface ReadAuthorizer {
  isAdmin(): boolean;
  canRead(resource: AccessResource): boolean;
}

export function createReadAuthorizer(
  principal: AuthenticatedPrincipal,
  deps: Pick<AdminAuthDeps, "authMode" | "policySnapshotLoader">,
): ReadAuthorizer {
  if (deps.authMode === "none") {
    return { isAdmin: () => true, canRead: () => true };
  }
  const loader = deps.policySnapshotLoader;
  if (!loader) {
    return { isAdmin: () => false, canRead: () => false };
  }
  const accessPrincipal = {
    principal: parsePrincipal(principal.principalId),
    collectives: [...principal.collectives],
    groups: [...principal.groups],
  };
  const isAdmin = () => {
    const decision = loader.decisionService.decide(
      accessPrincipal,
      "admin",
      { kind: "access", name: "*", fields: {} },
    );
    return decision !== null && decision.effect === "allow";
  };
  return {
    isAdmin,
    canRead(resource) {
      const decision = loader.decisionService.decide(
        accessPrincipal,
        "read",
        resource,
      );
      if (decision) return decision.effect === "allow";
      return isAdmin();
    },
  };
}
