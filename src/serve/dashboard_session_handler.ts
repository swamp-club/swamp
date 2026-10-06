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
  DASHBOARD_SESSION_COOKIE,
  extractDashboardSessionId,
} from "./token_auth.ts";
import {
  type DeviceAuthDeps,
  handleDeviceAuth,
} from "./device_auth_handler.ts";
import { generateOpaqueToken } from "../domain/remote/session_credential.ts";

export interface DashboardSessionStore {
  create(serverToken: string, origin: string): string;
  get(sessionId: string): DashboardSession | null;
  delete(sessionId: string): void;
}

export interface DashboardSession {
  readonly serverToken: string;
  /** Exact origin that established this browser session. */
  readonly origin: string;
}

/** Returns the canonical HTTP(S) origin, or null for malformed input. */
export function normalizeDashboardOrigin(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Resolves a dashboard session only for the exact origin that created it.
 * This prevents a same-site page on another port from using the ambient
 * cookie during a WebSocket upgrade.
 */
export function resolveDashboardSessionForOrigin(
  sessionId: string,
  origin: string | null,
  sessions: DashboardSessionStore,
): string | null {
  const session = sessions.get(sessionId);
  const normalizedOrigin = origin === null
    ? null
    : normalizeDashboardOrigin(origin);
  if (
    session === null || normalizedOrigin === null ||
    session.origin !== normalizedOrigin
  ) {
    return null;
  }
  return session.serverToken;
}

/**
 * Per-serve-instance mapping of opaque browser sessions to server tokens.
 *
 * Browser cookies contain only a random session identifier. A serve restart
 * deliberately drops these sessions; the underlying server token continues to
 * follow its existing expiry and revocation rules.
 */
export class InMemoryDashboardSessionStore implements DashboardSessionStore {
  readonly #sessions = new Map<string, DashboardSession>();

  create(serverToken: string, origin: string): string {
    const sessionId = generateOpaqueToken();
    this.#sessions.set(sessionId, { serverToken, origin });
    return sessionId;
  }

  get(sessionId: string): DashboardSession | null {
    return this.#sessions.get(sessionId) ?? null;
  }

  delete(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }
}

export type DashboardSessionAuthentication =
  | { ok: true }
  | { ok: false; response: Response };

export interface DashboardSessionDeps {
  authenticate(token: string): Promise<DashboardSessionAuthentication>;
  sessions: DashboardSessionStore;
  secure: boolean;
  /** Browser-origin requests must be same-origin before changing a session. */
  originAllowed?(req: Request): boolean;
  deviceAuthDeps?: DeviceAuthDeps;
}

function cookie(value: string, secure: boolean): string {
  return `${DASHBOARD_SESSION_COOKIE}=${
    encodeURIComponent(value)
  }; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

function expiredCookie(secure: boolean): string {
  return `${cookie("", secure)}; Max-Age=0`;
}

function sessionCreatedResponse(
  token: string,
  origin: string,
  req: Request,
  deps: DashboardSessionDeps,
): Response {
  const previousSessionId = extractDashboardSessionId(req);
  if (previousSessionId !== null) deps.sessions.delete(previousSessionId);
  const sessionId = deps.sessions.create(token, origin);
  return new Response(null, {
    status: 204,
    headers: { "set-cookie": cookie(sessionId, deps.secure) },
  });
}

/** Handles browser-only dashboard session creation, inspection, and logout. */
export async function handleDashboardSession(
  req: Request,
  deps: DashboardSessionDeps,
): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  if (
    path !== "/auth/dashboard/session" &&
    path !== "/auth/dashboard/device" &&
    path !== "/auth/dashboard/device/token"
  ) {
    return null;
  }
  const requiresOrigin = req.method !== "GET";
  const receivedOrigin = req.headers.get("origin");
  const origin = receivedOrigin === null
    ? null
    : normalizeDashboardOrigin(receivedOrigin);
  if (
    requiresOrigin &&
    (origin === null || (deps.originAllowed && !deps.originAllowed(req)))
  ) {
    return new Response("Forbidden", { status: 403 });
  }

  if (path !== "/auth/dashboard/session") {
    if (!deps.deviceAuthDeps) return null;
    return await handleDeviceAuth(req, deps.deviceAuthDeps, {
      startPath: "/auth/dashboard/device",
      tokenPath: "/auth/dashboard/device/token",
      onAuthenticated: (token) =>
        sessionCreatedResponse(token, origin!, req, deps),
    });
  }

  if (req.method === "DELETE") {
    const sessionId = extractDashboardSessionId(req);
    if (sessionId !== null) deps.sessions.delete(sessionId);
    return new Response(null, {
      status: 204,
      headers: { "set-cookie": expiredCookie(deps.secure) },
    });
  }

  if (req.method === "GET") {
    const sessionId = extractDashboardSessionId(req);
    const session = sessionId === null ? null : deps.sessions.get(sessionId);
    if (session === null) return new Response(null, { status: 401 });
    const result = await deps.authenticate(session.serverToken);
    if (!result.ok) {
      return new Response(null, { status: 401 });
    }
    return Response.json({ authenticated: true });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  if (typeof body.token !== "string" || body.token.length === 0) {
    return new Response("Invalid token", { status: 400 });
  }
  const result = await deps.authenticate(body.token);
  if (!result.ok) return result.response;
  return sessionCreatedResponse(body.token, origin!, req, deps);
}
