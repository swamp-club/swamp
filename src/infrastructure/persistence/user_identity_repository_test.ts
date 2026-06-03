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

Deno.test("UserIdentityRepository.getUserId creates identity file when missing", async () => {
  const tmpDir = await Deno.makeTempDir();
  const originalHome = Deno.env.get("HOME");
  const originalXdg = Deno.env.get("XDG_CONFIG_HOME");
  try {
    Deno.env.set("XDG_CONFIG_HOME", tmpDir);
    Deno.env.delete("HOME"); // Ensure XDG takes priority

    const repo = new UserIdentityRepository();
    const userId = await repo.getUserId();

    assertEquals(typeof userId, "string");
    assertEquals(userId !== null, true);

    // Verify file was created
    const content = await Deno.readTextFile(
      join(tmpDir, "swamp", "identity.json"),
    );
    const data: UserIdentityData = JSON.parse(content);
    assertEquals(data.userId, userId);
    assertEquals(typeof data.createdAt, "string");
  } finally {
    if (originalHome) Deno.env.set("HOME", originalHome);
    else Deno.env.delete("HOME");
    if (originalXdg) Deno.env.set("XDG_CONFIG_HOME", originalXdg);
    else Deno.env.delete("XDG_CONFIG_HOME");
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("UserIdentityRepository.getUserId returns same userId on subsequent calls", async () => {
  const tmpDir = await Deno.makeTempDir();
  const originalXdg = Deno.env.get("XDG_CONFIG_HOME");
  try {
    Deno.env.set("XDG_CONFIG_HOME", tmpDir);

    const repo = new UserIdentityRepository();
    const userId1 = await repo.getUserId();
    const userId2 = await repo.getUserId();

    assertEquals(userId1, userId2);
  } finally {
    if (originalXdg) Deno.env.set("XDG_CONFIG_HOME", originalXdg);
    else Deno.env.delete("XDG_CONFIG_HOME");
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("UserIdentityRepository.getUserId reads existing identity file", async () => {
  const tmpDir = await Deno.makeTempDir();
  const originalXdg = Deno.env.get("XDG_CONFIG_HOME");
  try {
    Deno.env.set("XDG_CONFIG_HOME", tmpDir);

    // Pre-create identity file
    const swampDir = join(tmpDir, "swamp");
    await Deno.mkdir(swampDir, { recursive: true });
    const existingData: UserIdentityData = {
      userId: "existing-uuid-1234",
      createdAt: "2024-01-01T00:00:00.000Z",
    };
    await Deno.writeTextFile(
      join(swampDir, "identity.json"),
      JSON.stringify(existingData),
    );

    const repo = new UserIdentityRepository();
    const userId = await repo.getUserId();

    assertEquals(userId, "existing-uuid-1234");
  } finally {
    if (originalXdg) Deno.env.set("XDG_CONFIG_HOME", originalXdg);
    else Deno.env.delete("XDG_CONFIG_HOME");
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("UserIdentityRepository.getUserId uses HOME fallback when XDG_CONFIG_HOME is not set", async () => {
  const tmpDir = await Deno.makeTempDir();
  const originalHome = Deno.env.get("HOME");
  const originalXdg = Deno.env.get("XDG_CONFIG_HOME");
  try {
    Deno.env.delete("XDG_CONFIG_HOME");
    Deno.env.set("HOME", tmpDir);

    const repo = new UserIdentityRepository();
    const userId = await repo.getUserId();

    assertEquals(typeof userId, "string");
    assertEquals(userId !== null, true);

    // Verify file was created at ~/.config/swamp/identity.json
    const content = await Deno.readTextFile(
      join(tmpDir, ".config", "swamp", "identity.json"),
    );
    const data: UserIdentityData = JSON.parse(content);
    assertEquals(data.userId, userId);
  } finally {
    if (originalHome) Deno.env.set("HOME", originalHome);
    else Deno.env.delete("HOME");
    if (originalXdg) Deno.env.set("XDG_CONFIG_HOME", originalXdg);
    else Deno.env.delete("XDG_CONFIG_HOME");
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("UserIdentityRepository.getUserId returns different ids for different directories", async () => {
  const tmpDir1 = await Deno.makeTempDir();
  const tmpDir2 = await Deno.makeTempDir();
  const originalXdg = Deno.env.get("XDG_CONFIG_HOME");
  try {
    Deno.env.set("XDG_CONFIG_HOME", tmpDir1);
    const repo1 = new UserIdentityRepository();
    const userId1 = await repo1.getUserId();

    Deno.env.set("XDG_CONFIG_HOME", tmpDir2);
    const repo2 = new UserIdentityRepository();
    const userId2 = await repo2.getUserId();

    assertNotEquals(userId1, userId2);
  } finally {
    if (originalXdg) Deno.env.set("XDG_CONFIG_HOME", originalXdg);
    else Deno.env.delete("XDG_CONFIG_HOME");
    await Deno.remove(tmpDir1, { recursive: true });
    await Deno.remove(tmpDir2, { recursive: true });
  }
});
