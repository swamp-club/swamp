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
import { resolveApiKey } from "./api_key_source.ts";
import {
  type AuthCredentials,
  DEFAULT_SWAMP_CLUB_URL,
  keyFingerprint,
  LEGACY_SWAMP_CLUB_URL,
} from "../../domain/auth/auth_credentials.ts";

const AUTH_FILE = "auth.json";

function canonicalServerUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  return trimmed === LEGACY_SWAMP_CLUB_URL ? DEFAULT_SWAMP_CLUB_URL : trimmed;
}

/**
 * tests bypass the shared Deno.env global, which races across files under
 * parallel tests; production passes nothing
 */
export interface AuthRepositoryOptions {
  configDir?: string;
  getApiKey?: () => string | undefined;
  getServerUrl?: () => string | undefined;
}

/**
 * a collective API key takes precedence over auth.json; auth.json holds only
 * the login credential, and API key identity is cached in
 * env_identity_cache.json so a keyed run never touches a login record
 */
export class AuthRepository {
  private readonly getConfigDir: () => string;
  private readonly getApiKey: () => string | undefined;
  private readonly getServerUrl: () => string | undefined;

  constructor(options: AuthRepositoryOptions = {}) {
    this.getConfigDir = options.configDir !== undefined
      ? () => options.configDir!
      : getSwampConfigDir;
    this.getApiKey = options.getApiKey ?? resolveApiKey;
    this.getServerUrl = options.getServerUrl ??
      (() => Deno.env.get("SWAMP_CLUB_URL"));
  }

  getAuthPath(): string {
    return join(this.getConfigDir(), AUTH_FILE);
  }

  /**
   * with an API key set, cached identity merges in if server URL and key
   * fingerprint match; identity is never read from auth.json, which older
   * versions could leave holding another key's identity
   */
  async load(): Promise<AuthCredentials | null> {
    const envApiKey = this.getApiKey();
    if (envApiKey) {
      const serverUrl = this.getServerUrl() ?? DEFAULT_SWAMP_CLUB_URL;
      const fingerprint = await keyFingerprint(envApiKey);
      // Absent until the first whoami for this key caches it.
      const cached = await this.loadEnvIdentityCache(serverUrl, fingerprint);

      return {
        serverUrl,
        apiKey: envApiKey,
        apiKeyId: "",
        username: cached?.username ?? "",
        collectives: cached?.collectives,
        ...(cached?.scopes ? { scopes: cached.scopes } : {}),
      };
    }

    try {
      const content = await Deno.readTextFile(this.getAuthPath());
      const parsed = JSON.parse(content) as AuthCredentials;
      // domain migration: rewrite the exact legacy URL in place so later loads
      // see the new one; custom servers and the new default are left alone
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

  async save(credentials: AuthCredentials): Promise<void> {
    await Deno.mkdir(this.getConfigDir(), { recursive: true });
    await atomicWriteTextFile(
      this.getAuthPath(),
      JSON.stringify(credentials, null, 2) + "\n",
      { mode: 0o600 },
    );
  }

  /**
   * auth.json is never touched: writing there created a login record with an
   * empty key, and over a login replaced its username and collectives with the
   * API key's
   */
  async saveIdentityCache(
    serverUrl: string,
    username: string,
    collectives: string[],
    fingerprint: string,
    scopes?: string[],
  ): Promise<void> {
    const identity = {
      serverUrl,
      username,
      collectives,
      ...(scopes ? { scopes } : {}),
      apiKeyFingerprint: fingerprint,
    };
    await Deno.mkdir(this.getConfigDir(), { recursive: true });
    await atomicWriteTextFile(
      this.getEnvIdentityCachePath(),
      JSON.stringify(identity, null, 2) + "\n",
      { mode: 0o600 },
    );
  }

  private getEnvIdentityCachePath(): string {
    return join(this.getConfigDir(), "env_identity_cache.json");
  }

  private async loadEnvIdentityCache(
    serverUrl: string,
    fingerprint: string,
  ): Promise<AuthCredentials | undefined> {
    try {
      const content = await Deno.readTextFile(this.getEnvIdentityCachePath());
      const cached = JSON.parse(content) as AuthCredentials;
      if (
        cached.apiKeyFingerprint === fingerprint && cached.serverUrl &&
        canonicalServerUrl(cached.serverUrl) === canonicalServerUrl(serverUrl)
      ) {
        return cached;
      }
    } catch {
      // No cache file
    }
    return undefined;
  }

  private getScopeCachePath(): string {
    return join(this.getConfigDir(), "scope_cache.json");
  }

  static readonly SCOPE_CACHE_TTL_MS = 3_600_000;

  async saveScopeCache(
    fingerprint: string,
    scopes: string[],
  ): Promise<void> {
    await Deno.mkdir(this.getConfigDir(), { recursive: true });
    await atomicWriteTextFile(
      this.getScopeCachePath(),
      JSON.stringify({ fingerprint, scopes, cachedAt: Date.now() }, null, 2) +
        "\n",
      { mode: 0o600 },
    );
  }

  async loadScopeCache(
    fingerprint: string,
  ): Promise<string[] | undefined> {
    try {
      const content = await Deno.readTextFile(this.getScopeCachePath());
      const cached = JSON.parse(content) as {
        fingerprint?: string;
        scopes?: string[];
        cachedAt?: number;
      };
      if (cached.fingerprint !== fingerprint) return undefined;
      if (
        cached.cachedAt !== undefined &&
        Date.now() - cached.cachedAt > AuthRepository.SCOPE_CACHE_TTL_MS
      ) {
        return undefined;
      }
      return cached.scopes;
    } catch {
      // No cache file
    }
    return undefined;
  }

  async delete(): Promise<void> {
    await this.removeIfPresent([
      this.getAuthPath(),
      this.getScopeCachePath(),
      this.getEnvIdentityCachePath(),
    ]);
  }

  /**
   * Delete the scope and identity caches but never auth.json, so it cannot
   * remove a login another process writes meanwhile.
   */
  async deleteCaches(): Promise<void> {
    await this.removeIfPresent([
      this.getScopeCachePath(),
      this.getEnvIdentityCachePath(),
    ]);
  }

  private async removeIfPresent(paths: string[]): Promise<void> {
    for (const path of paths) {
      try {
        await Deno.remove(path);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
    }
  }
}
