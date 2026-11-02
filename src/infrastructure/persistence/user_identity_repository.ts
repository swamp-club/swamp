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

export class UserIdentityRepository {
  readonly #configDir: string | undefined;
  readonly #ownsDir: (dir: string) => boolean;

  /**
   * callers that own a directory pass it explicitly rather than repointing HOME
   * or XDG_CONFIG_HOME, which are process-global and shared across the suite
   */
  constructor(
    configDir?: string,
    options: { ownsDir?: (dir: string) => boolean } = {},
  ) {
    this.#configDir = configDir;
    this.#ownsDir = options.ownsDir ?? ((dir) => ownsDirectory(dir));
  }

  /**
   * does not create the file when the config dir belongs to another user (a
   * root daemon against the enabling user's dir), which would leave a
   * root-owned file there
   */
  async getUserId(): Promise<string | null> {
    try {
      const configDir = this.#configDir ?? getSwampConfigDir();
      const identityPath = join(configDir, IDENTITY_FILE);

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
