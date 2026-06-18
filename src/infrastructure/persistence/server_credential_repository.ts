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
import type {
  ServerCredential,
  ServerCredentialRepository,
} from "../../domain/auth/server_credential.ts";
import { normalizeServerUrl } from "../../domain/auth/server_url.ts";
import { atomicWriteTextFile } from "./atomic_write.ts";
import { getSwampConfigDir } from "./paths.ts";

const SERVERS_FILE = "servers.json";

/**
 * Optional overrides for `FileServerCredentialRepository`. Used by tests to
 * bypass the shared `Deno.env` global, which races across files when
 * `deno test --parallel` runs multiple test files concurrently.
 */
export interface FileServerCredentialRepositoryOptions {
  /** Override the config dir; default is `getSwampConfigDir()`. */
  configDir?: string;
  /**
   * Override the SWAMP_SERVER_TOKEN lookup; default reads
   * `Deno.env.get("SWAMP_SERVER_TOKEN")` lazily at call time.
   */
  getServerToken?: () => string | undefined;
  /**
   * Override the SWAMP_SERVER_URL lookup used with the token env var;
   * default reads `Deno.env.get("SWAMP_SERVER_URL")` lazily at call time.
   */
  getServerUrl?: () => string | undefined;
}

/**
 * File-based implementation of ServerCredentialRepository.
 * Stores credentials at ~/.config/swamp/servers.json
 * (or $XDG_CONFIG_HOME/swamp/servers.json) as a JSON object
 * keyed by normalized server URL.
 *
 * Precedence: SWAMP_SERVER_TOKEN env var > servers.json file.
 */
export class FileServerCredentialRepository
  implements ServerCredentialRepository {
  private readonly getConfigDir: () => string;
  private readonly getServerToken: () => string | undefined;
  private readonly getServerUrl: () => string | undefined;

  constructor(options: FileServerCredentialRepositoryOptions = {}) {
    this.getConfigDir = options.configDir !== undefined
      ? () => options.configDir!
      : getSwampConfigDir;
    this.getServerToken = options.getServerToken ??
      (() => Deno.env.get("SWAMP_SERVER_TOKEN"));
    this.getServerUrl = options.getServerUrl ??
      (() => Deno.env.get("SWAMP_SERVER_URL"));
  }

  private getServersPath(): string {
    return join(this.getConfigDir(), SERVERS_FILE);
  }

  private async loadAll(): Promise<Record<string, ServerCredential>> {
    try {
      const content = await Deno.readTextFile(this.getServersPath());
      return JSON.parse(content) as Record<string, ServerCredential>;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return {};
      }
      throw error;
    }
  }

  private async saveAll(
    credentials: Record<string, ServerCredential>,
  ): Promise<void> {
    await Deno.mkdir(this.getConfigDir(), { recursive: true });
    await atomicWriteTextFile(
      this.getServersPath(),
      JSON.stringify(credentials, null, 2) + "\n",
      { mode: 0o600 },
    );
  }

  async get(serverUrl: string): Promise<ServerCredential | null> {
    const key = normalizeServerUrl(serverUrl);

    const envToken = this.getServerToken();
    if (envToken) {
      const envUrl = this.getServerUrl();
      if (envUrl && normalizeServerUrl(envUrl) === key) {
        return {
          serverUrl: key,
          tokenName: "",
          token: envToken,
          principalId: "",
          obtainedAt: "",
        };
      }
    }

    const all = await this.loadAll();
    return all[key] ?? null;
  }

  async save(credential: ServerCredential): Promise<void> {
    const key = normalizeServerUrl(credential.serverUrl);
    const all = await this.loadAll();
    all[key] = { ...credential, serverUrl: key };
    await this.saveAll(all);
  }

  async remove(serverUrl: string): Promise<void> {
    const key = normalizeServerUrl(serverUrl);
    const all = await this.loadAll();
    if (key in all) {
      delete all[key];
      await this.saveAll(all);
    }
  }

  async list(): Promise<ServerCredential[]> {
    const all = await this.loadAll();
    return Object.values(all);
  }
}
