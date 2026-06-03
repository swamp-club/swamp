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

const IDENTITY_FILE = "identity.json";

/**
 * Repository for managing user-level identity.
 * Stores a persistent UUID at ~/.config/swamp/identity.json.
 * Lazy-creates the file and directory on first access.
 */
export class UserIdentityRepository {
  /**
   * Returns the user's persistent userId.
   * Lazy-creates the identity file if it doesn't exist.
   * Returns null on any error (permissions, missing HOME, etc.).
   */
  async getUserId(): Promise<string | null> {
    try {
      const configDir = getSwampConfigDir();
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
