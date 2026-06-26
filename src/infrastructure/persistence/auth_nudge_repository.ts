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
import type { AuthNudgeState } from "../../domain/auth/auth_nudge.ts";
import { atomicWriteTextFile } from "./atomic_write.ts";
import { getSwampConfigDir } from "./paths.ts";

const NUDGE_FILE = "auth_nudge.json";

export class AuthNudgeRepository {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? join(getSwampConfigDir(), NUDGE_FILE);
  }

  async read(): Promise<AuthNudgeState> {
    try {
      const content = await Deno.readTextFile(this.filePath);
      return JSON.parse(content) as AuthNudgeState;
    } catch {
      return {};
    }
  }

  async markShown(): Promise<void> {
    const state: AuthNudgeState = { lastShown: new Date().toISOString() };
    try {
      await Deno.mkdir(getSwampConfigDir(), { recursive: true });
      await atomicWriteTextFile(
        this.filePath,
        JSON.stringify(state, null, 2) + "\n",
      );
    } catch {
      // Best effort — don't break the CLI for nudge state
    }
  }
}
