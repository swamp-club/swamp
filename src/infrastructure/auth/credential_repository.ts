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
import type { CredentialStore } from "../../domain/auth/auth_service.ts";
import type { CredentialData } from "../../domain/auth/credentials.ts";
import { atomicWriteTextFile } from "../persistence/atomic_write.ts";
import { getSwampConfigDir } from "../persistence/paths.ts";

const CREDENTIALS_FILE = "credentials.json";

/**
 * File-based credential storage at ~/.config/swamp/credentials.json.
 */
export class CredentialRepository implements CredentialStore {
  async load(): Promise<CredentialData | null> {
    try {
      const path = join(getSwampConfigDir(), CREDENTIALS_FILE);
      const content = await Deno.readTextFile(path);
      const data: CredentialData = JSON.parse(content);
      if (data.sessionToken && data.email) {
        return data;
      }
      return null;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      return null;
    }
  }

  async save(data: CredentialData): Promise<void> {
    const configDir = getSwampConfigDir();
    await Deno.mkdir(configDir, { recursive: true });
    const path = join(configDir, CREDENTIALS_FILE);
    await atomicWriteTextFile(
      path,
      JSON.stringify(data, null, 2) + "\n",
      { mode: 0o600 },
    );
  }

  async remove(): Promise<void> {
    try {
      const path = join(getSwampConfigDir(), CREDENTIALS_FILE);
      await Deno.remove(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }
}
