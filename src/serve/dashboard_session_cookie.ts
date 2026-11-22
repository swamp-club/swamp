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

import { normalizeServerUrl } from "../domain/auth/server_url.ts";

export const PLAIN_DASHBOARD_SESSION_COOKIE = "swamp-dashboard-session";

const KEPT_NAME_BYTE = /^[A-Za-z0-9-]$/;

/** one per address path, so serves sharing a browser origin keep their own sessions */
export class DashboardSessionCookie {
  static readonly plain = new DashboardSessionCookie(
    PLAIN_DASHBOARD_SESSION_COOKIE,
    "/",
  );

  private constructor(readonly name: string, readonly path: string) {}

  /**
   * The dashboard bundle calls origin-absolute paths, so only a host's
   * workspace, reached under its path on a shared origin, scopes its cookie.
   */
  static forServe(
    address: string | undefined,
    hostedWorkspace: boolean,
  ): DashboardSessionCookie {
    return hostedWorkspace
      ? DashboardSessionCookie.forAddress(address)
      : DashboardSessionCookie.plain;
  }

  /** the path comes from the configured address, never a forwarding header */
  static forAddress(address: string | undefined): DashboardSessionCookie {
    if (address === undefined) return DashboardSessionCookie.plain;
    const path = new URL(normalizeServerUrl(address)).pathname;
    if (path === "" || path === "/") return DashboardSessionCookie.plain;
    return new DashboardSessionCookie(
      PLAIN_DASHBOARD_SESSION_COOKIE + escapeForCookieName(path),
      // a URL path may hold a literal semicolon, which would end the attribute
      path.replaceAll(";", "%3B"),
    );
  }

  setHeader(value: string, secure: boolean): string {
    return `${this.name}=${
      encodeURIComponent(value)
    }; Path=${this.path}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
  }

  expireHeader(secure: boolean): string {
    return `${this.setHeader("", secure)}; Max-Age=0`;
  }
}

// injective because the escape character is itself always escaped
function escapeForCookieName(path: string): string {
  let escaped = "";
  for (const byte of new TextEncoder().encode(path)) {
    const char = String.fromCharCode(byte);
    escaped += KEPT_NAME_BYTE.test(char)
      ? char
      : `_${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return escaped;
}
