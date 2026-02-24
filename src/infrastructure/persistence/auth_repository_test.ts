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

import { assertEquals, assertExists } from "@std/assert";
import { AuthRepository } from "./auth_repository.ts";
import type { AuthCredentials } from "../../domain/auth/auth_credentials.ts";

const TEST_CREDENTIALS: AuthCredentials = {
  serverUrl: "https://swamp.club",
  apiKey: "swamp_testkey123",
  apiKeyId: "key-id-456",
  username: "testuser",
};

Deno.test("AuthRepository - save and load round trip", async () => {
  const tmpDir = await Deno.makeTempDir();
  const originalHome = Deno.env.get("HOME");
  try {
    Deno.env.set("HOME", tmpDir);
    const repo = new AuthRepository();

    await repo.save(TEST_CREDENTIALS);
    const loaded = await repo.load();

    assertExists(loaded);
    assertEquals(loaded.serverUrl, TEST_CREDENTIALS.serverUrl);
    assertEquals(loaded.apiKey, TEST_CREDENTIALS.apiKey);
    assertEquals(loaded.apiKeyId, TEST_CREDENTIALS.apiKeyId);
    assertEquals(loaded.username, TEST_CREDENTIALS.username);
  } finally {
    if (originalHome) Deno.env.set("HOME", originalHome);
    else Deno.env.delete("HOME");
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AuthRepository - load returns null when no file exists", async () => {
  const tmpDir = await Deno.makeTempDir();
  const originalHome = Deno.env.get("HOME");
  try {
    Deno.env.set("HOME", tmpDir);
    const repo = new AuthRepository();

    const loaded = await repo.load();
    assertEquals(loaded, null);
  } finally {
    if (originalHome) Deno.env.set("HOME", originalHome);
    else Deno.env.delete("HOME");
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AuthRepository - delete removes credentials", async () => {
  const tmpDir = await Deno.makeTempDir();
  const originalHome = Deno.env.get("HOME");
  try {
    Deno.env.set("HOME", tmpDir);
    const repo = new AuthRepository();

    await repo.save(TEST_CREDENTIALS);
    assertEquals((await repo.load()) !== null, true);

    await repo.delete();
    assertEquals(await repo.load(), null);
  } finally {
    if (originalHome) Deno.env.set("HOME", originalHome);
    else Deno.env.delete("HOME");
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AuthRepository - delete is idempotent (no error when missing)", async () => {
  const tmpDir = await Deno.makeTempDir();
  const originalHome = Deno.env.get("HOME");
  try {
    Deno.env.set("HOME", tmpDir);
    const repo = new AuthRepository();

    // Should not throw
    await repo.delete();
  } finally {
    if (originalHome) Deno.env.set("HOME", originalHome);
    else Deno.env.delete("HOME");
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AuthRepository - save sets restrictive file permissions", async () => {
  if (Deno.build.os === "windows") return; // mode not enforced on Windows
  const tmpDir = await Deno.makeTempDir();
  const originalHome = Deno.env.get("HOME");
  try {
    Deno.env.set("HOME", tmpDir);
    const repo = new AuthRepository();

    await repo.save(TEST_CREDENTIALS);

    const stat = await Deno.stat(`${tmpDir}/.swamp/auth.json`);
    // mode 0o600 = owner read/write only
    assertEquals(stat.mode !== null && (stat.mode & 0o777) === 0o600, true);
  } finally {
    if (originalHome) Deno.env.set("HOME", originalHome);
    else Deno.env.delete("HOME");
    await Deno.remove(tmpDir, { recursive: true });
  }
});
