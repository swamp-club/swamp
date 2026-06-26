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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { AuthNudgeRepository } from "./auth_nudge_repository.ts";

Deno.test("AuthNudgeRepository: read returns empty state when file does not exist", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const repo = new AuthNudgeRepository(
      join(tmpDir, "nonexistent", "auth_nudge.json"),
    );
    const state = await repo.read();
    assertEquals(state.lastShown, undefined);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("AuthNudgeRepository: markShown writes timestamp and read returns it", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const filePath = join(tmpDir, "auth_nudge.json");
    const repo = new AuthNudgeRepository(filePath);

    await repo.markShown();
    const state = await repo.read();

    assertEquals(typeof state.lastShown, "string");
    const parsed = new Date(state.lastShown!).getTime();
    const now = Date.now();
    assertEquals(now - parsed < 5000, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("AuthNudgeRepository: markShown overwrites previous state", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const filePath = join(tmpDir, "auth_nudge.json");
    const repo = new AuthNudgeRepository(filePath);

    await repo.markShown();
    const first = await repo.read();

    await repo.markShown();
    const second = await repo.read();

    assertEquals(typeof first.lastShown, "string");
    assertEquals(typeof second.lastShown, "string");
    assertEquals(
      new Date(second.lastShown!).getTime() >=
        new Date(first.lastShown!).getTime(),
      true,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});
