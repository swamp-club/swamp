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

import { join } from "@std/path";
import { atomicWriteTextFile } from "./atomic_write.ts";
import { getSwampConfigDir } from "./paths.ts";
import {
  apiKeyFingerprint,
  type AuthCredentials,
  DEFAULT_SWAMP_CLUB_URL,
  LEGACY_SWAMP_CLUB_URL,
} from "../../domain/auth/auth_credentials.ts";

const AUTH_FILE = "auth.json";

/**
 * Optional overrides for `AuthRepository`. Used by tests to bypass the
 * shared `Deno.env` global, which races across files when
 * `deno test --parallel` runs multiple auth-touching test files at
 * once. Production callers pass nothing and get env-reading defaults.
 */
export interface AuthRepositoryOptions {
  /** Override the config dir; default is `getSwampConfigDir()`. */
  configDir?: string;
  /**
   * Override the SWAMP_API_KEY lookup; default reads
   * `Deno.env.get("SWAMP_API_KEY")` lazily at call time.
   */
  getApiKey?: () => string | undefined;
  /**
   * Override the SWAMP_CLUB_URL lookup; default reads
   * `Deno.env.get("SWAMP_CLUB_URL")` lazily at call time.
   */
  getServerUrl?: () => string | undefined;
}

/**
 * Repository for managing swamp-club authentication credentials.
 * Stores API key and server info at ~/.config/swamp/auth.json
 * (or $XDG_CONFIG_HOME/swamp/auth.json).
 *
 * Precedence: SWAMP_API_KEY env var > auth.json file.
 */
export class AuthRepository {
  private readonly getConfigDir: () => string;
  private readonly getApiKey: () => string | undefined;
  private readonly getServerUrl: () => string | undefined;

  constructor(options: AuthRepositoryOptions = {}) {
    this.getConfigDir = options.configDir !== undefined
      ? () => options.configDir!
      : getSwampConfigDir;
    this.getApiKey = options.getApiKey ??
      (() => Deno.env.get("SWAMP_API_KEY"));
    this.getServerUrl = options.getServerUrl ??
      (() => Deno.env.get("SWAMP_CLUB_URL"));
  }

  private getAuthPath(): string {
    return join(this.getConfigDir(), AUTH_FILE);
  }

  /**
   * Read auth credentials. Checks SWAMP_API_KEY env var first,
   * then falls back to auth.json file. Returns null if neither exists.
   *
   * When SWAMP_API_KEY is set, cached identity (username, collectives)
   * is merged from auth.json if the server URL and key fingerprint match.
   * This gives API-key users the same identity resolution as login users.
   */
  async load(): Promise<AuthCredentials | null> {
    const envApiKey = this.getApiKey();
    if (envApiKey) {
      const serverUrl = this.getServerUrl() ?? DEFAULT_SWAMP_CLUB_URL;
      const fingerprint = apiKeyFingerprint(envApiKey);

      let username = "";
      let collectives: string[] | undefined;
      let scopes: string[] | undefined;
      try {
        const content = await Deno.readTextFile(this.getAuthPath());
        const cached = JSON.parse(content) as AuthCredentials;
        if (
          cached.apiKeyFingerprint === fingerprint &&
          (cached.serverUrl === serverUrl || !cached.serverUrl)
        ) {
          username = cached.username ?? "";
          collectives = cached.collectives;
          scopes = cached.scopes;
        }
      } catch {
        // No cached identity — will be populated on first whoami
      }

      return {
        serverUrl,
        apiKey: envApiKey,
        apiKeyId: "",
        username,
        collectives,
        ...(scopes ? { scopes } : {}),
      };
    }

    try {
      const content = await Deno.readTextFile(this.getAuthPath());
      const parsed = JSON.parse(content) as AuthCredentials;
      // Domain migration: rewrite the legacy swamp.club URL to the new
      // domain in-place so subsequent loads see the new value. Scoped to
      // the exact legacy literal — custom servers and the new default
      // are left alone.
      if (parsed.serverUrl === LEGACY_SWAMP_CLUB_URL) {
        parsed.serverUrl = DEFAULT_SWAMP_CLUB_URL;
        await this.save(parsed);
      }
      return parsed;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
  }

  /** Write auth credentials to disk. Creates directory if needed. */
  async save(credentials: AuthCredentials): Promise<void> {
    await Deno.mkdir(this.getConfigDir(), { recursive: true });
    await atomicWriteTextFile(
      this.getAuthPath(),
      JSON.stringify(credentials, null, 2) + "\n",
      { mode: 0o600 },
    );
  }

  /**
   * Cache identity fields (username, collectives, fingerprint) without
   * overwriting an existing apiKey/apiKeyId from a login session.
   */
  async saveIdentityCache(
    serverUrl: string,
    username: string,
    collectives: string[],
    fingerprint: string,
    scopes?: string[],
  ): Promise<void> {
    let existing: AuthCredentials | undefined;
    try {
      const content = await Deno.readTextFile(this.getAuthPath());
      existing = JSON.parse(content) as AuthCredentials;
    } catch {
      // No existing file
    }

    const merged: AuthCredentials = {
      serverUrl,
      apiKey: existing?.apiKey ?? "",
      apiKeyId: existing?.apiKeyId ?? "",
      username,
      collectives,
      ...(scopes ? { scopes } : {}),
      apiKeyFingerprint: fingerprint,
    };
    await this.save(merged);
  }

  /** Delete stored auth credentials. */
  async delete(): Promise<void> {
    try {
      await Deno.remove(this.getAuthPath());
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }
}
