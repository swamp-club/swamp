// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import type { AuthClient } from "../../domain/auth/auth_service.ts";
import type { AuthResult, AuthSession } from "../../domain/auth/credentials.ts";

const DEFAULT_BASE_URL = "https://swamp.club";
const TIMEOUT_MS = 10_000;
const SESSION_COOKIE_NAME = "better-auth.session_token";

/**
 * HTTP adapter for the BetterAuth API on swamp-club.
 */
export class HttpAuthClient implements AuthClient {
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ??
      Deno.env.get("SWAMP_CLUB_URL") ??
      DEFAULT_BASE_URL;
  }

  async signIn(email: string, password: string): Promise<AuthResult> {
    return this.authenticate("/api/auth/sign-in/email", { email, password });
  }

  async signUp(
    email: string,
    password: string,
    name: string,
  ): Promise<AuthResult> {
    return this.authenticate("/api/auth/sign-up/email", {
      email,
      password,
      name,
    });
  }

  async signOut(token: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/auth/sign-out`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION_COOKIE_NAME}=${token}`,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  }

  async getSession(token: string): Promise<AuthSession | null> {
    try {
      const response = await fetch(`${this.baseUrl}/api/auth/get-session`, {
        method: "GET",
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${token}`,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }

      const body = await response.json();
      if (!body?.user || !body?.session) {
        return null;
      }

      return body as AuthSession;
    } catch {
      return null;
    }
  }

  private async authenticate(
    path: string,
    body: Record<string, string>,
  ): Promise<AuthResult> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => null);
        const message = errorBody?.message ?? errorBody?.error ??
          `Server returned ${response.status}`;
        return { ok: false, error: message };
      }

      // Extract session token from Set-Cookie header
      const token = this.extractSessionToken(response);
      if (!token) {
        // Some BetterAuth configurations return the token in the response body
        const responseBody = await response.json().catch(() => null);
        if (responseBody?.token) {
          return {
            ok: true,
            session: responseBody as AuthSession,
            token: responseBody.token,
          };
        }
        return { ok: false, error: "No session token in response" };
      }

      const session = await response.json() as AuthSession;
      return { ok: true, session, token };
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        return { ok: false, error: "Connection timed out" };
      }
      if (error instanceof TypeError) {
        return { ok: false, error: "Could not connect to server" };
      }
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  private extractSessionToken(response: Response): string | null {
    // Check all Set-Cookie headers
    const setCookieHeaders = response.headers.getSetCookie?.() ?? [];
    for (const cookie of setCookieHeaders) {
      const match = cookie.match(
        new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`),
      );
      if (match) {
        return match[1];
      }
    }

    // Fallback: check single set-cookie header
    const singleCookie = response.headers.get("set-cookie");
    if (singleCookie) {
      const match = singleCookie.match(
        new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`),
      );
      if (match) {
        return match[1];
      }
    }

    return null;
  }
}
