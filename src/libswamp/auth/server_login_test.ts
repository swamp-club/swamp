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

import { assertEquals, assertRejects } from "@std/assert";
import {
  DeviceAuthPendingError,
  serverLogin,
  type ServerLoginDeps,
  type ServerLoginEvent,
  type ServerLoginInput,
} from "./server_login.ts";
import { UserError } from "../../domain/errors.ts";

function makeDeps(overrides: Partial<ServerLoginDeps> = {}): ServerLoginDeps {
  return {
    discoverAuthMode: () =>
      Promise.resolve({
        mode: "oauth",
        verificationBaseUri: "https://swamp-club.com",
      }),
    startDeviceAuth: () =>
      Promise.resolve({
        deviceCode: "device-abc-123",
        userCode: "ABCD-1234",
        verificationUri: "https://swamp-club.com/device",
        verificationUriComplete: "https://swamp-club.com/device?code=ABCD-1234",
        expiresIn: 900,
        interval: 0.001,
      }),
    pollDeviceToken: () =>
      Promise.resolve({
        token: "oauth-token-xyz",
        principal: {
          id: "user:alice",
          email: "alice@example.com",
          name: "Alice",
          collectives: ["acme-corp"],
        },
      }),
    openBrowser: () => Promise.resolve(true),
    saveCredential: () => Promise.resolve(),
    normalizeServerUrl: (url: string) => url.replace(/\/+$/, ""),
    ...overrides,
  };
}

function makeInput(
  overrides: Partial<ServerLoginInput> = {},
): ServerLoginInput {
  return {
    serverUrl: "https://swamp.acme.internal:9090",
    ...overrides,
  };
}

async function collect(
  stream: AsyncIterable<ServerLoginEvent>,
): Promise<ServerLoginEvent[]> {
  const events: ServerLoginEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

Deno.test("serverLogin: happy path emits correct event sequence", async () => {
  let savedCredential: Record<string, unknown> | null = null;
  const deps = makeDeps({
    saveCredential: (cred) => {
      savedCredential = cred as unknown as Record<string, unknown>;
      return Promise.resolve();
    },
  });
  const input = makeInput();

  const events = await collect(serverLogin(deps, input));
  const kinds = events.map((e) => e.kind);

  assertEquals(kinds, [
    "discovering",
    "device_verification",
    "opening_browser",
    "polling",
    "completed",
  ]);

  const deviceEvent = events[1] as Extract<
    ServerLoginEvent,
    { kind: "device_verification" }
  >;
  assertEquals(deviceEvent.userCode, "ABCD-1234");
  assertEquals(deviceEvent.verificationUri, "https://swamp-club.com/device");
  assertEquals(
    deviceEvent.verificationUriComplete,
    "https://swamp-club.com/device?code=ABCD-1234",
  );

  const completed = events[4] as Extract<
    ServerLoginEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.token, "oauth-token-xyz");
  assertEquals(completed.data.principalId, "user:alice");
  assertEquals(completed.data.principalEmail, "alice@example.com");
  assertEquals(completed.data.displayName, "Alice");
  assertEquals(completed.data.collectives, ["acme-corp"]);

  assertEquals(savedCredential !== null, true);
  const cred = savedCredential as unknown as Record<string, unknown>;
  assertEquals(cred.token, "oauth-token-xyz");
  assertEquals(cred.principalId, "user:alice");
});

Deno.test("serverLogin: non-oauth server mode throws UserError", async () => {
  const deps = makeDeps({
    discoverAuthMode: () => Promise.resolve({ mode: "token" }),
  });
  const input = makeInput();

  await assertRejects(
    async () => {
      await collect(serverLogin(deps, input));
    },
    UserError,
    "Server does not support OAuth login (mode: token)",
  );
});

Deno.test("serverLogin: browser open failure still completes", async () => {
  const deps = makeDeps({
    openBrowser: () => Promise.resolve(false),
  });
  const input = makeInput();

  const events = await collect(serverLogin(deps, input));
  const kinds = events.map((e) => e.kind);

  assertEquals(kinds, [
    "discovering",
    "device_verification",
    "opening_browser",
    "browser_open_failed",
    "polling",
    "completed",
  ]);

  const failedEvent = events[3] as Extract<
    ServerLoginEvent,
    { kind: "browser_open_failed" }
  >;
  assertEquals(
    failedEvent.message.includes("Could not open browser"),
    true,
  );
});

Deno.test("serverLogin: retries polling on pending status", async () => {
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
      if (pollCount < 3) {
        return Promise.reject(new DeviceAuthPendingError());
      }
      return Promise.resolve({
        token: "oauth-token-xyz",
        principal: {
          id: "user:alice",
          email: "alice@example.com",
          name: "Alice",
          collectives: ["acme-corp"],
        },
      });
    },
  });
  const input = makeInput();

  const events = await collect(serverLogin(deps, input));
  const kinds = events.map((e) => e.kind);

  assertEquals(kinds, [
    "discovering",
    "device_verification",
    "opening_browser",
    "polling",
    "polling",
    "polling",
    "completed",
  ]);
  assertEquals(pollCount, 3);
});

Deno.test("serverLogin: yields error on poll failure", async () => {
  const deps = makeDeps({
    pollDeviceToken: () =>
      Promise.reject(
        new UserError("Device authorization failed: access_denied"),
      ),
  });
  const input = makeInput();

  const events = await collect(serverLogin(deps, input));
  const kinds = events.map((e) => e.kind);

  assertEquals(kinds, [
    "discovering",
    "device_verification",
    "opening_browser",
    "polling",
    "error",
  ]);

  const errorEvent = events[4] as Extract<
    ServerLoginEvent,
    { kind: "error" }
  >;
  assertEquals(
    errorEvent.error.message.includes("Device authorization failed"),
    true,
  );
});

Deno.test("serverLogin: normalizes server URL before use", async () => {
  let discoveredUrl = "";
  const deps = makeDeps({
    discoverAuthMode: (serverUrl) => {
      discoveredUrl = serverUrl;
      return Promise.resolve({
        mode: "oauth",
        verificationBaseUri: "https://swamp-club.com",
      });
    },
    normalizeServerUrl: (url: string) => url.replace(/\/+$/, "").toLowerCase(),
  });
  const input = makeInput({ serverUrl: "wss://Swamp.Acme.Internal:9090/" });

  await collect(serverLogin(deps, input));

  assertEquals(discoveredUrl, "https://swamp.acme.internal:9090");
});
