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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import { UserError } from "../../domain/errors.ts";
import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import {
  authLogout,
  type AuthLogoutDeps,
  type AuthLogoutEvent,
  createAuthLogoutDeps,
} from "./logout.ts";

function makeDeps(overrides: Partial<AuthLogoutDeps> = {}): AuthLogoutDeps {
  return {
    loadCredentials: () =>
      Promise.resolve({
        username: "testuser",
        serverUrl: "https://api.example.com",
        apiKey: "swamp_test_key",
      }),
    revokeApiKey: () => Promise.resolve({ kind: "revoked", id: "key-1" }),
    deleteCredentials: () => Promise.resolve(),
    credentialsPath: () => "/home/test/.config/swamp/auth.json",
    ...overrides,
  };
}

function completedData(events: AuthLogoutEvent[]) {
  assertEquals(events.length, 1);
  const event = events[0];
  assertEquals(event.kind, "completed");
  return (event as Extract<AuthLogoutEvent, { kind: "completed" }>).data;
}

function errorOf(events: AuthLogoutEvent[]) {
  assertEquals(events.length, 1);
  const event = events[0];
  assertEquals(event.kind, "error");
  return (event as Extract<AuthLogoutEvent, { kind: "error" }>).error;
}

Deno.test("authLogout: revokes the key on the stored server, then deletes credentials", async () => {
  const calls: string[] = [];
  const deps = makeDeps({
    revokeApiKey: (serverUrl, apiKey) => {
      calls.push(`revoke ${serverUrl} ${apiKey}`);
      return Promise.resolve({ kind: "revoked", id: "key-1" });
    },
    deleteCredentials: () => {
      calls.push("delete");
      return Promise.resolve();
    },
  });

  const data = completedData(
    await collect<AuthLogoutEvent>(authLogout(createLibSwampContext(), deps)),
  );

  assertEquals(calls, [
    "revoke https://api.example.com swamp_test_key",
    "delete",
  ]);
  assertEquals(data, {
    loggedOut: true,
    username: "testuser",
    serverUrl: "https://api.example.com",
    keyRevocation: "revoked",
    keyId: "key-1",
  });
});

Deno.test("authLogout: deletes credentials when the key is already invalid", async () => {
  let deleteCalled = false;
  const deps = makeDeps({
    revokeApiKey: () => Promise.resolve({ kind: "already_invalid" }),
    deleteCredentials: () => {
      deleteCalled = true;
      return Promise.resolve();
    },
  });

  const data = completedData(
    await collect<AuthLogoutEvent>(authLogout(createLibSwampContext(), deps)),
  );

  assertEquals(deleteCalled, true);
  assertEquals(data.loggedOut, true);
  assertEquals(data.keyRevocation, "already_invalid");
  assertEquals(data.keyId, undefined);
});

for (
  const reason of [
    "Could not connect to https://api.example.com: connection refused",
    "https://api.example.com does not support revoking API keys from the CLI.",
    "https://api.example.com refused to revoke the stored credential: it is not a personal API key.",
    "Failed to revoke API key on https://api.example.com (HTTP 500): boom",
    "Rate limit exceeded.",
  ]
) {
  Deno.test(`authLogout: keeps credentials when revoking fails (${reason})`, async () => {
    let deleteCalled = false;
    const deps = makeDeps({
      revokeApiKey: () => Promise.reject(new UserError(reason)),
      deleteCredentials: () => {
        deleteCalled = true;
        return Promise.resolve();
      },
    });

    const error = errorOf(
      await collect<AuthLogoutEvent>(authLogout(createLibSwampContext(), deps)),
    );

    assertEquals(deleteCalled, false);
    assertEquals(error.code, "revoke_failed");
    assertStringIncludes(error.message, reason);
    // the reason always ends a sentence before the kept-credentials note
    assertEquals(/[.!?…] Your credentials were kept/.test(error.message), true);
    assertStringIncludes(
      error.message,
      "/home/test/.config/swamp/auth.json",
    );
    assertStringIncludes(error.message, "swamp auth logout");
  });
}

Deno.test("authLogout: keeps credentials and yields cancelled when aborted", async () => {
  let deleteCalled = false;
  const deps = makeDeps({
    revokeApiKey: () =>
      Promise.reject(new DOMException("aborted", "AbortError")),
    deleteCredentials: () => {
      deleteCalled = true;
      return Promise.resolve();
    },
  });

  const error = errorOf(
    await collect<AuthLogoutEvent>(authLogout(createLibSwampContext(), deps)),
  );

  assertEquals(deleteCalled, false);
  assertEquals(error.code, "cancelled");
});

Deno.test("authLogout: deletes credentials without a revoke when no key is stored", async () => {
  let revokeCalled = false;
  let deleteCalled = false;
  const deps = makeDeps({
    loadCredentials: () =>
      Promise.resolve({
        username: "testuser",
        serverUrl: "https://api.example.com",
        apiKey: "",
      }),
    revokeApiKey: () => {
      revokeCalled = true;
      return Promise.resolve({ kind: "revoked", id: "key-1" });
    },
    deleteCredentials: () => {
      deleteCalled = true;
      return Promise.resolve();
    },
  });

  const data = completedData(
    await collect<AuthLogoutEvent>(authLogout(createLibSwampContext(), deps)),
  );

  assertEquals(revokeCalled, false);
  assertEquals(deleteCalled, true);
  assertEquals(data.keyRevocation, "no_key");
});

Deno.test("authLogout: yields completed with loggedOut false when not authenticated", async () => {
  let revokeCalled = false;
  const deps = makeDeps({
    loadCredentials: () => Promise.resolve(null),
    revokeApiKey: () => {
      revokeCalled = true;
      return Promise.resolve({ kind: "revoked", id: "key-1" });
    },
  });

  const data = completedData(
    await collect<AuthLogoutEvent>(authLogout(createLibSwampContext(), deps)),
  );

  assertEquals(revokeCalled, false);
  assertEquals(data.loggedOut, false);
  assertEquals(data.reason, "not authenticated");
});

Deno.test("createAuthLogoutDeps: loads the stored login key even when SWAMP_API_KEY and SWAMP_CLUB_URL are set", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    // Inject overrides instead of mutating Deno.env — `deno test --parallel`
    // runs logout_test and whoami_test in different files concurrently and
    // both touch SWAMP_API_KEY / XDG_CONFIG_HOME. Going through the deps
    // options keeps this test hermetic.
    const configDir = join(tmpDir, "swamp");
    await new AuthRepository({ configDir, getApiKey: () => undefined }).save({
      serverUrl: "https://swamp-club.com",
      apiKey: "swamp_login_key",
      apiKeyId: "key-1",
      username: "testuser",
    });

    const deps = createAuthLogoutDeps({
      repo: {
        configDir,
        getApiKey: () => "swamp_test_env_key",
        getServerUrl: () => "https://other.example.com",
      },
    });
    const creds = await deps.loadCredentials();

    assertEquals(creds, {
      username: "testuser",
      serverUrl: "https://swamp-club.com",
      apiKey: "swamp_login_key",
    });
    assertEquals(deps.credentialsPath(), join(configDir, "auth.json"));
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
