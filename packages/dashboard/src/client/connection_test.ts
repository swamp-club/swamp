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
import {
  type AuthInfo,
  type ConnectionDeps,
  createConnection,
  loadAuthInfo,
  parseAuthInfo,
  requestAuthInfo,
  requestTokenProbe,
  type SocketHandlers,
  type Timers,
} from "./connection.ts";
import type { ProbeResult } from "./reconnect.ts";

// Fake timers tell check timeouts from retries by this duration. Retries are
// capped at MAX_DELAY_MS (30s), so no retry can ever share it.
const CHECK_TIMEOUT = 99_999;

class FakeSocket {
  closed = false;
  constructor(
    readonly protocols: string[] | undefined,
    readonly handlers: SocketHandlers,
  ) {}
  close() {
    this.closed = true;
  }
}

/** A timer queue the test advances by hand. */
function fakeTimers() {
  let nextId = 1;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const api: Timers = {
    setTimer(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
  };
  const find = (timeout: boolean) =>
    [...timers].filter(([, t]) => (t.ms === CHECK_TIMEOUT) === timeout);
  return {
    api,
    /** Delays of pending retry timers. */
    retries: () => find(false).map(([, t]) => t.ms),
    /** Number of pending check timeouts. */
    checkTimeouts: () => find(true).length,
    fireRetry() {
      const [[id, timer]] = find(false);
      timers.delete(id);
      timer.fn();
    },
    fireCheckTimeout() {
      const [[id, timer]] = find(true);
      timers.delete(id);
      timer.fn();
    },
  };
}

async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

interface Pending<T> {
  arg: string | null;
  signal: AbortSignal;
  reply: (value: T) => void;
}

function harness(overrides: Partial<ConnectionDeps<FakeSocket>> = {}) {
  const timers = fakeTimers();
  const sockets: FakeSocket[] = [];
  const events: string[] = [];
  const probes: Pending<ProbeResult>[] = [];
  const authChecks: Pending<AuthInfo | null>[] = [];
  const connection = createConnection<FakeSocket>({
    ...timers.api,
    random: () => 1,
    checkTimeoutMs: CHECK_TIMEOUT,
    createSocket: (protocols, handlers) => {
      const socket = new FakeSocket(protocols, handlers);
      sockets.push(socket);
      return socket;
    },
    probe: (token, signal) =>
      new Promise((reply) => probes.push({ arg: token, signal, reply })),
    fetchAuthInfo: (signal) =>
      new Promise((reply) => authChecks.push({ arg: null, signal, reply })),
    onOpen: (socket) => events.push(`open:${sockets.indexOf(socket)}`),
    onMessage: (socket, text) =>
      events.push(`message:${sockets.indexOf(socket)}:${text}`),
    onDisconnect: () => events.push("disconnect"),
    onReauth: () => events.push("reauth"),
    onAuthModeChanged: (info) => events.push(`mode:${info.mode}`),
    ...overrides,
  });
  const latest = () => sockets[sockets.length - 1];
  return { connection, timers, sockets, events, probes, authChecks, latest };
}

Deno.test("createConnection: a close after open schedules one retry and reconnects", () => {
  const h = harness();
  h.connection.start({ token: null, authMode: "none" });
  h.latest().handlers.onOpen();
  h.latest().handlers.onMessage("hi");
  h.latest().handlers.onClose(1006);
  assertEquals(h.events, ["open:0", "message:0:hi", "disconnect"]);
  assertEquals(h.timers.retries(), [500]);
  h.timers.fireRetry();
  assertEquals(h.sockets.length, 2);
  h.latest().handlers.onOpen();
  assertEquals(h.events[h.events.length - 1], "open:1");
});

Deno.test("createConnection: presents the token as a bearer subprotocol", () => {
  const h = harness();
  h.connection.start({ token: "abc", authMode: "token" });
  assertEquals(h.latest().protocols, ["bearer.abc"]);
});

Deno.test("createConnection: delays grow while failing and reset after an open", () => {
  const h = harness();
  h.connection.start({ token: "t", authMode: "token" });
  h.latest().handlers.onOpen();
  h.latest().handlers.onClose(1001);
  assertEquals(h.timers.retries(), [500]);
  h.timers.fireRetry();
  h.latest().handlers.onOpen();
  h.latest().handlers.onClose(1001);
  // The open in between reset the backoff.
  assertEquals(h.timers.retries(), [500]);
  h.timers.fireRetry();
  h.latest().handlers.onOpen();
  h.latest().handlers.onClose(4002);
  assertEquals(h.timers.retries(), [500]);
});

Deno.test("createConnection: backoff grows across failed reconnects", async () => {
  const h = harness();
  h.connection.start({ token: "t", authMode: "token" });
  h.latest().handlers.onOpen();
  h.latest().handlers.onClose(1006);
  const delays = [...h.timers.retries()];
  for (let i = 0; i < 3; i++) {
    h.timers.fireRetry();
    h.latest().handlers.onClose(1006);
    h.probes[h.probes.length - 1].reply("network-error");
    await settle();
    delays.push(...h.timers.retries());
  }
  assertEquals(delays, [500, 1000, 2000, 4000]);
});

Deno.test("createConnection: a revoked principal reauths once and stops", async () => {
  const h = harness();
  h.connection.start({ token: "t", authMode: "token" });
  h.latest().handlers.onOpen();
  h.latest().handlers.onClose(4003);
  // The auth mode is re-read before going to login.
  assertEquals(h.authChecks.length, 1);
  h.authChecks[0].reply({ mode: "token" });
  await settle();
  assertEquals(h.events, ["open:0", "disconnect", "reauth"]);
  assertEquals(h.timers.retries(), []);
  assertEquals(h.timers.checkTimeouts(), 0);
  assertEquals(h.sockets.length, 1);
});

Deno.test("createConnection: reauth reports a changed token-based mode first", async () => {
  const h = harness();
  h.connection.start({ token: "t", authMode: "token" });
  h.latest().handlers.onClose(1006);
  h.probes[0].reply(401);
  await settle();
  h.authChecks[0].reply({ mode: "oauth", verificationBaseUri: "https://x" });
  await settle();
  assertEquals(h.events, ["disconnect", "mode:oauth", "reauth"]);
  assertEquals(h.timers.retries(), []);
});

Deno.test("createConnection: reauth still happens when the auth mode cannot be read", () => {
  const h = harness();
  h.connection.start({ token: "t", authMode: "token" });
  h.latest().handlers.onOpen();
  h.latest().handlers.onClose(4003);
  h.timers.fireCheckTimeout();
  assertEquals(h.authChecks[0].signal.aborted, true);
  assertEquals(h.events, ["open:0", "disconnect", "reauth"]);
  assertEquals(h.timers.retries(), []);
});

Deno.test("createConnection: stop during the reauth mode check cancels it", async () => {
  const h = harness();
  h.connection.start({ token: "t", authMode: "token" });
  h.latest().handlers.onOpen();
  h.latest().handlers.onClose(4003);
  h.connection.stop();
  h.authChecks[0].reply({ mode: "oauth" });
  await settle();
  assertEquals(h.events, ["open:0", "disconnect"]);
});

Deno.test("createConnection: a failed upgrade with a token probes it", async () => {
  for (
    const [result, expected] of [
      [401, "reauth"],
      [403, "retry"],
      [429, "retry"],
      [200, "retry"],
      ["network-error", "retry"],
    ] as const
  ) {
    const h = harness();
    h.connection.start({ token: "t", authMode: "token" });
    h.latest().handlers.onClose(1006);
    assertEquals(h.probes.map((p) => p.arg), ["t"]);
    assertEquals(h.timers.retries(), []);
    h.probes[0].reply(result);
    await settle();
    if (expected === "reauth") {
      h.authChecks[0].reply({ mode: "token" });
      await settle();
    }
    assertEquals(
      h.events.includes("reauth"),
      expected === "reauth",
      `${result}`,
    );
    assertEquals(h.timers.retries().length, expected === "retry" ? 1 : 0);
    assertEquals(h.timers.checkTimeouts(), 0);
  }
});

Deno.test("createConnection: a probe that never answers times out and retries", async () => {
  const h = harness();
  h.connection.start({ token: "t", authMode: "token" });
  h.latest().handlers.onClose(1006);
  h.timers.fireCheckTimeout();
  assertEquals(h.probes[0].signal.aborted, true);
  assertEquals(h.timers.retries(), [500]);
  // A reply after the timeout is ignored.
  h.probes[0].reply(401);
  await settle();
  assertEquals(h.events.includes("reauth"), false);
});

Deno.test("createConnection: a failed upgrade without a token re-checks the auth mode", async () => {
  const h = harness();
  h.connection.start({ token: null, authMode: "none" });
  h.latest().handlers.onClose(1006);
  assertEquals(h.probes.length, 0);
  assertEquals(h.authChecks.length, 1);
  h.authChecks[0].reply({ mode: "none" });
  await settle();
  assertEquals(h.timers.retries(), [500]);
  assertEquals(h.events, ["disconnect"]);
});

Deno.test("createConnection: serve back in a different auth mode stops with the new mode", async () => {
  const h = harness();
  h.connection.start({ token: null, authMode: "none" });
  h.latest().handlers.onClose(1006);
  h.authChecks[0].reply({ mode: "token" });
  await settle();
  assertEquals(h.events, ["disconnect", "mode:token"]);
  assertEquals(h.timers.retries(), []);
});

Deno.test("createConnection: an unreachable auth check retries", async () => {
  const h = harness();
  h.connection.start({ token: null, authMode: "none" });
  h.latest().handlers.onClose(1006);
  h.authChecks[0].reply(null);
  await settle();
  assertEquals(h.timers.retries(), [500]);
});

Deno.test("createConnection: a superseded socket's events are ignored", () => {
  const h = harness();
  h.connection.start({ token: "old", authMode: "token" });
  const old = h.latest();
  old.handlers.onOpen();
  h.connection.start({ token: "new", authMode: "token" });
  assertEquals(old.closed, true);
  old.handlers.onMessage("late");
  old.handlers.onClose(1000);
  assertEquals(h.events, ["open:0", "disconnect"]);
  assertEquals(h.timers.retries(), []);
  assertEquals(h.latest().protocols, ["bearer.new"]);
});

Deno.test("createConnection: stop closes a connecting socket without retrying", () => {
  const h = harness();
  h.connection.start({ token: null, authMode: "none" });
  const socket = h.latest();
  h.connection.stop();
  assertEquals(socket.closed, true);
  socket.handlers.onClose(1006);
  assertEquals(h.events, []);
  assertEquals(h.timers.retries(), []);
  assertEquals(h.authChecks.length, 0);
});

Deno.test("createConnection: stop on an open socket reports the disconnect once", () => {
  const h = harness();
  h.connection.start({ token: "t", authMode: "token" });
  const socket = h.latest();
  socket.handlers.onOpen();
  h.connection.stop();
  assertEquals(socket.closed, true);
  // The socket's own close arrives later and is stale.
  socket.handlers.onClose(1000);
  assertEquals(h.events, ["open:0", "disconnect"]);
  assertEquals(h.timers.retries(), []);
  h.connection.stop();
  assertEquals(h.events, ["open:0", "disconnect"]);
});

Deno.test("createConnection: restarting an open connection reports the disconnect first", () => {
  const h = harness();
  h.connection.start({ token: "old", authMode: "token" });
  h.latest().handlers.onOpen();
  h.connection.start({ token: "new", authMode: "token" });
  h.latest().handlers.onOpen();
  assertEquals(h.events, ["open:0", "disconnect", "open:1"]);
});

Deno.test("createConnection: stop cancels a pending retry", () => {
  const h = harness();
  h.connection.start({ token: null, authMode: "none" });
  h.latest().handlers.onOpen();
  h.latest().handlers.onClose(1006);
  assertEquals(h.timers.retries(), [500]);
  h.connection.stop();
  assertEquals(h.timers.retries(), []);
  assertEquals(h.sockets.length, 1);
});

Deno.test("createConnection: stop aborts an in-flight probe and ignores its reply", async () => {
  const h = harness();
  h.connection.start({ token: "t", authMode: "token" });
  h.latest().handlers.onClose(1006);
  h.connection.stop();
  assertEquals(h.probes[0].signal.aborted, true);
  assertEquals(h.timers.checkTimeouts(), 0);
  h.probes[0].reply(401);
  await settle();
  assertEquals(h.events, ["disconnect"]);
});

Deno.test("createConnection: start after stop connects again", () => {
  const h = harness();
  h.connection.start({ token: null, authMode: "none" });
  h.connection.stop();
  h.connection.start({ token: null, authMode: "none" });
  h.latest().handlers.onOpen();
  assertEquals(h.events, ["open:1"]);
});

Deno.test("parseAuthInfo: accepts known modes only", () => {
  assertEquals(parseAuthInfo({ mode: "token" }), { mode: "token" });
  assertEquals(
    parseAuthInfo({ mode: "oauth", verificationBaseUri: "https://x" }),
    { mode: "oauth", verificationBaseUri: "https://x" },
  );
  assertEquals(parseAuthInfo({ mode: "magic" }), null);
  assertEquals(parseAuthInfo(null), null);
  assertEquals(parseAuthInfo("none"), null);
});

Deno.test("requestAuthInfo: returns null for errors and unusable answers", async () => {
  const signal = new AbortController().signal;
  const reply = (body: string, status = 200) => () =>
    Promise.resolve(new Response(body, { status }));
  assertEquals(
    await requestAuthInfo(reply('{"mode":"none"}'), signal),
    { mode: "none" },
  );
  assertEquals(await requestAuthInfo(reply("oops", 503), signal), null);
  assertEquals(await requestAuthInfo(reply("<html>"), signal), null);
  assertEquals(
    await requestAuthInfo(() => Promise.reject(new TypeError("down")), signal),
    null,
  );
});

Deno.test("requestTokenProbe: sends the token and reports the status", async () => {
  const signal = new AbortController().signal;
  let seen: RequestInit | undefined;
  const status = await requestTokenProbe(
    (url, init) => {
      seen = init;
      assertEquals(url, "/api/v1/health");
      return Promise.resolve(new Response("no", { status: 401 }));
    },
    "abc",
    signal,
  );
  assertEquals(status, 401);
  assertEquals(seen?.headers, { Authorization: "Bearer abc" });
  assertEquals(seen?.signal, signal);
  assertEquals(
    await requestTokenProbe(
      () => Promise.reject(new TypeError("down")),
      "abc",
      signal,
    ),
    "network-error",
  );
});

function authLoader() {
  const timers = fakeTimers();
  const requests: Pending<AuthInfo | null>[] = [];
  const loaded: AuthInfo[] = [];
  const cancel = loadAuthInfo({
    ...timers.api,
    random: () => 1,
    checkTimeoutMs: CHECK_TIMEOUT,
    fetchAuthInfo: (signal) =>
      new Promise((reply) => requests.push({ arg: null, signal, reply })),
  }, (info) => loaded.push(info));
  return { timers, requests, loaded, cancel };
}

Deno.test("loadAuthInfo: retries with backoff until serve answers", async () => {
  const l = authLoader();
  l.requests[0].reply(null);
  await settle();
  assertEquals(l.timers.retries(), [500]);
  l.timers.fireRetry();
  l.requests[1].reply(null);
  await settle();
  assertEquals(l.timers.retries(), [1000]);
  l.timers.fireRetry();
  l.requests[2].reply({ mode: "token" });
  await settle();
  assertEquals(l.loaded, [{ mode: "token" }]);
  assertEquals(l.timers.retries(), []);
});

Deno.test("loadAuthInfo: a request that never answers times out and retries", () => {
  const l = authLoader();
  l.timers.fireCheckTimeout();
  assertEquals(l.requests[0].signal.aborted, true);
  assertEquals(l.timers.retries(), [500]);
});

Deno.test("loadAuthInfo: cancel stops further attempts", async () => {
  const l = authLoader();
  l.requests[0].reply(null);
  await settle();
  l.cancel();
  assertEquals(l.timers.retries(), []);
  const inFlight = authLoader();
  inFlight.cancel();
  assertEquals(inFlight.requests[0].signal.aborted, true);
  inFlight.requests[0].reply({ mode: "none" });
  await settle();
  assertEquals(inFlight.loaded, []);
});
