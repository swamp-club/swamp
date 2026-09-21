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

import { assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import { UserIdentityRepository } from "./user_identity_repository.ts";
import type { UserIdentityData } from "../../domain/identity/user_identity.ts";

// The config directory is injected rather than steered through HOME /
// XDG_CONFIG_HOME: `deno test --parallel` shares one process and one
// `Deno.env` across test files, so repointing them here would send other
// files' writes into a temp directory this file is about to delete. How
// those variables resolve to a config dir is covered by paths_test.ts.

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_identity_test_" });
  try {
    await fn(tmpDir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native handles yet.
      // Temp dir is ephemeral, OS reclaims.
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
}

Deno.test("UserIdentityRepository.getUserId creates identity file when missing", async () => {
  await withTempDir(async (tmpDir) => {
    const repo = new UserIdentityRepository(tmpDir);
    const userId = await repo.getUserId();

    assertEquals(typeof userId, "string");
    assertEquals(userId !== null, true);

    const content = await Deno.readTextFile(join(tmpDir, "identity.json"));
    const data: UserIdentityData = JSON.parse(content);
    assertEquals(data.userId, userId);
    assertEquals(typeof data.createdAt, "string");
  });
});

Deno.test("UserIdentityRepository.getUserId returns same userId on subsequent calls", async () => {
  await withTempDir(async (tmpDir) => {
    const repo = new UserIdentityRepository(tmpDir);

    const userId1 = await repo.getUserId();
    const userId2 = await repo.getUserId();

    assertEquals(userId1, userId2);
  });
});

Deno.test("UserIdentityRepository.getUserId reads existing identity file", async () => {
  await withTempDir(async (tmpDir) => {
    const existingData: UserIdentityData = {
      userId: "existing-uuid-1234",
      createdAt: "2024-01-01T00:00:00.000Z",
    };
    await Deno.writeTextFile(
      join(tmpDir, "identity.json"),
      JSON.stringify(existingData),
    );

    const repo = new UserIdentityRepository(tmpDir);

    assertEquals(await repo.getUserId(), "existing-uuid-1234");
  });
});

Deno.test("UserIdentityRepository.getUserId creates the config directory when missing", async () => {
  await withTempDir(async (tmpDir) => {
    const configDir = join(tmpDir, "nested", "swamp");
    const repo = new UserIdentityRepository(configDir);

    const userId = await repo.getUserId();

    const content = await Deno.readTextFile(join(configDir, "identity.json"));
    const data: UserIdentityData = JSON.parse(content);
    assertEquals(data.userId, userId);
  });
});

Deno.test("UserIdentityRepository.getUserId returns different ids for different directories", async () => {
  await withTempDir(async (tmpDir) => {
    const dir1 = join(tmpDir, "one");
    const dir2 = join(tmpDir, "two");

    const userId1 = await new UserIdentityRepository(dir1).getUserId();
    const userId2 = await new UserIdentityRepository(dir2).getUserId();

    assertNotEquals(userId1, userId2);
  });
});
