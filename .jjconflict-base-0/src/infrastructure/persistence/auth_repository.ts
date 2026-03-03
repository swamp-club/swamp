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

import { join } from "@std/path";
import { atomicWriteTextFile } from "./atomic_write.ts";
import { getSwampConfigDir } from "./paths.ts";
import type { AuthCredentials } from "../../domain/auth/auth_credentials.ts";

const AUTH_FILE = "auth.json";

/**
 * Repository for managing swamp-club authentication credentials.
 * Stores API key and server info at ~/.config/swamp/auth.json
 * (or $XDG_CONFIG_HOME/swamp/auth.json).
 */
export class AuthRepository {
  private getAuthPath(): string {
    return join(getSwampConfigDir(), AUTH_FILE);
  }

  /** Read stored auth credentials. Returns null if not found. */
  async load(): Promise<AuthCredentials | null> {
    try {
      const content = await Deno.readTextFile(this.getAuthPath());
      return JSON.parse(content) as AuthCredentials;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
  }

  /** Write auth credentials to disk. Creates directory if needed. */
  async save(credentials: AuthCredentials): Promise<void> {
    const configDir = getSwampConfigDir();
    await Deno.mkdir(configDir, { recursive: true });
    await atomicWriteTextFile(
      this.getAuthPath(),
      JSON.stringify(credentials, null, 2) + "\n",
      { mode: 0o600 },
    );
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
