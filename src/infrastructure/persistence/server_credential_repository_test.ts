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
import { FileServerCredentialRepository } from "./server_credential_repository.ts";
import type { ServerCredential } from "../../domain/auth/server_credential.ts";

const TEST_CREDENTIAL: ServerCredential = {
  serverUrl: "https://swamp.acme.internal:9090",
  tokenName: "tkn_abc",
  token: "tkn_abc.secret123",
  principalId: "user-uuid-1",
  displayName: "Test User",
  obtainedAt: "2026-06-18T00:00:00Z",
};

const TEST_CREDENTIAL_2: ServerCredential = {
  serverUrl: "https://other.server.com",
  tokenName: "tkn_xyz",
  token: "tkn_xyz.secret456",
  principalId: "user-uuid-2",
  obtainedAt: "2026-06-18T01:00:00Z",
};

Deno.test("FileServerCredentialRepository - save and get round trip", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const repo = new FileServerCredentialRepository({
      configDir: join(tmpDir, "swamp"),
      getServerToken: () => undefined,
      getServerUrl: () => undefined,
    });

    await repo.save(TEST_CREDENTIAL);
    const loaded = await repo.get(TEST_CREDENTIAL.serverUrl);

    assertExists(loaded);
    assertEquals(loaded.serverUrl, TEST_CREDENTIAL.serverUrl);
    assertEquals(loaded.tokenName, TEST_CREDENTIAL.tokenName);
    assertEquals(loaded.token, TEST_CREDENTIAL.token);
    assertEquals(loaded.principalId, TEST_CREDENTIAL.principalId);
    assertEquals(loaded.displayName, TEST_CREDENTIAL.displayName);
    assertEquals(loaded.obtainedAt, TEST_CREDENTIAL.obtainedAt);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("FileServerCredentialRepository - get returns null when no file exists", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const repo = new FileServerCredentialRepository({
      configDir: join(tmpDir, "swamp"),
      getServerToken: () => undefined,
      getServerUrl: () => undefined,
    });

    const loaded = await repo.get("https://nonexistent.server.com");
    assertEquals(loaded, null);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("FileServerCredentialRepository - remove deletes a credential", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const repo = new FileServerCredentialRepository({
      configDir: join(tmpDir, "swamp"),
      getServerToken: () => undefined,
      getServerUrl: () => undefined,
    });

    await repo.save(TEST_CREDENTIAL);
    assertExists(await repo.get(TEST_CREDENTIAL.serverUrl));

    await repo.remove(TEST_CREDENTIAL.serverUrl);
    assertEquals(await repo.get(TEST_CREDENTIAL.serverUrl), null);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("FileServerCredentialRepository - remove is idempotent (no error when missing)", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const repo = new FileServerCredentialRepository({
      configDir: join(tmpDir, "swamp"),
      getServerToken: () => undefined,
      getServerUrl: () => undefined,
    });

    await repo.remove("https://nonexistent.server.com");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("FileServerCredentialRepository - list returns all credentials", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const repo = new FileServerCredentialRepository({
      configDir: join(tmpDir, "swamp"),
      getServerToken: () => undefined,
      getServerUrl: () => undefined,
    });

    await repo.save(TEST_CREDENTIAL);
    await repo.save(TEST_CREDENTIAL_2);

    const all = await repo.list();
    assertEquals(all.length, 2);

    const urls = all.map((c) => c.serverUrl).sort();
    assertEquals(urls, [
      "https://other.server.com",
      "https://swamp.acme.internal:9090",
    ]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("FileServerCredentialRepository - list returns empty array when no file", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const repo = new FileServerCredentialRepository({
      configDir: join(tmpDir, "swamp"),
      getServerToken: () => undefined,
      getServerUrl: () => undefined,
    });

    const all = await repo.list();
    assertEquals(all, []);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("FileServerCredentialRepository - save normalizes URL key", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const repo = new FileServerCredentialRepository({
      configDir: join(tmpDir, "swamp"),
      getServerToken: () => undefined,
      getServerUrl: () => undefined,
    });

    await repo.save({
      ...TEST_CREDENTIAL,
      serverUrl: "https://SWAMP.ACME.INTERNAL:9090/",
    });

    const loaded = await repo.get("https://swamp.acme.internal:9090");
    assertExists(loaded);
    assertEquals(loaded.serverUrl, "https://swamp.acme.internal:9090");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("FileServerCredentialRepository - get normalizes URL for lookup", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const repo = new FileServerCredentialRepository({
      configDir: join(tmpDir, "swamp"),
      getServerToken: () => undefined,
      getServerUrl: () => undefined,
    });

    await repo.save(TEST_CREDENTIAL);

    const loaded = await repo.get("https://SWAMP.ACME.INTERNAL:9090/");
    assertExists(loaded);
    assertEquals(loaded.tokenName, TEST_CREDENTIAL.tokenName);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("FileServerCredentialRepository - save overwrites existing credential for same URL", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const repo = new FileServerCredentialRepository({
      configDir: join(tmpDir, "swamp"),
      getServerToken: () => undefined,
      getServerUrl: () => undefined,
    });

    await repo.save(TEST_CREDENTIAL);
    await repo.save({
      ...TEST_CREDENTIAL,
      token: "tkn_abc.newsecret",
    });

    const loaded = await repo.get(TEST_CREDENTIAL.serverUrl);
    assertExists(loaded);
    assertEquals(loaded.token, "tkn_abc.newsecret");

    const all = await repo.list();
    assertEquals(all.length, 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("FileServerCredentialRepository - remove does not affect other credentials", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const repo = new FileServerCredentialRepository({
      configDir: join(tmpDir, "swamp"),
      getServerToken: () => undefined,
      getServerUrl: () => undefined,
    });

    await repo.save(TEST_CREDENTIAL);
    await repo.save(TEST_CREDENTIAL_2);

    await repo.remove(TEST_CREDENTIAL.serverUrl);

    assertEquals(await repo.get(TEST_CREDENTIAL.serverUrl), null);
    assertExists(await repo.get(TEST_CREDENTIAL_2.serverUrl));
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("FileServerCredentialRepository - save sets restrictive file permissions", async () => {
  if (Deno.build.os === "windows") return;
  const tmpDir = await Deno.makeTempDir();
  try {
    const repo = new FileServerCredentialRepository({
      configDir: join(tmpDir, "swamp"),
      getServerToken: () => undefined,
      getServerUrl: () => undefined,
    });

    await repo.save(TEST_CREDENTIAL);

    const stat = await Deno.stat(join(tmpDir, "swamp", "servers.json"));
    assertEquals(stat.mode !== null && (stat.mode & 0o777) === 0o600, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ── SWAMP_SERVER_TOKEN override tests ─────────────────────────────────

Deno.test("FileServerCredentialRepository - get returns env var credential when SWAMP_SERVER_TOKEN matches URL", async () => {
  const repo = new FileServerCredentialRepository({
    getServerToken: () => "env_token_123",
    getServerUrl: () => "https://swamp.example.com",
  });

  const loaded = await repo.get("https://swamp.example.com");

  assertExists(loaded);
  assertEquals(loaded.token, "env_token_123");
  assertEquals(loaded.serverUrl, "https://swamp.example.com");
  assertEquals(loaded.tokenName, "");
  assertEquals(loaded.principalId, "");
});

Deno.test("FileServerCredentialRepository - SWAMP_SERVER_TOKEN takes precedence over file", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const fileRepo = new FileServerCredentialRepository({
      configDir: join(tmpDir, "swamp"),
      getServerToken: () => undefined,
      getServerUrl: () => undefined,
    });
    await fileRepo.save({
      ...TEST_CREDENTIAL,
      serverUrl: "https://swamp.example.com",
    });

    const envRepo = new FileServerCredentialRepository({
      configDir: join(tmpDir, "swamp"),
      getServerToken: () => "env_override_token",
      getServerUrl: () => "https://swamp.example.com",
    });
    const loaded = await envRepo.get("https://swamp.example.com");

    assertExists(loaded);
    assertEquals(loaded.token, "env_override_token");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("FileServerCredentialRepository - SWAMP_SERVER_TOKEN does not match different URL", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const repo = new FileServerCredentialRepository({
      configDir: join(tmpDir, "swamp"),
      getServerToken: () => "env_token_123",
      getServerUrl: () => "https://other.server.com",
    });
    await repo.save(TEST_CREDENTIAL);

    const loaded = await repo.get(TEST_CREDENTIAL.serverUrl);
    assertExists(loaded);
    assertEquals(loaded.token, TEST_CREDENTIAL.token);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("FileServerCredentialRepository - SWAMP_SERVER_TOKEN without SWAMP_SERVER_URL falls through to file", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const repo = new FileServerCredentialRepository({
      configDir: join(tmpDir, "swamp"),
      getServerToken: () => "env_token_123",
      getServerUrl: () => undefined,
    });
    await repo.save(TEST_CREDENTIAL);

    const loaded = await repo.get(TEST_CREDENTIAL.serverUrl);
    assertExists(loaded);
    assertEquals(loaded.token, TEST_CREDENTIAL.token);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("FileServerCredentialRepository - SWAMP_SERVER_TOKEN normalizes env URL for comparison", async () => {
  const repo = new FileServerCredentialRepository({
    getServerToken: () => "env_token_normalized",
    getServerUrl: () => "https://SWAMP.EXAMPLE.COM:443/",
  });

  const loaded = await repo.get("https://swamp.example.com");

  assertExists(loaded);
  assertEquals(loaded.token, "env_token_normalized");
});
