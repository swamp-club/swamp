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
  authLogin,
  type AuthLoginDeps,
  type AuthLoginEvent,
  type AuthLoginInput,
} from "./login.ts";

function makeDeps(overrides: Partial<AuthLoginDeps> = {}): AuthLoginDeps {
  return {
    openBrowser: () => Promise.resolve(null),
    startCallbackServer: (_state: string, _serverUrl: string) => ({
      port: 9999,
      token: Promise.resolve("session-token-abc"),
      shutdown: () => Promise.resolve(),
    }),
    signIn: (_serverUrl: string, _username: string, _password: string) =>
      Promise.resolve({ token: "session-token-abc", username: "testuser" }),
    readCredentials: () =>
      Promise.resolve({ username: "testuser", password: "testpass" }),
    createApiKey: (
      _serverUrl: string,
      _sessionToken: string,
      _keyName: string,
    ) => Promise.resolve({ id: "key-id-1", key: "swamp_testapikey123456" }),
    whoami: (_serverUrl: string, _apiKey: string) =>
      Promise.resolve({
        username: "testuser",
        email: "test@example.com",
        name: "Test User",
        collectives: ["org1"],
      }),
    saveCredentials: () => Promise.resolve(),
    generateDeviceCode: () => "ABCD-1234",
    getHostname: () => "testhost",
    ...overrides,
  };
}

function makeInput(overrides: Partial<AuthLoginInput> = {}): AuthLoginInput {
  return {
    serverUrl: "https://swamp.club",
    useBrowserFlow: false,
    ...overrides,
  };
}

Deno.test("authLogin: successful browser flow emits correct event sequence", async () => {
  let savedCreds: Record<string, unknown> = {};
  const deps = makeDeps({
    saveCredentials: (creds) => {
      savedCreds = creds as unknown as Record<string, unknown>;
      return Promise.resolve();
    },
  });
  const input = makeInput({ useBrowserFlow: true });

  const events = await collect<AuthLoginEvent>(
    authLogin(createLibSwampContext(), deps, input),
  );

  const kinds = events.map((e) => e.kind);
  assertEquals(kinds, [
    "opening_browser",
    "device_verification",
    "waiting_for_auth",
    "securing_session",
    "completed",
  ]);

  const deviceEvent = events[1] as Extract<
    AuthLoginEvent,
    { kind: "device_verification" }
  >;
  assertEquals(deviceEvent.deviceCode, "ABCD-1234");

  const completed = events[4] as Extract<
    AuthLoginEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.username, "testuser");
  assertEquals(completed.data.email, "test@example.com");
  assertEquals(completed.data.serverUrl, "https://swamp.club");
  assertEquals(completed.data.apiKey, "swamp_testapikey123456");

  assertEquals(savedCreds.username, "testuser");
  assertEquals(savedCreds.apiKey, "swamp_testapikey123456");
});

Deno.test("authLogin: browser open failure emits browser_open_failed event", async () => {
  const deps = makeDeps({
    openBrowser: () =>
      Promise.resolve(
        "Could not open a browser. Please open this URL manually:\n  https://example.com",
      ),
  });
  const input = makeInput({ useBrowserFlow: true });

  const events = await collect<AuthLoginEvent>(
    authLogin(createLibSwampContext(), deps, input),
  );

  const kinds = events.map((e) => e.kind);
  assertEquals(kinds, [
    "opening_browser",
    "browser_open_failed",
    "device_verification",
    "waiting_for_auth",
    "securing_session",
    "completed",
  ]);

  const failedEvent = events[1] as Extract<
    AuthLoginEvent,
    { kind: "browser_open_failed" }
  >;
  assertEquals(
    failedEvent.message.includes("Could not open a browser"),
    true,
  );
});

Deno.test("authLogin: successful stdin flow with provided credentials", async () => {
  const deps = makeDeps();
  const input = makeInput({
    useBrowserFlow: false,
    username: "myuser",
    password: "mypass",
  });

  const events = await collect<AuthLoginEvent>(
    authLogin(createLibSwampContext(), deps, input),
  );

  const kinds = events.map((e) => e.kind);
  assertEquals(kinds, ["securing_session", "completed"]);

  const completed = events[1] as Extract<
    AuthLoginEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.username, "testuser");
  assertEquals(completed.data.serverUrl, "https://swamp.club");
});

Deno.test("authLogin: stdin flow reads credentials when not provided", async () => {
  let readCalled = false;
  const deps = makeDeps({
    readCredentials: () => {
      readCalled = true;
      return Promise.resolve({ username: "interactive", password: "secret" });
    },
    signIn: (_serverUrl: string, _username: string, _password: string) =>
      Promise.resolve({ token: "tok", username: "interactive" }),
    whoami: (_serverUrl: string, _apiKey: string) =>
      Promise.resolve({
        username: "interactive",
        email: "interactive@example.com",
      }),
  });
  const input = makeInput({ useBrowserFlow: false });

  const events = await collect<AuthLoginEvent>(
    authLogin(createLibSwampContext(), deps, input),
  );

  assertEquals(readCalled, true);
  const completed = events[events.length - 1] as Extract<
    AuthLoginEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.username, "interactive");
});

Deno.test("authLogin: stdin flow missing credentials yields validation error", async () => {
  const deps = makeDeps({
    readCredentials: () => Promise.resolve({ username: "", password: "" }),
  });
  const input = makeInput({ useBrowserFlow: false });

  const events = await collect<AuthLoginEvent>(
    authLogin(createLibSwampContext(), deps, input),
  );

  assertEquals(events.length, 1);
  const errorEvent = events[0] as Extract<
    AuthLoginEvent,
    { kind: "error" }
  >;
  assertEquals(errorEvent.kind, "error");
  assertEquals(errorEvent.error.code, "validation_failed");
  assertEquals(
    errorEvent.error.message,
    "Username and password are required.",
  );
});

Deno.test("authLogin: callback server is shut down after browser flow", async () => {
  let shutdownCalled = false;
  const deps = makeDeps({
    startCallbackServer: (_state: string, _serverUrl: string) => ({
      port: 8888,
      token: Promise.resolve("tok"),
      shutdown: () => {
        shutdownCalled = true;
        return Promise.resolve();
      },
    }),
  });
  const input = makeInput({ useBrowserFlow: true });

  await collect<AuthLoginEvent>(
    authLogin(createLibSwampContext(), deps, input),
  );

  assertEquals(shutdownCalled, true);
});
