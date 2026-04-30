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

import { assertEquals } from "@std/assert";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
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
      }),
    deleteCredentials: () => Promise.resolve(),
    ...overrides,
  };
}

Deno.test("authLogout: yields completed with loggedOut true when authenticated", async () => {
  let deleteCalled = false;
  const deps = makeDeps({
    deleteCredentials: () => {
      deleteCalled = true;
      return Promise.resolve();
    },
  });

  const events = await collect<AuthLogoutEvent>(
    authLogout(createLibSwampContext(), deps),
  );

  assertEquals(events.length, 1);
  const completed = events[0] as Extract<
    AuthLogoutEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.loggedOut, true);
  assertEquals(completed.data.username, "testuser");
  assertEquals(completed.data.serverUrl, "https://api.example.com");
  assertEquals(deleteCalled, true);
});

Deno.test("authLogout: yields completed with loggedOut false when not authenticated", async () => {
  const deps = makeDeps({
    loadCredentials: () => Promise.resolve(null),
  });

  const events = await collect<AuthLogoutEvent>(
    authLogout(createLibSwampContext(), deps),
  );

  assertEquals(events.length, 1);
  const completed = events[0] as Extract<
    AuthLogoutEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.loggedOut, false);
  assertEquals(completed.data.reason, "not authenticated");
});

Deno.test("createAuthLogoutDeps: loadCredentials returns env-var creds when SWAMP_API_KEY is set", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    // Inject overrides instead of mutating Deno.env — `deno test --parallel`
    // runs logout_test and whoami_test in different files concurrently and
    // both touch SWAMP_API_KEY / XDG_CONFIG_HOME. Going through the deps
    // options keeps this test hermetic.
    const deps = createAuthLogoutDeps({
      repo: {
        configDir: `${tmpDir}/swamp`,
        getApiKey: () => "swamp_test_env_key",
      },
    });
    const creds = await deps.loadCredentials();
    // With SWAMP_API_KEY set, loadCredentials returns env-var creds
    // (username is empty since env var doesn't provide it)
    assertEquals(creds !== null, true);
    assertEquals(creds!.username, "");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
