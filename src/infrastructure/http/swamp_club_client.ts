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

import { UserError } from "../../domain/errors.ts";

/** Response from BetterAuth sign-in endpoint. */
export interface SignInResponse {
  token: string;
  user: {
    id: string;
    email: string;
    name: string;
    username: string;
  };
}

/** Response from BetterAuth API key creation endpoint. */
export interface CreateApiKeyResponse {
  id: string;
  key: string;
}

/** An organization the user belongs to. */
export interface WhoamiOrganization {
  slug: string;
  name: string;
  role: string;
  personal: boolean;
}

/** Response from the /api/whoami endpoint. */
export interface WhoamiResponse {
  authenticated: boolean;
  id?: string;
  username?: string;
  email?: string;
  name?: string;
  organizations?: WhoamiOrganization[];
}

/**
 * Returns the user's collectives (organization slugs) from a whoami response.
 * Returns undefined if the server doesn't include organizations.
 */
export function getCollectives(
  whoami: WhoamiResponse,
): string[] | undefined {
  if (!whoami.organizations) return undefined;
  return whoami.organizations.map((org) => org.slug);
}

/**
 * HTTP client for swamp-club API interactions.
 * Used by auth commands to sign in, create API keys, and verify identity.
 */
export class SwampClubClient {
  constructor(private readonly serverUrl: string) {}

  /**
   * Sign in with email/username and password.
   * Returns session token and user info.
   */
  async signIn(
    username: string,
    password: string,
  ): Promise<SignInResponse> {
    const res = await this.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: username, password }),
    });

    if (!res.ok) {
      const body = await res.text();
      if (res.status === 401 || res.status === 403) {
        throw new UserError("Invalid username/email or password.");
      }
      throw new UserError(
        `Sign-in failed (HTTP ${res.status}): ${body}`,
      );
    }

    const data = await res.json();
    return {
      token: data.token,
      user: data.user,
    };
  }

  /**
   * Create an API key for the authenticated user.
   * Requires a session token from sign-in.
   */
  async createApiKey(
    sessionToken: string,
    name: string,
  ): Promise<CreateApiKeyResponse> {
    const res = await this.fetch("/api/auth/api-key/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ name }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new UserError(
        `Failed to create API key (HTTP ${res.status}): ${body}`,
      );
    }

    const data = await res.json();
    return { id: data.id, key: data.key };
  }

  /**
   * Call /api/whoami to verify identity.
   * Authenticates using the x-api-key header.
   */
  async whoami(
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<WhoamiResponse> {
    const res = await this.fetch(
      "/api/whoami",
      { method: "GET", headers: { "x-api-key": apiKey } },
      signal,
    );

    if (!res.ok) {
      await res.body?.cancel();
      if (res.status === 401) {
        return { authenticated: false };
      }
      throw new UserError(
        `Whoami request failed (HTTP ${res.status})`,
      );
    }

    return await res.json();
  }

  /**
   * Submit a bug report or feature request to the Lab.
   * Authenticates using the x-api-key header. Tags every submission with
   * `source: "swamp"` so the Lab UI can attribute it to the CLI.
   */
  async submitIssue(
    apiKey: string,
    input: {
      type: "bug" | "feature" | "security";
      title: string;
      body: string;
    },
  ): Promise<{ number: number; id: string }> {
    const res = await this.fetch("/api/v1/lab/issues", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        source: "swamp",
        type: input.type,
        title: input.title,
        body: input.body,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new UserError(
        `Failed to submit issue (HTTP ${res.status}): ${body}`,
      );
    }

    const data = await res.json();
    return { number: data.issue.number, id: data.issue.id };
  }

  /**
   * Post a comment ("ripple") on an existing Lab issue.
   * Authenticates using the x-api-key header.
   *
   * Surfaces server-side error shapes the Lab returns:
   *   - 401 → not logged in
   *   - 403 → comments locked or no access
   *   - 404 → issue not found / not visible
   *   - 422 → profanity check failed (response includes `flagged` array)
   */
  async submitComment(
    apiKey: string,
    issueNumber: number,
    body: string,
  ): Promise<{ id: string }> {
    const res = await this.fetch(
      `/api/v1/lab/issues/${issueNumber}/comments`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({ body }),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      // Try to surface profanity-flagged words from the 422 body so the
      // user knows what to change without paging through raw JSON.
      if (res.status === 422) {
        try {
          const parsed = JSON.parse(text);
          if (
            parsed?.error && Array.isArray(parsed.flagged) &&
            parsed.flagged.length > 0
          ) {
            throw new UserError(
              `${parsed.error}: ${parsed.flagged.join(", ")}`,
            );
          }
        } catch (err) {
          if (err instanceof UserError) throw err;
          // fall through to the generic message below
        }
      }
      throw new UserError(
        `Failed to post ripple on issue #${issueNumber} (HTTP ${res.status}): ${text}`,
      );
    }

    const data = await res.json();
    return { id: data.id };
  }

  private async fetch(
    path: string,
    init: RequestInit,
    callerSignal?: AbortSignal,
  ): Promise<Response> {
    const url = `${this.serverUrl}${path}`;
    const timeoutSignal = AbortSignal.timeout(15000);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, timeoutSignal])
      : timeoutSignal;
    try {
      return await fetch(url, { ...init, signal });
    } catch (error) {
      // Re-throw AbortError from caller signal without wrapping
      if (
        callerSignal?.aborted && error instanceof DOMException &&
        error.name === "AbortError"
      ) {
        throw error;
      }
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new UserError(
          `Request to ${this.serverUrl} timed out. Is the server running?`,
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new UserError(
        `Could not connect to ${this.serverUrl}: ${message}`,
      );
    }
  }
}
