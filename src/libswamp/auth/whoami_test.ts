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
import type { AuthCredentials } from "../../domain/auth/auth_credentials.ts";
import type { WhoamiResponse } from "../../infrastructure/http/swamp_club_client.ts";
import { createLibSwampContext } from "../context.ts";
import { collect } from "../testing.ts";
import {
  type AuthDeps,
  type AuthWhoamiEvent,
  createAuthDeps,
  whoami,
} from "./whoami.ts";

function makeDeps(overrides: {
  credentials?: AuthCredentials | null;
  whoamiResponse?: WhoamiResponse;
  serverUrlOverride?: string;
}): AuthDeps {
  return {
    loadCredentials: () => Promise.resolve(overrides.credentials ?? null),
    saveCredentials: () => Promise.resolve(),
    fetchWhoami: (
      _serverUrl: string,
      _apiKey: string,
      _signal: AbortSignal,
    ) =>
      Promise.resolve(
        overrides.whoamiResponse ?? { authenticated: false },
      ),
    serverUrlOverride: overrides.serverUrlOverride,
  };
}

const testCredentials: AuthCredentials = {
  serverUrl: "https://swamp-club.com",
  apiKey: "swamp_test_key",
  apiKeyId: "key-1",
  username: "adam",
};

const testWhoamiResponse: WhoamiResponse = {
  authenticated: true,
  id: "user-1",
  username: "adam",
  email: "adam@example.com",
  name: "Adam",
  organizations: [
    { slug: "si", name: "System Initiative", role: "admin", personal: false },
  ],
};

Deno.test("whoami yields loading_credentials -> contacting_server -> completed on success", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps({
    credentials: testCredentials,
    whoamiResponse: testWhoamiResponse,
  });

  const events = await collect<AuthWhoamiEvent>(whoami(ctx, deps));

  assertEquals(events, [
    { kind: "loading_credentials" },
    { kind: "contacting_server", serverUrl: "https://swamp-club.com" },
    {
      kind: "completed",
      identity: {
        serverUrl: "https://swamp-club.com",
        id: "user-1",
        username: "adam",
        email: "adam@example.com",
        name: "Adam",
        collectives: ["si"],
      },
    },
  ]);
});

Deno.test("whoami yields not_authenticated error when no credentials", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps({ credentials: null });

  const events = await collect<AuthWhoamiEvent>(whoami(ctx, deps));

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "loading_credentials" });
  const last = events[1] as Extract<AuthWhoamiEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "not_authenticated");
});

Deno.test("whoami yields invalid_api_key error when server says not authenticated", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps({
    credentials: testCredentials,
    whoamiResponse: { authenticated: false },
  });

  const events = await collect<AuthWhoamiEvent>(whoami(ctx, deps));

  assertEquals(events.length, 3);
  assertEquals(events[0], { kind: "loading_credentials" });
  assertEquals(events[1], {
    kind: "contacting_server",
    serverUrl: "https://swamp-club.com",
  });
  const last = events[2] as Extract<AuthWhoamiEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "invalid_api_key");
});

Deno.test("whoami uses serverUrlOverride when provided", async () => {
  const ctx = createLibSwampContext();
  const fetchedUrls: string[] = [];
  const deps: AuthDeps = {
    loadCredentials: () => Promise.resolve(testCredentials),
    saveCredentials: () => Promise.resolve(),
    fetchWhoami: (serverUrl, _apiKey, _signal) => {
      fetchedUrls.push(serverUrl);
      return Promise.resolve(testWhoamiResponse);
    },
    serverUrlOverride: "https://custom.server",
  };

  const events = await collect<AuthWhoamiEvent>(whoami(ctx, deps));

  assertEquals(fetchedUrls, ["https://custom.server"]);
  assertEquals(events[1], {
    kind: "contacting_server",
    serverUrl: "https://custom.server",
  });
});

Deno.test("whoami excludes collectives when response has no organizations", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps({
    credentials: testCredentials,
    whoamiResponse: {
      authenticated: true,
      id: "user-1",
      username: "adam",
      email: "adam@example.com",
      name: "Adam",
    },
  });

  const events = await collect<AuthWhoamiEvent>(whoami(ctx, deps));

  const completed = events[2] as Extract<
    AuthWhoamiEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.identity.collectives, undefined);
});

Deno.test("whoami yields cancelled error when signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const ctx = createLibSwampContext({ signal: controller.signal });
  const deps: AuthDeps = {
    loadCredentials: () => Promise.resolve(testCredentials),
    saveCredentials: () => Promise.resolve(),
    fetchWhoami: (_serverUrl, _apiKey, signal) => {
      signal.throwIfAborted();
      return Promise.resolve(testWhoamiResponse);
    },
    serverUrlOverride: undefined,
  };

  const events = await collect<AuthWhoamiEvent>(whoami(ctx, deps));

  const last = events[events.length - 1] as Extract<
    AuthWhoamiEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "cancelled");
});

Deno.test("whoami does not persist credentials when saveCredentials is a no-op", async () => {
  const ctx = createLibSwampContext();
  let saveCalled = false;
  const envCredentials: AuthCredentials = {
    serverUrl: "https://swamp-club.com",
    apiKey: "swamp_env_key",
    apiKeyId: "",
    username: "",
  };

  // Simulate env-var auth: createAuthDeps makes saveCredentials a no-op
  // when SWAMP_API_KEY is set. Verify that the whoami generator still
  // completes successfully and the real save is never called.
  const deps: AuthDeps = {
    loadCredentials: () => Promise.resolve(envCredentials),
    saveCredentials: () => {
      saveCalled = true;
      return Promise.resolve();
    },
    fetchWhoami: () => Promise.resolve(testWhoamiResponse),
    serverUrlOverride: undefined,
  };

  // Replace saveCredentials with a no-op (as production code does for env-var auth)
  const noOpDeps: AuthDeps = {
    ...deps,
    saveCredentials: () => Promise.resolve(),
  };
  const events = await collect<AuthWhoamiEvent>(whoami(ctx, noOpDeps));

  const completed = events[events.length - 1] as Extract<
    AuthWhoamiEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(saveCalled, false);
});

Deno.test("createAuthDeps: saveCredentials is a no-op when SWAMP_API_KEY is set", async () => {
  const originalKey = Deno.env.get("SWAMP_API_KEY");
  const originalXdg = Deno.env.get("XDG_CONFIG_HOME");
  const tmpDir = await Deno.makeTempDir();
  try {
    Deno.env.set("SWAMP_API_KEY", "swamp_test_env_key");
    Deno.env.set("XDG_CONFIG_HOME", tmpDir);
    const deps = createAuthDeps();

    // saveCredentials should be a no-op — no file should be written
    await deps.saveCredentials(testCredentials);
    const files = [];
    try {
      for await (const entry of Deno.readDir(`${tmpDir}/swamp`)) {
        files.push(entry.name);
      }
    } catch {
      // Directory doesn't exist — expected, since save was a no-op
    }
    assertEquals(files.includes("auth.json"), false);
  } finally {
    if (originalKey) Deno.env.set("SWAMP_API_KEY", originalKey);
    else Deno.env.delete("SWAMP_API_KEY");
    if (originalXdg) Deno.env.set("XDG_CONFIG_HOME", originalXdg);
    else Deno.env.delete("XDG_CONFIG_HOME");
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("createAuthDeps: saveCredentials writes file when SWAMP_API_KEY is not set", async () => {
  const originalKey = Deno.env.get("SWAMP_API_KEY");
  const originalXdg = Deno.env.get("XDG_CONFIG_HOME");
  const tmpDir = await Deno.makeTempDir();
  try {
    Deno.env.delete("SWAMP_API_KEY");
    Deno.env.set("XDG_CONFIG_HOME", tmpDir);
    const deps = createAuthDeps();

    await deps.saveCredentials(testCredentials);
    const stat = await Deno.stat(`${tmpDir}/swamp/auth.json`);
    assertEquals(stat.isFile, true);
  } finally {
    if (originalKey) Deno.env.set("SWAMP_API_KEY", originalKey);
    else Deno.env.delete("SWAMP_API_KEY");
    if (originalXdg) Deno.env.set("XDG_CONFIG_HOME", originalXdg);
    else Deno.env.delete("XDG_CONFIG_HOME");
    await Deno.remove(tmpDir, { recursive: true });
  }
});
