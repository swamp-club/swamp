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

import { assertEquals } from "@std/assert";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  authLogin,
  type AuthLoginDeps,
  type AuthLoginEvent,
  type AuthLoginInput,
  DeviceAuthPendingError,
} from "./login.ts";

function makeDeps(overrides: Partial<AuthLoginDeps> = {}): AuthLoginDeps {
  return {
    openBrowser: () => Promise.resolve(true),
    startDeviceAuth: () =>
      Promise.resolve({
        deviceCode: "device-abc-123",
        userCode: "ABCD-1234",
        verificationUri: "https://swamp-club.com/device",
        verificationUriComplete:
          "https://swamp-club.com/device?user_code=ABCD-1234",
        expiresIn: 900,
        interval: 0.001,
      }),
    pollDeviceToken: () =>
      Promise.resolve({ accessToken: "session-token-abc" }),
    signIn: (_serverUrl: string, _username: string, _password: string) =>
      Promise.resolve({ token: "session-token-abc", username: "testuser" }),
    readCredentials: (_prefilled) =>
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
    getHostname: () => "testhost",
    ...overrides,
  };
}

function makeInput(overrides: Partial<AuthLoginInput> = {}): AuthLoginInput {
  return {
    serverUrl: "https://swamp-club.com",
    useBrowserFlow: false,
    ...overrides,
  };
}

Deno.test("authLogin: successful device flow emits correct event sequence", async () => {
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
    "device_verification",
    "opening_browser",
    "polling",
    "securing_session",
    "completed",
  ]);

  const deviceEvent = events[0] as Extract<
    AuthLoginEvent,
    { kind: "device_verification" }
  >;
  assertEquals(deviceEvent.userCode, "ABCD-1234");
  assertEquals(
    deviceEvent.verificationUri,
    "https://swamp-club.com/device",
  );
  assertEquals(
    deviceEvent.verificationUriComplete,
    "https://swamp-club.com/device?user_code=ABCD-1234",
  );

  const completed = events[4] as Extract<
    AuthLoginEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.username, "testuser");
  assertEquals(completed.data.email, "test@example.com");
  assertEquals(completed.data.serverUrl, "https://swamp-club.com");
  assertEquals(completed.data.apiKey, "swamp_testapikey123456");

  assertEquals(savedCreds.username, "testuser");
  assertEquals(savedCreds.apiKey, "swamp_testapikey123456");
});

Deno.test("authLogin: browser open failure emits browser_open_failed but completes", async () => {
  const deps = makeDeps({
    openBrowser: () => Promise.resolve(false),
  });
  const input = makeInput({ useBrowserFlow: true });

  const events = await collect<AuthLoginEvent>(
    authLogin(createLibSwampContext(), deps, input),
  );

  const kinds = events.map((e) => e.kind);
  assertEquals(kinds, [
    "device_verification",
    "opening_browser",
    "browser_open_failed",
    "polling",
    "securing_session",
    "completed",
  ]);

  const failedEvent = events[2] as Extract<
    AuthLoginEvent,
    { kind: "browser_open_failed" }
  >;
  assertEquals(
    failedEvent.message.includes("Could not open browser"),
    true,
  );
});

Deno.test("authLogin: retries polling on pending status", async () => {
  let pollCount = 0;
  const deps = makeDeps({
    pollDeviceToken: () => {
      pollCount++;
      if (pollCount < 3) {
        return Promise.reject(new DeviceAuthPendingError());
      }
      return Promise.resolve({ accessToken: "session-token-abc" });
    },
  });
  const input = makeInput({ useBrowserFlow: true });

  const events = await collect<AuthLoginEvent>(
    authLogin(createLibSwampContext(), deps, input),
  );

  const kinds = events.map((e) => e.kind);
  assertEquals(kinds, [
    "device_verification",
    "opening_browser",
    "polling",
    "polling",
    "polling",
    "securing_session",
    "completed",
  ]);
  assertEquals(pollCount, 3);
});

Deno.test("authLogin: yields error on poll failure", async () => {
  const deps = makeDeps({
    pollDeviceToken: () =>
      Promise.reject(
        new Error("Device authorization failed: access_denied"),
      ),
  });
  const input = makeInput({ useBrowserFlow: true });

  const events = await collect<AuthLoginEvent>(
    authLogin(createLibSwampContext(), deps, input),
  );

  const kinds = events.map((e) => e.kind);
  assertEquals(kinds, [
    "device_verification",
    "opening_browser",
    "polling",
    "error",
  ]);

  const errorEvent = events[3] as Extract<
    AuthLoginEvent,
    { kind: "error" }
  >;
  assertEquals(
    errorEvent.error.message.includes("Device authorization failed"),
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
  assertEquals(completed.data.serverUrl, "https://swamp-club.com");
});

Deno.test("authLogin: stdin flow reads credentials when not provided", async () => {
  let readCalled = false;
  const deps = makeDeps({
    readCredentials: (_prefilled) => {
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
    readCredentials: (_prefilled) =>
      Promise.resolve({ username: "", password: "" }),
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

Deno.test("authLogin: stdin flow with --username skips username prompt", async () => {
  let prefilledArg: { username?: string; password?: string } | undefined;
  const deps = makeDeps({
    readCredentials: (prefilled) => {
      prefilledArg = prefilled;
      return Promise.resolve({
        username: prefilled?.username ?? "prompted",
        password: "prompted-pass",
      });
    },
  });
  const input = makeInput({
    useBrowserFlow: false,
    username: "alice",
  });

  const events = await collect<AuthLoginEvent>(
    authLogin(createLibSwampContext(), deps, input),
  );

  assertEquals(prefilledArg?.username, "alice");
  assertEquals(prefilledArg?.password, undefined);

  const kinds = events.map((e) => e.kind);
  assertEquals(kinds, ["securing_session", "completed"]);
});

Deno.test("authLogin: stdin flow with --password skips password prompt", async () => {
  let prefilledArg: { username?: string; password?: string } | undefined;
  const deps = makeDeps({
    readCredentials: (prefilled) => {
      prefilledArg = prefilled;
      return Promise.resolve({
        username: "prompted-user",
        password: prefilled?.password ?? "prompted",
      });
    },
  });
  const input = makeInput({
    useBrowserFlow: false,
    password: "secret",
  });

  const events = await collect<AuthLoginEvent>(
    authLogin(createLibSwampContext(), deps, input),
  );

  assertEquals(prefilledArg?.username, undefined);
  assertEquals(prefilledArg?.password, "secret");

  const kinds = events.map((e) => e.kind);
  assertEquals(kinds, ["securing_session", "completed"]);
});

Deno.test("authLogin: stdin flow with both --username and --password skips all prompts", async () => {
  let readCalled = false;
  const deps = makeDeps({
    readCredentials: (_prefilled) => {
      readCalled = true;
      return Promise.resolve({
        username: "should-not-be-called",
        password: "x",
      });
    },
  });
  const input = makeInput({
    useBrowserFlow: false,
    username: "alice",
    password: "secret",
  });

  const events = await collect<AuthLoginEvent>(
    authLogin(createLibSwampContext(), deps, input),
  );

  assertEquals(readCalled, false);

  const kinds = events.map((e) => e.kind);
  assertEquals(kinds, ["securing_session", "completed"]);
});

Deno.test("authLogin: device flow passes correct client_id and server URL", async () => {
  let capturedServerUrl = "";
  let capturedClientId = "";
  const deps = makeDeps({
    startDeviceAuth: (serverUrl, clientId) => {
      capturedServerUrl = serverUrl;
      capturedClientId = clientId;
      return Promise.resolve({
        deviceCode: "device-abc-123",
        userCode: "WXYZ-5678",
        verificationUri: "https://swamp-club.com/device",
        expiresIn: 900,
        interval: 0.001,
      });
    },
  });
  const input = makeInput({
    useBrowserFlow: true,
    serverUrl: "https://custom-server.example.com",
  });

  await collect<AuthLoginEvent>(
    authLogin(createLibSwampContext(), deps, input),
  );

  assertEquals(capturedServerUrl, "https://custom-server.example.com");
  assertEquals(capturedClientId, "swamp-cli");
});

Deno.test("authLogin: device flow times out when expiresIn elapses", async () => {
  const deps = makeDeps({
    startDeviceAuth: () =>
      Promise.resolve({
        deviceCode: "device-abc-123",
        userCode: "ABCD-1234",
        verificationUri: "https://swamp-club.com/device",
        expiresIn: 0.001,
        interval: 0.001,
      }),
    pollDeviceToken: () => Promise.reject(new DeviceAuthPendingError()),
  });
  const input = makeInput({ useBrowserFlow: true });

  const events = await collect<AuthLoginEvent>(
    authLogin(createLibSwampContext(), deps, input),
  );

  const last = events[events.length - 1];
  assertEquals(last.kind, "error");
  if (last.kind === "error") {
    assertEquals(last.error.message, "Device authorization timed out");
  }
});

Deno.test("authLogin: slow_down increases polling interval", async () => {
  let pollCount = 0;
  const deps = makeDeps({
    startDeviceAuth: () =>
      Promise.resolve({
        deviceCode: "device-abc-123",
        userCode: "ABCD-1234",
        verificationUri: "https://swamp-club.com/device",
        expiresIn: 900,
        interval: 0.001,
      }),
    pollDeviceToken: () => {
      pollCount++;
      if (pollCount === 1) {
        return Promise.reject(new DeviceAuthPendingError(true));
      }
      return Promise.resolve({ accessToken: "session-token-abc" });
    },
  });
  const input = makeInput({ useBrowserFlow: true });

  const events = await collect<AuthLoginEvent>(
    authLogin(createLibSwampContext(), deps, input),
  );

  const kinds = events.map((e) => e.kind);
  assertEquals(kinds, [
    "device_verification",
    "opening_browser",
    "polling",
    "polling",
    "securing_session",
    "completed",
  ]);
  assertEquals(pollCount, 2);
});
