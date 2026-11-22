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
import { waitFor } from "@swamp-club/swamp-testing";
import type { AuthInfo, SocketHandlers, Timers } from "./connection.ts";
import { HOST_LIST_INTERVAL_MS } from "./host_workspace_list.ts";
import { PRINCIPAL_REVOKED_CLOSE_CODE } from "./reconnect.ts";
import {
  type PageVisibility,
  type RootListView,
  type RootSessionEvent,
  startOwnConnectionReader,
  startRootWorkspaceReader,
} from "./root_workspace_reader.ts";

/** A timer queue the test fires by hand. */
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
  return {
    api,
    pending: () => [...timers.values()].map((t) => t.ms),
    fire() {
      const [[id, timer]] = timers;
      timers.delete(id);
      timer.fn();
    },
  };
}

function fakeVisibility(initially = true) {
  let visible = initially;
  const listeners = new Set<() => void>();
  const api: PageVisibility = {
    visible: () => visible,
    subscribe(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
  };
  return {
    api,
    set(next: boolean) {
      visible = next;
      for (const listener of listeners) listener();
    },
  };
}

class FakeSocket {
  sent: { type: string; id: string }[] = [];
  closed = false;
  constructor(readonly handlers: SocketHandlers) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  open() {
    this.handlers.onOpen();
  }
  reply(payload: unknown) {
    const { id } = this.sent[this.sent.length - 1];
    this.handlers.onMessage(
      JSON.stringify({ type: "workspace.list", id, payload }),
    );
  }
  refuse(code: string) {
    const { id } = this.sent[this.sent.length - 1];
    this.handlers.onMessage(
      JSON.stringify({ type: "error", id, error: { code, message: "no" } }),
    );
  }
  drop(code: number) {
    this.handlers.onClose(code);
  }
}

const LISTED = {
  data: {
    workspaces: [
      { name: "edge-dns", state: "ready" },
      { name: "cost", state: "stopped" },
    ],
  },
};

function harness(options: {
  info?: AuthInfo | null;
  signedIn?: boolean;
  visible?: boolean;
} = {}) {
  const timers = fakeTimers();
  const visibility = fakeVisibility(options.visible ?? true);
  const sockets: FakeSocket[] = [];
  const views: RootListView[] = [];
  const sessionListeners = new Set<(event: RootSessionEvent) => void>();
  const calls = { authInfo: 0, session: 0 };
  const state = {
    info: options.info === undefined
      ? { mode: "oauth" } as AuthInfo
      : options.info,
    signedIn: options.signedIn ?? true,
  };
  const reader = startRootWorkspaceReader({
    authInfo: () => {
      calls.authInfo++;
      return Promise.resolve(state.info);
    },
    sessionRestored: () => {
      calls.session++;
      return Promise.resolve(state.signedIn);
    },
    openSocket: (handlers) => {
      const socket = new FakeSocket(handlers);
      sockets.push(socket);
      return socket;
    },
    timers: timers.api,
    visibility: visibility.api,
    sessionEvents: (onEvent) => {
      sessionListeners.add(onEvent);
      return () => sessionListeners.delete(onEvent);
    },
    onChange: (view) => views.push(view),
  });
  return {
    reader,
    timers,
    visibility,
    sockets,
    views,
    calls,
    state,
    last: () => views[views.length - 1],
    broadcast(event: RootSessionEvent) {
      for (const listener of sessionListeners) listener(event);
    },
  };
}

Deno.test("startRootWorkspaceReader: signed in to the root, it opens one socket, reads workspace.list and keeps each name and state", async () => {
  const h = harness();
  await waitFor(() => h.sockets.length === 1, "h.sockets.length === 1");
  h.sockets[0].open();
  assertEquals(h.sockets[0].sent.map((m) => m.type), ["workspace.list"]);
  h.sockets[0].reply(LISTED);
  assertEquals(h.last(), {
    kind: "listed",
    workspaces: [
      { name: "edge-dns", state: "ready" },
      { name: "cost", state: "stopped" },
    ],
  });
  h.reader.stop();
  assertEquals(h.sockets[0].closed, true);
});

Deno.test("startRootWorkspaceReader: not signed in to the root, it shows sign-in and opens no socket, so the root is sent nothing it would refuse", async () => {
  const h = harness({ signedIn: false });
  await waitFor(() => h.views.length === 1, "h.views.length === 1");
  assertEquals(h.last(), { kind: "sign-in" });
  assertEquals(h.sockets.length, 0);
  assertEquals(h.timers.pending(), []);
  h.reader.stop();
});

Deno.test("startRootWorkspaceReader: a root in auth mode none is read without a session check", async () => {
  const h = harness({ info: { mode: "none" }, signedIn: false });
  await waitFor(() => h.sockets.length === 1, "h.sockets.length === 1");
  assertEquals(h.calls.session, 0);
  h.reader.stop();
});

Deno.test("startRootWorkspaceReader: reads again every interval over the same socket, so a resumed workspace changes state at the next read", async () => {
  const h = harness();
  await waitFor(() => h.sockets.length === 1, "h.sockets.length === 1");
  h.sockets[0].open();
  h.sockets[0].reply(LISTED);
  assertEquals(h.timers.pending(), [HOST_LIST_INTERVAL_MS]);
  h.timers.fire();
  assertEquals(h.sockets.length, 1);
  assertEquals(h.sockets[0].sent.length, 2);
  h.sockets[0].reply({
    data: { workspaces: [{ name: "cost", state: "ready" }] },
  });
  assertEquals(h.last(), {
    kind: "listed",
    workspaces: [{ name: "cost", state: "ready" }],
  });
  h.reader.stop();
});

Deno.test("startRootWorkspaceReader: a hidden tab closes the socket and reads nothing; coming back reads at once", async () => {
  const h = harness();
  await waitFor(() => h.sockets.length === 1, "h.sockets.length === 1");
  h.sockets[0].open();
  h.visibility.set(false);
  assertEquals(h.sockets[0].closed, true);
  assertEquals(h.timers.pending(), []);
  h.visibility.set(true);
  assertEquals(h.sockets.length, 2);
  h.sockets[1].open();
  assertEquals(h.sockets[1].sent.length, 1);
  h.reader.stop();
});

Deno.test("startRootWorkspaceReader: a tab hidden at load opens nothing until it is shown", async () => {
  const h = harness({ visible: false });
  await waitFor(() => h.calls.session === 1, "h.calls.session === 1");
  assertEquals(h.sockets.length, 0);
  h.visibility.set(true);
  assertEquals(h.sockets.length, 1);
  h.reader.stop();
});

Deno.test("startRootWorkspaceReader: a revoked principal's close turns the switcher to sign-in and opens nothing more", async () => {
  const h = harness();
  await waitFor(() => h.sockets.length === 1, "h.sockets.length === 1");
  h.sockets[0].open();
  h.sockets[0].drop(PRINCIPAL_REVOKED_CLOSE_CODE);
  assertEquals(h.last(), { kind: "sign-in" });
  h.timers.fire();
  assertEquals(h.sockets.length, 1);
  h.reader.stop();
});

Deno.test("startRootWorkspaceReader: a close before open asks the root's session once, and an ended session turns to sign-in", async () => {
  const h = harness();
  await waitFor(() => h.sockets.length === 1, "h.sockets.length === 1");
  h.state.signedIn = false;
  h.sockets[0].drop(1006);
  await waitFor(() => h.calls.session === 2, "h.calls.session === 2");
  await waitFor(
    () => h.last()?.kind === "sign-in",
    `h.last()?.kind === "sign-in"`,
  );
  h.timers.fire();
  assertEquals(h.sockets.length, 1);
  h.reader.stop();
});

Deno.test("startRootWorkspaceReader: a close before open with the session still held waits for the next tick to reopen", async () => {
  const h = harness();
  await waitFor(() => h.sockets.length === 1, "h.sockets.length === 1");
  h.sockets[0].drop(1006);
  await waitFor(() => h.calls.session === 2, "h.calls.session === 2");
  assertEquals(h.sockets.length, 1);
  h.timers.fire();
  assertEquals(h.sockets.length, 2);
  h.reader.stop();
});

Deno.test("startRootWorkspaceReader: a close after open reopens at the next tick without asking the root's session", async () => {
  const h = harness();
  await waitFor(() => h.sockets.length === 1, "h.sockets.length === 1");
  h.sockets[0].open();
  h.sockets[0].drop(1001);
  assertEquals(h.sockets.length, 1);
  h.timers.fire();
  assertEquals(h.sockets.length, 2);
  assertEquals(h.calls.session, 1);
  h.reader.stop();
});

Deno.test("startRootWorkspaceReader: a refused read shows the list as unread and keeps the socket", async () => {
  const h = harness();
  await waitFor(() => h.sockets.length === 1, "h.sockets.length === 1");
  h.sockets[0].open();
  h.sockets[0].refuse("not_a_host_root");
  assertEquals(h.last(), { kind: "listed", workspaces: null });
  assertEquals(h.sockets[0].closed, false);
  h.reader.stop();
});

Deno.test("startRootWorkspaceReader: a sign-in to the root in another tab fills the list, and a sign-out there closes the socket", async () => {
  const h = harness({ signedIn: false });
  await waitFor(
    () => h.last()?.kind === "sign-in",
    `h.last()?.kind === "sign-in"`,
  );
  h.state.signedIn = true;
  h.broadcast("reauthenticated");
  await waitFor(() => h.sockets.length === 1, "h.sockets.length === 1");
  h.sockets[0].open();
  h.sockets[0].reply(LISTED);
  assertEquals(h.last()?.kind, "listed");
  h.broadcast("logout");
  assertEquals(h.sockets[0].closed, true);
  assertEquals(h.last(), { kind: "sign-in" });
  h.reader.stop();
});

Deno.test("startRootWorkspaceReader: a root that does not answer /auth/info shows the list as unread and asks again after the interval", async () => {
  const h = harness({ info: null });
  await waitFor(() => h.views.length === 1, "h.views.length === 1");
  assertEquals(h.last(), { kind: "listed", workspaces: null });
  assertEquals(h.timers.pending(), [HOST_LIST_INTERVAL_MS]);
  h.state.info = { mode: "oauth" };
  h.timers.fire();
  await waitFor(() => h.sockets.length === 1, "h.sockets.length === 1");
  h.reader.stop();
});

Deno.test("startOwnConnectionReader: the root page reads over its own connection each interval, and a failed read shows the list as unread", async () => {
  const timers = fakeTimers();
  const visibility = fakeVisibility();
  const views: RootListView[] = [];
  let fail = false;
  let reads = 0;
  const reader = startOwnConnectionReader({
    read: () => {
      reads++;
      return fail ? Promise.reject(new Error("no")) : Promise.resolve(LISTED);
    },
    timers: timers.api,
    visibility: visibility.api,
    onChange: (view) => views.push(view),
  });
  await waitFor(() => views.length === 1, "views.length === 1");
  assertEquals(views[0].kind, "listed");
  fail = true;
  timers.fire();
  await waitFor(() => views.length === 2, "views.length === 2");
  assertEquals(views[1], { kind: "listed", workspaces: null });
  visibility.set(false);
  assertEquals(timers.pending(), []);
  assertEquals(reads, 2);
  reader.stop();
});
