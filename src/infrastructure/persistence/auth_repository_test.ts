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
import { join } from "@std/path";
import { AuthRepository } from "./auth_repository.ts";
import type { AuthCredentials } from "../../domain/auth/auth_credentials.ts";

const TEST_CREDENTIALS: AuthCredentials = {
  serverUrl: "https://swamp-club.com",
  apiKey: "swamp_testkey123",
  apiKeyId: "key-id-456",
  username: "testuser",
};

/** Save and restore env vars around a test to prevent pollution. */
function saveEnv(
  ...names: string[]
): { saved: Map<string, string | undefined>; restore: () => void } {
  const saved = new Map<string, string | undefined>();
  for (const name of names) {
    saved.set(name, Deno.env.get(name));
  }
  return {
    saved,
    restore: () => {
      for (const [name, value] of saved) {
        if (value !== undefined) Deno.env.set(name, value);
        else Deno.env.delete(name);
      }
    },
  };
}

Deno.test("AuthRepository - save and load round trip", async () => {
  const tmpDir = await Deno.makeTempDir();
  const env = saveEnv("XDG_CONFIG_HOME", "SWAMP_API_KEY");
  try {
    Deno.env.set("XDG_CONFIG_HOME", tmpDir);
    Deno.env.delete("SWAMP_API_KEY");
    const repo = new AuthRepository();

    await repo.save(TEST_CREDENTIALS);
    const loaded = await repo.load();

    assertExists(loaded);
    assertEquals(loaded.serverUrl, TEST_CREDENTIALS.serverUrl);
    assertEquals(loaded.apiKey, TEST_CREDENTIALS.apiKey);
    assertEquals(loaded.apiKeyId, TEST_CREDENTIALS.apiKeyId);
    assertEquals(loaded.username, TEST_CREDENTIALS.username);
  } finally {
    env.restore();
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AuthRepository - load returns null when no file exists", async () => {
  const tmpDir = await Deno.makeTempDir();
  const env = saveEnv("XDG_CONFIG_HOME", "SWAMP_API_KEY");
  try {
    Deno.env.set("XDG_CONFIG_HOME", tmpDir);
    Deno.env.delete("SWAMP_API_KEY");
    const repo = new AuthRepository();

    const loaded = await repo.load();
    assertEquals(loaded, null);
  } finally {
    env.restore();
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AuthRepository - delete removes credentials", async () => {
  const tmpDir = await Deno.makeTempDir();
  const env = saveEnv("XDG_CONFIG_HOME", "SWAMP_API_KEY");
  try {
    Deno.env.set("XDG_CONFIG_HOME", tmpDir);
    Deno.env.delete("SWAMP_API_KEY");
    const repo = new AuthRepository();

    await repo.save(TEST_CREDENTIALS);
    assertEquals((await repo.load()) !== null, true);

    await repo.delete();
    assertEquals(await repo.load(), null);
  } finally {
    env.restore();
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AuthRepository - delete is idempotent (no error when missing)", async () => {
  const tmpDir = await Deno.makeTempDir();
  const env = saveEnv("XDG_CONFIG_HOME");
  try {
    Deno.env.set("XDG_CONFIG_HOME", tmpDir);
    const repo = new AuthRepository();

    // Should not throw
    await repo.delete();
  } finally {
    env.restore();
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AuthRepository - save and load round trip with collectives", async () => {
  const tmpDir = await Deno.makeTempDir();
  const env = saveEnv("XDG_CONFIG_HOME", "SWAMP_API_KEY");
  try {
    Deno.env.set("XDG_CONFIG_HOME", tmpDir);
    Deno.env.delete("SWAMP_API_KEY");
    const repo = new AuthRepository();

    const credsWithCollectives: AuthCredentials = {
      ...TEST_CREDENTIALS,
      collectives: ["myorg", "swamp"],
    };
    await repo.save(credsWithCollectives);
    const loaded = await repo.load();

    assertExists(loaded);
    assertEquals(loaded.collectives, ["myorg", "swamp"]);
  } finally {
    env.restore();
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AuthRepository - load without collectives returns undefined for field", async () => {
  const tmpDir = await Deno.makeTempDir();
  const env = saveEnv("XDG_CONFIG_HOME", "SWAMP_API_KEY");
  try {
    Deno.env.set("XDG_CONFIG_HOME", tmpDir);
    Deno.env.delete("SWAMP_API_KEY");
    const repo = new AuthRepository();

    await repo.save(TEST_CREDENTIALS);
    const loaded = await repo.load();

    assertExists(loaded);
    assertEquals(loaded.collectives, undefined);
  } finally {
    env.restore();
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AuthRepository - save sets restrictive file permissions", async () => {
  if (Deno.build.os === "windows") return; // mode not enforced on Windows
  const tmpDir = await Deno.makeTempDir();
  const env = saveEnv("XDG_CONFIG_HOME");
  try {
    Deno.env.set("XDG_CONFIG_HOME", tmpDir);
    const repo = new AuthRepository();

    await repo.save(TEST_CREDENTIALS);

    const stat = await Deno.stat(`${tmpDir}/swamp/auth.json`);
    // mode 0o600 = owner read/write only
    assertEquals(stat.mode !== null && (stat.mode & 0o777) === 0o600, true);
  } finally {
    env.restore();
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ── SWAMP_API_KEY env var tests ──────────────────────────────────────

Deno.test("AuthRepository - load returns env var credentials when SWAMP_API_KEY is set", async () => {
  const env = saveEnv("SWAMP_API_KEY", "SWAMP_CLUB_URL");
  try {
    Deno.env.set("SWAMP_API_KEY", "swamp_env_key_123");
    Deno.env.delete("SWAMP_CLUB_URL");
    const repo = new AuthRepository();

    const loaded = await repo.load();

    assertExists(loaded);
    assertEquals(loaded.apiKey, "swamp_env_key_123");
    assertEquals(loaded.serverUrl, "https://swamp-club.com");
    assertEquals(loaded.apiKeyId, "");
    assertEquals(loaded.username, "");
  } finally {
    env.restore();
  }
});

Deno.test("AuthRepository - SWAMP_API_KEY takes precedence over auth.json file", async () => {
  const tmpDir = await Deno.makeTempDir();
  const env = saveEnv("XDG_CONFIG_HOME", "SWAMP_API_KEY", "SWAMP_CLUB_URL");
  try {
    Deno.env.set("XDG_CONFIG_HOME", tmpDir);
    Deno.env.delete("SWAMP_CLUB_URL");
    const repo = new AuthRepository();

    // Save file-based credentials first
    await repo.save(TEST_CREDENTIALS);

    // Set env var — should take precedence
    Deno.env.set("SWAMP_API_KEY", "swamp_env_override");
    const loaded = await repo.load();

    assertExists(loaded);
    assertEquals(loaded.apiKey, "swamp_env_override");
    assertEquals(loaded.username, "");
  } finally {
    env.restore();
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AuthRepository - SWAMP_API_KEY uses SWAMP_CLUB_URL for server", async () => {
  const env = saveEnv("SWAMP_API_KEY", "SWAMP_CLUB_URL");
  try {
    Deno.env.set("SWAMP_API_KEY", "swamp_env_key_456");
    Deno.env.set("SWAMP_CLUB_URL", "https://custom.server");
    const repo = new AuthRepository();

    const loaded = await repo.load();

    assertExists(loaded);
    assertEquals(loaded.serverUrl, "https://custom.server");
  } finally {
    env.restore();
  }
});

Deno.test("AuthRepository - empty SWAMP_API_KEY is treated as unset", async () => {
  const tmpDir = await Deno.makeTempDir();
  const env = saveEnv("XDG_CONFIG_HOME", "SWAMP_API_KEY");
  try {
    Deno.env.set("XDG_CONFIG_HOME", tmpDir);
    Deno.env.set("SWAMP_API_KEY", "");
    const repo = new AuthRepository();

    const loaded = await repo.load();
    assertEquals(loaded, null);
  } finally {
    env.restore();
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ── Domain migration: legacy swamp.club → swamp-club.com ─────────────

Deno.test("AuthRepository - load rewrites legacy https://swamp.club to new domain and persists", async () => {
  const tmpDir = await Deno.makeTempDir();
  const env = saveEnv("XDG_CONFIG_HOME", "SWAMP_API_KEY");
  try {
    Deno.env.set("XDG_CONFIG_HOME", tmpDir);
    Deno.env.delete("SWAMP_API_KEY");
    const repo = new AuthRepository();

    // Seed an auth.json carrying the legacy domain.
    await repo.save({
      ...TEST_CREDENTIALS,
      serverUrl: "https://swamp.club",
    });

    const loaded = await repo.load();
    assertExists(loaded);
    assertEquals(loaded.serverUrl, "https://swamp-club.com");

    // Migration must persist so subsequent loads see the new value
    // without re-running the rewrite.
    const raw = await Deno.readTextFile(join(tmpDir, "swamp", "auth.json"));
    const onDisk = JSON.parse(raw) as AuthCredentials;
    assertEquals(onDisk.serverUrl, "https://swamp-club.com");
  } finally {
    env.restore();
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AuthRepository - load leaves custom server URLs untouched", async () => {
  const tmpDir = await Deno.makeTempDir();
  const env = saveEnv("XDG_CONFIG_HOME", "SWAMP_API_KEY");
  try {
    Deno.env.set("XDG_CONFIG_HOME", tmpDir);
    Deno.env.delete("SWAMP_API_KEY");
    const repo = new AuthRepository();

    await repo.save({
      ...TEST_CREDENTIALS,
      serverUrl: "https://staging.swamp.club",
    });

    const loaded = await repo.load();
    assertExists(loaded);
    assertEquals(loaded.serverUrl, "https://staging.swamp.club");
  } finally {
    env.restore();
    await Deno.remove(tmpDir, { recursive: true });
  }
});
