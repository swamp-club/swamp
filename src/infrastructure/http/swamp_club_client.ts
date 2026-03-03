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

import type { ApiKeyData } from "../../domain/auth/api_key.ts";
import { UserError } from "../../domain/errors.ts";

export type { ApiKeyData };

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

/** Response from the /api/whoami endpoint. */
export interface WhoamiResponse {
  authenticated: boolean;
  id?: string;
  username?: string;
  email?: string;
  name?: string;
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
  async whoami(apiKey: string): Promise<WhoamiResponse> {
    const res = await this.fetch("/api/whoami", {
      method: "GET",
      headers: { "x-api-key": apiKey },
    });

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
   * List all API keys for the authenticated user.
   */
  async listApiKeys(token: string): Promise<ApiKeyData[]> {
    const res = await this.fetch("/api/auth/api-key/list", {
      method: "GET",
      headers: { "Authorization": `Bearer ${token}` },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new UserError(
        `Failed to list API keys (HTTP ${res.status}): ${body}`,
      );
    }

    return await res.json();
  }

  /**
   * Update an API key (e.g. to revoke by setting enabled=false).
   */
  async updateApiKey(
    token: string,
    keyId: string,
    enabled: boolean,
  ): Promise<void> {
    const res = await this.fetch("/api/auth/api-key/update", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ keyId, enabled }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new UserError(
        `Failed to update API key (HTTP ${res.status}): ${body}`,
      );
    }

    await res.body?.cancel();
  }

  /**
   * Permanently delete an API key.
   */
  async deleteApiKey(token: string, keyId: string): Promise<void> {
    const res = await this.fetch("/api/auth/api-key/delete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ keyId }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new UserError(
        `Failed to delete API key (HTTP ${res.status}): ${body}`,
      );
    }

    await res.body?.cancel();
  }

  private async fetch(path: string, init: RequestInit): Promise<Response> {
    const url = `${this.serverUrl}${path}`;
    try {
      return await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
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
