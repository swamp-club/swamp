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

import { parsePrincipal } from "../domain/access/principal.ts";
import type { AccessCaller } from "./handlers/shared.ts";
import {
  checkIpBurst,
  checkPrincipalRate,
  limitFailedAttempts,
  rateLimitKey,
} from "./rate_limiter.ts";
import { resolveDashboardSessionForOrigin } from "./dashboard_session_handler.ts";
import type {
  DashboardSession,
  DashboardSessionStore,
} from "./dashboard_session_store.ts";
import {
  extractDashboardSessionId,
  type ServerTokenAuthResult,
  shouldInvalidateDashboardSession,
} from "./token_auth.ts";

/** The principal an unauthenticated server (`--auth-mode none`) stamps. */
export const ANONYMOUS_PRINCIPAL = "@anonymous";

export interface HttpCallerAuthDeps {
  readonly authMode: string;
  /** Not called when authorization is off. */
  readonly authenticate: (
    token: string,
    sourceIp: string,
  ) => Promise<ServerTokenAuthResult>;
  readonly now?: () => number;
  /** the per-principal request rate; on unless false */
  readonly limitPrincipalRate?: boolean;
  /**
   * accepts the dashboard's session cookie from the exact origin that created
   * it; absent, only a bearer token is accepted
   */
  readonly dashboardSession?: HttpCallerSessionAuth;
}

export interface HttpCallerSessionAuth {
  readonly sessions: DashboardSessionStore;
  readonly authenticate: (
    session: DashboardSession,
    sourceIp: string,
  ) => Promise<ServerTokenAuthResult>;
}

export interface HttpCallerToken {
  readonly name: string;
  readonly createdAt: string;
  readonly principalId: string;
}

export interface HttpCaller {
  readonly access: AccessCaller;
  /** The principal stamped on its writes. */
  readonly principal: string;
  /** absent when authorization is off */
  readonly token?: HttpCallerToken;
}

/**
 * Callers that fail to authenticate count toward the IP's burst; an
 * authenticated caller is limited per principal instead.
 */
export async function authenticateHttpCaller(
  req: Request,
  sourceIp: string,
  deps: HttpCallerAuthDeps,
): Promise<HttpCaller | Response> {
  if (deps.authMode === "none") {
    return {
      access: { principal: null, collectives: [], groups: [], sourceIp },
      principal: ANONYMOUS_PRINCIPAL,
    };
  }
  const token = bearerToken(req);
  if (token === null) {
    const sessionAuth = deps.dashboardSession;
    const sessionId = sessionAuth === undefined
      ? null
      : extractDashboardSessionId(req);
    if (sessionAuth !== undefined && sessionId !== null) {
      return await authenticateSessionCaller(
        req,
        sessionId,
        sourceIp,
        deps,
        sessionAuth,
      );
    }
    const ipBurst = checkIpBurst(sourceIp);
    if (!ipBurst.allowed) return tooManyRequests(ipBurst.retryAfterSeconds);
    return httpFailure(401, "unauthorized", "Unauthorized: token required");
  }
  const guarded = await limitFailedAttempts(
    rateLimitKey(token, sourceIp),
    () => deps.authenticate(token, sourceIp),
  );
  if (guarded.limited) return tooManyRequests(guarded.retryAfterSeconds);
  const auth = guarded.result;
  if (!auth.ok) {
    const ipBurst = checkIpBurst(sourceIp);
    if (!ipBurst.allowed) return tooManyRequests(ipBurst.retryAfterSeconds);
    return httpFailure(401, "unauthorized", `Unauthorized: ${auth.reason}`);
  }
  return authenticatedCaller(auth, sourceIp, deps);
}

/**
 * The origin binding is what makes a cookie-authenticated POST safe: a page on
 * another origin, same-site ports included, never resolves the session.
 */
async function authenticateSessionCaller(
  req: Request,
  sessionId: string,
  sourceIp: string,
  deps: HttpCallerAuthDeps,
  sessionAuth: HttpCallerSessionAuth,
): Promise<HttpCaller | Response> {
  const session = await resolveDashboardSessionForOrigin(
    sessionId,
    req.headers.get("origin"),
    sessionAuth.sessions,
  );
  if (session === null) {
    // a known session from the wrong origin presented a real cookie, not a
    // guess, so only an unknown session counts toward the IP burst
    if (await sessionAuth.sessions.get(sessionId) !== null) {
      return httpFailure(
        403,
        "forbidden",
        "Forbidden: dashboard session origin mismatch",
      );
    }
    const ipBurst = checkIpBurst(sourceIp);
    if (!ipBurst.allowed) return tooManyRequests(ipBurst.retryAfterSeconds);
    return httpFailure(
      401,
      "unauthorized",
      "Unauthorized: dashboard session expired",
    );
  }
  const guarded = await limitFailedAttempts(
    rateLimitKey(`${session.tokenName}.${session.id}`, sourceIp),
    () => sessionAuth.authenticate(session, sourceIp),
  );
  if (guarded.limited) return tooManyRequests(guarded.retryAfterSeconds);
  const auth = guarded.result;
  if (!auth.ok) {
    if (shouldInvalidateDashboardSession(auth.reason)) {
      await sessionAuth.sessions.delete(session.id);
    }
    const ipBurst = checkIpBurst(sourceIp);
    if (!ipBurst.allowed) return tooManyRequests(ipBurst.retryAfterSeconds);
    return httpFailure(401, "unauthorized", `Unauthorized: ${auth.reason}`);
  }
  return authenticatedCaller(auth, sourceIp, deps);
}

function authenticatedCaller(
  auth: Extract<ServerTokenAuthResult, { ok: true }>,
  sourceIp: string,
  deps: HttpCallerAuthDeps,
): HttpCaller | Response {
  if (deps.limitPrincipalRate !== false) {
    const rate = checkPrincipalRate(auth.principalId, deps.now?.());
    if (!rate.allowed) return tooManyRequests(rate.retryAfterSeconds);
  }
  return {
    access: {
      principal: parsePrincipal(auth.principalId),
      collectives: auth.collectives,
      groups: auth.groups,
      sourceIp,
      loginIdentity: auth.oauthIdentity,
    },
    principal: auth.principalId,
    token: {
      name: auth.tokenName,
      createdAt: auth.tokenCreatedAt,
      principalId: auth.principalId,
    },
  };
}

const BEARER_PREFIX_LEN = "Bearer ".length;

export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (
    header === null ||
    header.slice(0, BEARER_PREFIX_LEN).toLowerCase() !== "bearer "
  ) return null;
  const token = header.slice(BEARER_PREFIX_LEN);
  return token.length > 0 ? token : null;
}

export function httpFailure(
  status: number,
  code: string,
  message: string,
): Response {
  return Response.json({ code, message }, { status });
}

export function tooManyRequests(retryAfterSeconds: number): Response {
  return Response.json(
    { code: "rate_limited", message: "Too Many Requests" },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}
