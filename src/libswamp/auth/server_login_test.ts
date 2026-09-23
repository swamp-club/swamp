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

import {
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { withMockedFetch } from "@swamp-club/swamp-testing";
import {
  createServerLoginDeps,
  DeviceAuthPendingError,
  serverLogin,
  type ServerLoginDeps,
  type ServerLoginEvent,
  type ServerLoginInput,
} from "./server_login.ts";
import { UserError } from "../../domain/errors.ts";
import { normalizeServerUrl } from "../../domain/auth/server_url.ts";

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

Deno.test("serverLogin: credentials in the input URL never reach the server calls", async () => {
  const seen: string[] = [];
  const deps = makeDeps({
    discoverAuthMode: (serverUrl) => {
      seen.push(serverUrl);
      return Promise.resolve({
        mode: "oauth",
        verificationBaseUri: "https://swamp-club.com",
      });
    },
    startDeviceAuth: (serverUrl, signal) => {
      seen.push(serverUrl);
      return makeDeps().startDeviceAuth(serverUrl, signal);
    },
    normalizeServerUrl,
  });
  const input = makeInput({
    serverUrl: "wss://alice:hunter2@serve.example.com/?token=abc.s3cret#frag",
  });

  await collect(serverLogin(deps, input));

  assertEquals(seen, [
    "https://serve.example.com",
    "https://serve.example.com",
  ]);
});

function timeoutError(): DOMException {
  return new DOMException("Signal timed out.", "TimeoutError");
}

function lastError(events: ServerLoginEvent[]): Error {
  const last = events[events.length - 1];
  if (last.kind !== "error") {
    throw new Error(`expected a final error event, got ${last.kind}`);
  }
  return last.error;
}

Deno.test("serverLogin: a timeout between polls yields a UserError to run the login again", async () => {
  const controller = new AbortController();
  const deps = makeDeps({
    pollDeviceToken: () => {
      controller.abort(timeoutError());
      return Promise.reject(new DeviceAuthPendingError());
    },
  });

  const events = await collect(
    serverLogin(deps, makeInput({ signal: controller.signal })),
  );

  const error = lastError(events);
  assertInstanceOf(error, UserError);
  assertStringIncludes(error.message, "swamp auth server-login");
});

Deno.test("serverLogin: a token poll that times out yields a UserError to run the login again", async () => {
  const controller = new AbortController();
  const deps = makeDeps({
    pollDeviceToken: () => {
      controller.abort(timeoutError());
      return Promise.reject(controller.signal.reason);
    },
  });

  const events = await collect(
    serverLogin(deps, makeInput({ signal: controller.signal })),
  );

  const error = lastError(events);
  assertInstanceOf(error, UserError);
  assertStringIncludes(error.message, "swamp auth server-login");
});

Deno.test("serverLogin: a timeout before the code is issued names the server", async () => {
  const controller = new AbortController();
  const deps = makeDeps({
    discoverAuthMode: () => {
      controller.abort(timeoutError());
      return Promise.reject(controller.signal.reason);
    },
  });

  const events = await collect(
    serverLogin(deps, makeInput({ signal: controller.signal })),
  );

  const error = lastError(events);
  assertInstanceOf(error, UserError);
  assertStringIncludes(error.message, "https://swamp.acme.internal:9090");
  assertEquals(events.some((e) => e.kind === "device_verification"), false);
});

Deno.test("serverLogin: a cancelled signal is passed through unchanged", async () => {
  const controller = new AbortController();
  const deps = makeDeps({
    pollDeviceToken: () => {
      controller.abort();
      return Promise.reject(controller.signal.reason);
    },
  });

  const events = await collect(
    serverLogin(deps, makeInput({ signal: controller.signal })),
  );

  const error = lastError(events);
  assertInstanceOf(error, DOMException);
  assertEquals(error.name, "AbortError");
});

Deno.test("serverLogin: an expired device code times out without polling", async () => {
  let polls = 0;
  const deps = makeDeps({
    startDeviceAuth: () =>
      Promise.resolve({
        deviceCode: "device-abc-123",
        userCode: "ABCD-1234",
        verificationUri: "https://swamp-club.com/device",
        expiresIn: 0,
        interval: 0.001,
      }),
    pollDeviceToken: () => {
      polls++;
      return Promise.reject(new DeviceAuthPendingError());
    },
  });

  const events = await collect(serverLogin(deps, makeInput()));

  assertEquals(polls, 0);
  const error = lastError(events);
  assertInstanceOf(error, UserError);
  assertStringIncludes(error.message, "swamp auth server-login");
});

const SERVE_URL = "http://serve.test:9090";

/** Calls each serve endpoint through the production deps. */
function callEndpoint(
  endpoint: "info" | "device" | "token",
  signal: AbortSignal,
): Promise<unknown> {
  const deps = createServerLoginDeps();
  switch (endpoint) {
    case "info":
      return deps.discoverAuthMode(SERVE_URL, signal);
    case "device":
      return deps.startDeviceAuth(SERVE_URL, signal);
    case "token":
      return deps.pollDeviceToken(SERVE_URL, "device-abc-123", signal);
  }
}

const ENDPOINTS = [
  { endpoint: "info", label: "GET /auth/info" },
  { endpoint: "device", label: "POST /auth/device" },
  { endpoint: "token", label: "POST /auth/device/token" },
] as const;

Deno.test("createServerLoginDeps: a failed request names the server and endpoint and keeps the cause", async () => {
  for (const { endpoint, label } of ENDPOINTS) {
    await withMockedFetch(() => {
      // Deno's fetch reports the reason in `cause`, not in the message.
      throw new TypeError("fetch failed", {
        cause: new Error(
          "error sending request: invalid peer certificate: UnknownIssuer",
        ),
      });
    }, async () => {
      const err = await assertRejects(
        () => callEndpoint(endpoint, new AbortController().signal),
        UserError,
      );
      assertStringIncludes(err.message, SERVE_URL);
      assertStringIncludes(err.message, label);
      assertStringIncludes(err.message, "invalid peer certificate");
    });
  }
});

Deno.test("createServerLoginDeps: a response that is not JSON names the server and endpoint", async () => {
  for (const { endpoint, label } of ENDPOINTS) {
    await withMockedFetch(
      () =>
        new Response("<html>Sign in</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      async () => {
        const err = await assertRejects(
          () => callEndpoint(endpoint, new AbortController().signal),
          UserError,
        );
        assertStringIncludes(err.message, SERVE_URL);
        assertStringIncludes(err.message, label);
        assertStringIncludes(err.message, "not JSON");
      },
    );
  }
});

Deno.test("createServerLoginDeps: an aborted request is not wrapped", async () => {
  const controller = new AbortController();
  controller.abort(timeoutError());
  await withMockedFetch(() => {
    throw controller.signal.reason;
  }, async () => {
    const err = await assertRejects(
      () => callEndpoint("token", controller.signal),
      DOMException,
    );
    assertEquals(err.name, "TimeoutError");
  });
});
