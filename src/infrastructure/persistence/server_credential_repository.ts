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
import { getSwampLogger } from "../logging/logger.ts";
import { getSwampConfigDir } from "./paths.ts";

const SERVERS_FILE = "servers.json";
const SERVERS_LOCK_FILE = "servers.json.lock";

/**
 * an unparseable value or unsupported scheme matches no server and warns
 * without echoing the value, which can carry a credential
 */
function normalizeEnvServerUrl(
  envUrl: string,
  warn = true,
): string | undefined {
  try {
    return normalizeServerUrl(envUrl);
  } catch {
    if (warn) {
      const logger = getSwampLogger(["auth", "credential"]);
      logger
        .warn`SWAMP_SERVER_TOKEN is set but SWAMP_SERVER_URL is not a valid http(s) or ws(s) URL — token not sent. Fix SWAMP_SERVER_URL or use --token instead.`;
    }
    return undefined;
  }
}

export interface FileServerCredentialRepositoryOptions {
  configDir?: string;
  getServerToken?: () => string | undefined;
  getServerUrl?: () => string | undefined;
  /** answer from servers.json alone, ignoring the SWAMP_SERVER_TOKEN pair */
  fileOnly?: boolean;
}

/** the SWAMP_SERVER_TOKEN env var takes precedence over servers.json */
export class FileServerCredentialRepository
  implements ServerCredentialRepository {
  private readonly getConfigDir: () => string;
  private readonly getServerToken: () => string | undefined;
  private readonly getServerUrl: () => string | undefined;

  constructor(options: FileServerCredentialRepositoryOptions = {}) {
    this.getConfigDir = options.configDir !== undefined
      ? () => options.configDir!
      : getSwampConfigDir;
    this.getServerToken = options.fileOnly
      ? () => undefined
      : options.getServerToken ?? (() => Deno.env.get("SWAMP_SERVER_TOKEN"));
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
      if (envUrl) {
        if (normalizeEnvServerUrl(envUrl) === key) {
          return {
            serverUrl: key,
            tokenName: "",
            token: envToken,
            principalId: "",
            obtainedAt: "",
          };
        }
      } else {
        const logger = getSwampLogger(["auth", "credential"]);
        logger
          .warn`SWAMP_SERVER_TOKEN is set but SWAMP_SERVER_URL is not — token not sent. Set SWAMP_SERVER_URL to the target server URL or use --token instead.`;
      }
    }

    const all = await this.loadAll();
    return all[key] ?? null;
  }

  /** whether get(serverUrl) answers with the SWAMP_SERVER_TOKEN pair; never warns */
  envPairNames(serverUrl: string): boolean {
    if (!this.getServerToken()) return false;
    const envUrl = this.getServerUrl();
    if (!envUrl) return false;
    return normalizeEnvServerUrl(envUrl, false) ===
      normalizeServerUrl(serverUrl);
  }

  async save(credential: ServerCredential): Promise<void> {
    const key = normalizeServerUrl(credential.serverUrl);
    await this.withWriteLock(async () => {
      const all = await this.loadAll();
      all[key] = { ...credential, serverUrl: key };
      await this.saveAll(all);
    });
  }

  async remove(serverUrl: string): Promise<void> {
    const key = normalizeServerUrl(serverUrl);
    await this.withWriteLock(async () => {
      const all = await this.loadAll();
      if (key in all) {
        delete all[key];
        await this.saveAll(all);
      }
    });
  }

  /**
   * readers need no lock: the atomic rename always shows them a whole file. The
   * sidecar is never removed, so every writer locks the same file, and the OS
   * drops the lock if its holder dies
   */
  private async withWriteLock(write: () => Promise<void>): Promise<void> {
    const dir = this.getConfigDir();
    await Deno.mkdir(dir, { recursive: true });
    const lock = await Deno.open(join(dir, SERVERS_LOCK_FILE), {
      read: true,
      write: true,
      create: true,
      mode: 0o600,
    });
    try {
      await lock.lock(true);
      await write();
    } finally {
      lock.close();
    }
  }

  async list(): Promise<ServerCredential[]> {
    const all = await this.loadAll();
    return Object.values(all);
  }
}
