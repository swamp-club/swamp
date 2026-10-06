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
  extractDashboardSessionToken,
} from "./token_auth.ts";
import {
  type DeviceAuthDeps,
  handleDeviceAuth,
} from "./device_auth_handler.ts";

export interface DashboardSessionDeps {
  authenticate(token: string): Promise<boolean>;
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

function sessionCreatedResponse(token: string, secure: boolean): Response {
  return new Response(null, {
    status: 204,
    headers: { "set-cookie": cookie(token, secure) },
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
  if (deps.originAllowed && !deps.originAllowed(req)) {
    return new Response("Forbidden", { status: 403 });
  }

  if (path !== "/auth/dashboard/session") {
    if (!deps.deviceAuthDeps) return null;
    return await handleDeviceAuth(req, deps.deviceAuthDeps, {
      startPath: "/auth/dashboard/device",
      tokenPath: "/auth/dashboard/device/token",
      onAuthenticated: (token) => sessionCreatedResponse(token, deps.secure),
    });
  }

  if (req.method === "DELETE") {
    return new Response(null, {
      status: 204,
      headers: { "set-cookie": expiredCookie(deps.secure) },
    });
  }

  if (req.method === "GET") {
    const token = extractDashboardSessionToken(req);
    if (token === null || !(await deps.authenticate(token))) {
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
  if (!(await deps.authenticate(body.token))) {
    return new Response("Unauthorized", { status: 401 });
  }
  return sessionCreatedResponse(body.token, deps.secure);
}
