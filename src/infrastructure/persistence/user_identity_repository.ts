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
import {
  createUserIdentity,
  type UserIdentityData,
} from "../../domain/identity/user_identity.ts";
import { getSwampConfigDir } from "./paths.ts";
import { ownsDirectory } from "./config_dir_ownership.ts";

const IDENTITY_FILE = "identity.json";

/**
 * Repository for managing user-level identity.
 * Stores a persistent UUID at ~/.config/swamp/identity.json.
 * Lazy-creates the file and directory on first access.
 */
export class UserIdentityRepository {
  readonly #configDir: string | undefined;
  readonly #ownsDir: (dir: string) => boolean;

  /**
   * @param configDir Directory holding `identity.json`. Defaults to the
   * environment-resolved swamp config dir; callers that own a directory
   * (tests above all) pass it explicitly rather than repointing `HOME` or
   * `XDG_CONFIG_HOME`, which are process-global and shared across the suite.
   * @param options.ownsDir Whether this process owns a dir. Defaults to a
   * uid check; tests inject it.
   */
  constructor(
    configDir?: string,
    options: { ownsDir?: (dir: string) => boolean } = {},
  ) {
    this.#configDir = configDir;
    this.#ownsDir = options.ownsDir ?? ((dir) => ownsDirectory(dir));
  }

  /**
   * Returns the user's persistent userId.
   * Lazy-creates the identity file if it doesn't exist, unless the config dir
   * belongs to another user (a system daemon running as root against the
   * enabling user's dir), which would leave a root-owned file there.
   * Returns null on any error (permissions, missing HOME, etc.).
   */
  async getUserId(): Promise<string | null> {
    try {
      const configDir = this.#configDir ?? getSwampConfigDir();
      const identityPath = join(configDir, IDENTITY_FILE);

      // Try to read existing identity
      try {
        const content = await Deno.readTextFile(identityPath);
        const data: UserIdentityData = JSON.parse(content);
        if (data.userId) {
          return data.userId;
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          return null;
        }
      }

      // Create new identity
      if (!this.#ownsDir(configDir)) return null;
      const identity = createUserIdentity();
      await Deno.mkdir(configDir, { recursive: true });
      await atomicWriteTextFile(
        identityPath,
        JSON.stringify(identity, null, 2) + "\n",
      );
      return identity.userId;
    } catch {
      return null;
    }
  }
}
