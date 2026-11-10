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

import { assert, assertEquals } from "@std/assert";
import { type Span, trace } from "@opentelemetry/api";
import { waitFor } from "@swamp-club/swamp-testing";
import { withSpan } from "../infrastructure/tracing/mod.ts";
import { withCapturedSpans } from "../infrastructure/tracing/span_test_helpers.ts";
import {
  ClubHeartbeatService,
  DEFAULT_CLUB_HEARTBEAT_INTERVAL_MS,
} from "./club_heartbeat_service.ts";
import { InstanceNotRegisteredError } from "./oauth_client.ts";

Deno.test("DEFAULT_CLUB_HEARTBEAT_INTERVAL_MS: is 1 hour", () => {
  assertEquals(DEFAULT_CLUB_HEARTBEAT_INTERVAL_MS, 60 * 60 * 1000);
});

Deno.test("ClubHeartbeatService: stop is safe to call before start", () => {
  const service = new ClubHeartbeatService({
    providerUrl: "https://example.com",
    oauthClientId: "test-client",
    instanceId: "inst-test",
    reregister: () => Promise.resolve(),
    intervalMs: 1000,
    getAccessToken: () => Promise.resolve("token"),
    sendHeartbeat: () => Promise.resolve({ heartbeatCount: 1 }),
  });
  service.stop();
});

Deno.test("ClubHeartbeatService: start then stop does not leak timers", () => {
  const service = new ClubHeartbeatService({
    providerUrl: "https://example.com",
    oauthClientId: "test-client",
    instanceId: "inst-test",
    reregister: () => Promise.resolve(),
    intervalMs: 60_000,
    getAccessToken: () => Promise.resolve("token"),
    sendHeartbeat: () => Promise.resolve({ heartbeatCount: 1 }),
  });
  service.start();
  service.stop();
});

Deno.test("ClubHeartbeatService: double start is idempotent", () => {
  const service = new ClubHeartbeatService({
    providerUrl: "https://example.com",
    oauthClientId: "test-client",
    instanceId: "inst-test",
    reregister: () => Promise.resolve(),
    intervalMs: 60_000,
    getAccessToken: () => Promise.resolve("token"),
    sendHeartbeat: () => Promise.resolve({ heartbeatCount: 1 }),
  });
  service.start();
  service.start();
  service.stop();
});

Deno.test("ClubHeartbeatService: calls sendHeartbeat with correct arguments on tick", async () => {
  const calls: { providerUrl: string; token: string; clientId: string }[] = [];
  const service = new ClubHeartbeatService({
    providerUrl: "https://club.example.com",
    oauthClientId: "clt-test-456",
    instanceId: "inst-test",
    reregister: () => Promise.resolve(),
    intervalMs: 50,
    getAccessToken: () => Promise.resolve("my-secret-key"),
    sendHeartbeat: (providerUrl, token, clientId) => {
      calls.push({ providerUrl, token, clientId });
      return Promise.resolve({ heartbeatCount: calls.length });
    },
  });
  service.start();
  await new Promise((r) => setTimeout(r, 120));
  service.stop();
  assertEquals(calls.length >= 1, true);
  assertEquals(calls[0].providerUrl, "https://club.example.com");
  assertEquals(calls[0].token, "my-secret-key");
  assertEquals(calls[0].clientId, "clt-test-456");
});

Deno.test("ClubHeartbeatService: skips beat when getAccessToken returns null", async () => {
  let heartbeatCalled = false;
  const service = new ClubHeartbeatService({
    providerUrl: "https://example.com",
    oauthClientId: "clt-test",
    instanceId: "inst-test",
    reregister: () => Promise.resolve(),
    intervalMs: 50,
    getAccessToken: () => Promise.resolve(null),
    sendHeartbeat: () => {
      heartbeatCalled = true;
      return Promise.resolve({ heartbeatCount: 1 });
    },
  });
  service.start();
  await new Promise((r) => setTimeout(r, 120));
  service.stop();
  assertEquals(heartbeatCalled, false);
});

Deno.test("ClubHeartbeatService: sendHeartbeat failure does not stop the service", async () => {
  let callCount = 0;
  const service = new ClubHeartbeatService({
    providerUrl: "https://example.com",
    oauthClientId: "clt-test",
    instanceId: "inst-test",
    reregister: () => Promise.resolve(),
    intervalMs: 50,
    getAccessToken: () => Promise.resolve("tok"),
    sendHeartbeat: () => {
      callCount++;
      if (callCount === 1) throw new Error("network error");
      return Promise.resolve({ heartbeatCount: callCount });
    },
  });
  service.start();
  try {
    await waitFor(
      () => callCount >= 2,
      "heartbeat retries after a failed tick",
    );
  } finally {
    service.stop();
  }
  assertEquals(callCount >= 2, true);
});

Deno.test("ClubHeartbeatService: a tick runs with no active span when started under one", async () => {
  await withCapturedSpans(async () => {
    const seen: (Span | undefined)[] = [];
    const service = new ClubHeartbeatService({
      providerUrl: "https://example.com",
      oauthClientId: "clt-test",
      instanceId: "inst-test",
      reregister: () => Promise.resolve(),
      intervalMs: 10,
      getAccessToken: () => Promise.resolve("tok"),
      sendHeartbeat: () => {
        seen.push(trace.getActiveSpan());
        return Promise.resolve({ heartbeatCount: seen.length });
      },
    });
    await withSpan("swamp.cli", {}, async () => {
      service.start();
      try {
        await waitFor(() => seen.length >= 2, "two heartbeat ticks");
      } finally {
        service.stop();
      }
    });
    assert(seen.length >= 2);
    for (const span of seen) assertEquals(span, undefined);
  });
});

Deno.test("ClubHeartbeatService: sends the instanceId with every heartbeat", async () => {
  const instanceIds: string[] = [];
  const service = new ClubHeartbeatService({
    providerUrl: "https://example.com",
    oauthClientId: "clt-test",
    instanceId: "inst-abc",
    intervalMs: 10,
    getAccessToken: () => Promise.resolve("tok"),
    sendHeartbeat: (_url, _token, _clientId, instanceId) => {
      instanceIds.push(instanceId);
      return Promise.resolve({ heartbeatCount: instanceIds.length });
    },
    reregister: () => Promise.resolve(),
  });
  service.start();
  try {
    await waitFor(() => instanceIds.length >= 2, "two heartbeat ticks");
  } finally {
    service.stop();
  }
  for (const id of instanceIds) assertEquals(id, "inst-abc");
});

Deno.test("ClubHeartbeatService: a 404 re-registers once and sends no second heartbeat in that beat", async () => {
  const events: string[] = [];
  const service = new ClubHeartbeatService({
    providerUrl: "https://example.com",
    oauthClientId: "clt-test",
    instanceId: "inst-abc",
    intervalMs: 10,
    getAccessToken: () => Promise.resolve("tok"),
    sendHeartbeat: () => {
      events.push("heartbeat");
      if (events.length === 1) {
        return Promise.reject(
          new InstanceNotRegisteredError("Instance heartbeat failed: 404"),
        );
      }
      return Promise.resolve({ heartbeatCount: 1 });
    },
    reregister: (token) => {
      events.push(`register:${token}`);
      return Promise.resolve();
    },
  });
  service.start();
  try {
    await waitFor(() => events.length >= 3, "the beat after the 404");
  } finally {
    service.stop();
  }
  assertEquals(events.slice(0, 3), [
    "heartbeat",
    "register:tok",
    "heartbeat",
  ]);
  assertEquals(events.filter((e) => e.startsWith("register")).length, 1);
});

Deno.test("ClubHeartbeatService: a failed re-registration is not retried until the next beat", async () => {
  const events: string[] = [];
  const service = new ClubHeartbeatService({
    providerUrl: "https://example.com",
    oauthClientId: "clt-test",
    instanceId: "inst-abc",
    intervalMs: 10,
    getAccessToken: () => Promise.resolve("tok"),
    sendHeartbeat: () => {
      events.push("heartbeat");
      return Promise.reject(
        new InstanceNotRegisteredError("Instance heartbeat failed: 404"),
      );
    },
    reregister: () => {
      events.push("register");
      return Promise.reject(new Error("Instance registration failed: 422"));
    },
  });
  service.start();
  try {
    await waitFor(() => events.length >= 4, "two beats");
  } finally {
    service.stop();
  }
  assertEquals(events.slice(0, 4), [
    "heartbeat",
    "register",
    "heartbeat",
    "register",
  ]);
});

Deno.test("ClubHeartbeatService: a non-404 failure never re-registers", async () => {
  let heartbeats = 0;
  let registrations = 0;
  const service = new ClubHeartbeatService({
    providerUrl: "https://example.com",
    oauthClientId: "clt-test",
    instanceId: "inst-abc",
    intervalMs: 10,
    getAccessToken: () => Promise.resolve("tok"),
    sendHeartbeat: () => {
      heartbeats++;
      return Promise.reject(new Error("Instance heartbeat failed: 500"));
    },
    reregister: () => {
      registrations++;
      return Promise.resolve();
    },
  });
  service.start();
  try {
    await waitFor(() => heartbeats >= 2, "two failed beats");
  } finally {
    service.stop();
  }
  assertEquals(registrations, 0);
});

Deno.test("ClubHeartbeatService: stop aborts a heartbeat in flight", async () => {
  let signal: AbortSignal | undefined;
  const service = new ClubHeartbeatService({
    providerUrl: "https://example.com",
    oauthClientId: "clt-test",
    instanceId: "inst-abc",
    intervalMs: 10,
    getAccessToken: () => Promise.resolve("tok"),
    sendHeartbeat: (_url, _token, _clientId, _instanceId, s) => {
      signal ??= s;
      return new Promise((_, reject) => {
        s.addEventListener("abort", () => reject(s.reason), { once: true });
      });
    },
    reregister: () => Promise.resolve(),
  });
  service.start();
  try {
    await waitFor(() => signal !== undefined, "a heartbeat in flight");
  } finally {
    service.stop();
  }
  assertEquals(signal?.aborted, true);
});
