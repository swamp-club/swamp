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

// All tests inject `configDir`, `getApiKey`, and `getServerUrl` directly
// into the AuthRepository constructor instead of mutating Deno.env. The
// previous `Deno.env.set/delete` pattern raced across files when
// `deno test --parallel` ran auth-touching files concurrently — see PR #1266.

Deno.test("AuthRepository - save and load round trip", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const repo = new AuthRepository({
      configDir: join(tmpDir, "swamp"),
      getApiKey: () => undefined,
    });

    await repo.save(TEST_CREDENTIALS);
    const loaded = await repo.load();

    assertExists(loaded);
    assertEquals(loaded.serverUrl, TEST_CREDENTIALS.serverUrl);
    assertEquals(loaded.apiKey, TEST_CREDENTIALS.apiKey);
    assertEquals(loaded.apiKeyId, TEST_CREDENTIALS.apiKeyId);
    assertEquals(loaded.username, TEST_CREDENTIALS.username);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AuthRepository - load returns null when no file exists", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const repo = new AuthRepository({
      configDir: join(tmpDir, "swamp"),
      getApiKey: () => undefined,
    });

    const loaded = await repo.load();
    assertEquals(loaded, null);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AuthRepository - delete removes credentials", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const repo = new AuthRepository({
      configDir: join(tmpDir, "swamp"),
      getApiKey: () => undefined,
    });

    await repo.save(TEST_CREDENTIALS);
    assertEquals((await repo.load()) !== null, true);

    await repo.delete();
    assertEquals(await repo.load(), null);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AuthRepository - delete is idempotent (no error when missing)", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const repo = new AuthRepository({
      configDir: join(tmpDir, "swamp"),
    });

    // Should not throw
    await repo.delete();
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AuthRepository - save and load round trip with collectives", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const repo = new AuthRepository({
      configDir: join(tmpDir, "swamp"),
      getApiKey: () => undefined,
    });

    const credsWithCollectives: AuthCredentials = {
      ...TEST_CREDENTIALS,
      collectives: ["myorg", "swamp"],
    };
    await repo.save(credsWithCollectives);
    const loaded = await repo.load();

    assertExists(loaded);
    assertEquals(loaded.collectives, ["myorg", "swamp"]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AuthRepository - load without collectives returns undefined for field", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const repo = new AuthRepository({
      configDir: join(tmpDir, "swamp"),
      getApiKey: () => undefined,
    });

    await repo.save(TEST_CREDENTIALS);
    const loaded = await repo.load();

    assertExists(loaded);
    assertEquals(loaded.collectives, undefined);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AuthRepository - save sets restrictive file permissions", async () => {
  if (Deno.build.os === "windows") return; // mode not enforced on Windows
  const tmpDir = await Deno.makeTempDir();
  try {
    const repo = new AuthRepository({
      configDir: join(tmpDir, "swamp"),
    });

    await repo.save(TEST_CREDENTIALS);

    const stat = await Deno.stat(join(tmpDir, "swamp", "auth.json"));
    // mode 0o600 = owner read/write only
    assertEquals(stat.mode !== null && (stat.mode & 0o777) === 0o600, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ── SWAMP_API_KEY override tests ─────────────────────────────────────

Deno.test("AuthRepository - load returns env var credentials when SWAMP_API_KEY is set", async () => {
  const repo = new AuthRepository({
    getApiKey: () => "swamp_env_key_123",
    getServerUrl: () => undefined,
  });

  const loaded = await repo.load();

  assertExists(loaded);
  assertEquals(loaded.apiKey, "swamp_env_key_123");
  assertEquals(loaded.serverUrl, "https://swamp-club.com");
  assertEquals(loaded.apiKeyId, "");
  assertEquals(loaded.username, "");
});

Deno.test("AuthRepository - SWAMP_API_KEY takes precedence over auth.json file", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    // First seed file-based credentials with API key off.
    const fileRepo = new AuthRepository({
      configDir: join(tmpDir, "swamp"),
      getApiKey: () => undefined,
      getServerUrl: () => undefined,
    });
    await fileRepo.save(TEST_CREDENTIALS);

    // Now load with API key set — should take precedence.
    const envRepo = new AuthRepository({
      configDir: join(tmpDir, "swamp"),
      getApiKey: () => "swamp_env_override",
      getServerUrl: () => undefined,
    });
    const loaded = await envRepo.load();

    assertExists(loaded);
    assertEquals(loaded.apiKey, "swamp_env_override");
    assertEquals(loaded.username, "");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AuthRepository - SWAMP_API_KEY uses SWAMP_CLUB_URL for server", async () => {
  const repo = new AuthRepository({
    getApiKey: () => "swamp_env_key_456",
    getServerUrl: () => "https://custom.server",
  });

  const loaded = await repo.load();

  assertExists(loaded);
  assertEquals(loaded.serverUrl, "https://custom.server");
});

Deno.test("AuthRepository - empty SWAMP_API_KEY is treated as unset", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const repo = new AuthRepository({
      configDir: join(tmpDir, "swamp"),
      getApiKey: () => "",
    });

    const loaded = await repo.load();
    assertEquals(loaded, null);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ── SWAMP_API_KEY identity cache merging ────────────────────────────────

Deno.test("AuthRepository - load merges cached identity when fingerprint matches", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const configDir = join(tmpDir, "swamp");
    const fileRepo = new AuthRepository({
      configDir,
      getApiKey: () => undefined,
    });
    await fileRepo.save({
      ...TEST_CREDENTIALS,
      apiKeyFingerprint: "swamp_env_ke",
      collectives: ["myorg"],
    });

    const envRepo = new AuthRepository({
      configDir,
      getApiKey: () => "swamp_env_key_123",
      getServerUrl: () => undefined,
    });
    const loaded = await envRepo.load();

    assertExists(loaded);
    assertEquals(loaded.apiKey, "swamp_env_key_123");
    assertEquals(loaded.username, "testuser");
    assertEquals(loaded.collectives, ["myorg"]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AuthRepository - load does not merge when fingerprint mismatches (key rotation)", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const configDir = join(tmpDir, "swamp");
    const fileRepo = new AuthRepository({
      configDir,
      getApiKey: () => undefined,
    });
    await fileRepo.save({
      ...TEST_CREDENTIALS,
      apiKeyFingerprint: "swamp_old_ke",
      collectives: ["stale-org"],
    });

    const envRepo = new AuthRepository({
      configDir,
      getApiKey: () => "swamp_new_key_456",
      getServerUrl: () => undefined,
    });
    const loaded = await envRepo.load();

    assertExists(loaded);
    assertEquals(loaded.apiKey, "swamp_new_key_456");
    assertEquals(loaded.username, "");
    assertEquals(loaded.collectives, undefined);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AuthRepository - load does not merge when no fingerprint cached", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const configDir = join(tmpDir, "swamp");
    const fileRepo = new AuthRepository({
      configDir,
      getApiKey: () => undefined,
    });
    await fileRepo.save(TEST_CREDENTIALS);

    const envRepo = new AuthRepository({
      configDir,
      getApiKey: () => "swamp_env_key_123",
      getServerUrl: () => undefined,
    });
    const loaded = await envRepo.load();

    assertExists(loaded);
    assertEquals(loaded.username, "");
    assertEquals(loaded.collectives, undefined);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ── saveIdentityCache ──────────────────────────────────────────────────

Deno.test("AuthRepository - saveIdentityCache preserves existing login apiKey/apiKeyId", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const configDir = join(tmpDir, "swamp");
    const repo = new AuthRepository({
      configDir,
      getApiKey: () => undefined,
    });

    await repo.save(TEST_CREDENTIALS);
    await repo.saveIdentityCache(
      "https://swamp-club.com",
      "envuser",
      ["envorg"],
      "swamp_env_ke",
    );

    const loaded = await repo.load();
    assertExists(loaded);
    assertEquals(loaded.apiKey, TEST_CREDENTIALS.apiKey);
    assertEquals(loaded.apiKeyId, TEST_CREDENTIALS.apiKeyId);
    assertEquals(loaded.username, "envuser");
    assertEquals(loaded.collectives, ["envorg"]);
    assertEquals(loaded.apiKeyFingerprint, "swamp_env_ke");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AuthRepository - saveIdentityCache creates file when none exists", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const configDir = join(tmpDir, "swamp");
    const repo = new AuthRepository({
      configDir,
      getApiKey: () => undefined,
    });

    await repo.saveIdentityCache(
      "https://swamp-club.com",
      "newuser",
      ["org1"],
      "swamp_new_ke",
    );

    const loaded = await repo.load();
    assertExists(loaded);
    assertEquals(loaded.apiKey, "");
    assertEquals(loaded.apiKeyId, "");
    assertEquals(loaded.username, "newuser");
    assertEquals(loaded.collectives, ["org1"]);
    assertEquals(loaded.apiKeyFingerprint, "swamp_new_ke");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ── Domain migration: legacy swamp.club → swamp-club.com ─────────────

Deno.test("AuthRepository - load rewrites legacy https://swamp.club to new domain and persists", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const repo = new AuthRepository({
      configDir: join(tmpDir, "swamp"),
      getApiKey: () => undefined,
    });

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
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AuthRepository - load leaves custom server URLs untouched", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const repo = new AuthRepository({
      configDir: join(tmpDir, "swamp"),
      getApiKey: () => undefined,
    });

    await repo.save({
      ...TEST_CREDENTIALS,
      serverUrl: "https://staging.swamp.club",
    });

    const loaded = await repo.load();
    assertExists(loaded);
    assertEquals(loaded.serverUrl, "https://staging.swamp.club");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ── Scope cache tests ───────────────────────────────────────────────────

Deno.test("AuthRepository - saveScopeCache and loadScopeCache round trip", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const repo = new AuthRepository({ configDir: join(tmpDir, "swamp") });
    const fingerprint = "swamp_org_te";
    const scopes = ["extensions:*", "serve:*", "datastore:*", "vault:*"];

    await repo.saveScopeCache(fingerprint, scopes);
    const loaded = await repo.loadScopeCache(fingerprint);

    assertEquals(loaded, scopes);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AuthRepository - loadScopeCache returns undefined on fingerprint mismatch", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const repo = new AuthRepository({ configDir: join(tmpDir, "swamp") });

    await repo.saveScopeCache("swamp_org_aa", ["serve:*"]);
    const loaded = await repo.loadScopeCache("swamp_org_bb");

    assertEquals(loaded, undefined);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AuthRepository - loadScopeCache returns undefined when no cache file exists", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const repo = new AuthRepository({ configDir: join(tmpDir, "swamp") });
    const loaded = await repo.loadScopeCache("swamp_org_te");

    assertEquals(loaded, undefined);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AuthRepository - loadScopeCache returns undefined on corrupted JSON", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const configDir = join(tmpDir, "swamp");
    await Deno.mkdir(configDir, { recursive: true });
    await Deno.writeTextFile(
      join(configDir, "scope_cache.json"),
      "not json{{{",
    );

    const repo = new AuthRepository({ configDir });
    const loaded = await repo.loadScopeCache("swamp_org_te");

    assertEquals(loaded, undefined);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AuthRepository - saveScopeCache sets restrictive file permissions", async () => {
  if (Deno.build.os === "windows") return;
  const tmpDir = await Deno.makeTempDir();
  try {
    const configDir = join(tmpDir, "swamp");
    const repo = new AuthRepository({ configDir });

    await repo.saveScopeCache("swamp_org_te", ["serve:*"]);

    const stat = await Deno.stat(join(configDir, "scope_cache.json"));
    assertEquals(stat.mode !== null && (stat.mode & 0o777) === 0o600, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("AuthRepository - delete also removes scope_cache.json", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const configDir = join(tmpDir, "swamp");
    const repo = new AuthRepository({ configDir });

    await repo.save(TEST_CREDENTIALS);
    await repo.saveScopeCache("swamp_org_te", ["serve:*"]);
    await repo.delete();

    const loaded = await repo.load();
    assertEquals(loaded, null);
    const scopes = await repo.loadScopeCache("swamp_org_te");
    assertEquals(scopes, undefined);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
