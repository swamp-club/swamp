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
  assertNotStrictEquals,
  assertStrictEquals,
} from "@std/assert";
import type { ApprovalsReply } from "../packages/dashboard/src/client/approvals.ts";
import {
  type ApprovalsRequest,
  createApprovalsRequest,
} from "../packages/dashboard/src/client/approvals_request.ts";
import {
  createConnection,
  type SocketHandlers,
} from "../packages/dashboard/src/client/connection.ts";
import {
  settleRequest,
  type WireFrame,
} from "../packages/dashboard/src/client/stream.ts";

class Socket {
  readonly pending = new Map<string, PromiseWithResolvers<ApprovalsReply>>();
  readonly sent: string[] = [];
  closed = false;
  constructor(readonly handlers: SocketHandlers) {}
  close() {
    this.closed = true;
  }
  request(): Promise<ApprovalsReply> {
    const id = crypto.randomUUID();
    const reply = Promise.withResolvers<ApprovalsReply>();
    this.pending.set(id, reply);
    this.sent.push(id);
    return reply.promise;
  }
  reply(index: number, data: ApprovalsReply) {
    this.handlers.onMessage(JSON.stringify({
      type: "workflow.approvals",
      id: this.sent[index],
      payload: data,
    }));
  }
}

/** Real connection lifecycle and request owner with an in-process transport. */
function dashboard() {
  const sockets: Socket[] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  let owner!: ApprovalsRequest;
  let initial!: Promise<ApprovalsReply | null>;
  const connection = createConnection<Socket>({
    createSocket: (_protocols, handlers) => {
      const socket = new Socket(handlers);
      sockets.push(socket);
      return socket;
    },
    setTimer: (fn) => {
      timers.set(++timerId, fn);
      return timerId;
    },
    clearTimer: (id) => {
      timers.delete(id);
    },
    probe: () => Promise.resolve(200),
    fetchAuthInfo: () => Promise.resolve({ mode: "token" }),
    onOpen: (socket) => {
      owner = createApprovalsRequest(() => socket.request());
      initial = owner.start();
    },
    onMessage: (socket, text) => {
      const frame = JSON.parse(text) as WireFrame;
      const pending = socket.pending.get(frame.id);
      if (!pending) return;
      const outcome = settleRequest(frame);
      if (outcome.kind === "resolve") {
        socket.pending.delete(frame.id);
        pending.resolve(outcome.value as ApprovalsReply);
      }
    },
    onDisconnect: () => {
      owner.stop();
      for (const socket of sockets) {
        for (const pending of socket.pending.values()) {
          pending.reject(new Error("WebSocket closed"));
        }
        socket.pending.clear();
      }
    },
    onReauth: () => {},
    onAuthModeChanged: () => {},
  });
  return {
    connection,
    sockets,
    get owner() {
      return owner;
    },
    get initial() {
      return initial;
    },
    retry: () => {
      const [id, fn] = [...timers][0];
      timers.delete(id);
      fn();
    },
  };
}

const forPrincipal = (workflowName: string): ApprovalsReply => ({
  data: { approvals: [{ workflowName, runId: "run", stepName: "gate" }] },
});

Deno.test("dashboard approvals: reconnect clears the listing and shares one fresh read", async () => {
  const app = dashboard();
  app.connection.start({ token: "", authMode: "token" });
  const first = app.sockets[0];
  first.handlers.onOpen();
  const oldOwner = app.owner;
  const oldData = forPrincipal("before-reconnect");
  const page = oldOwner.reload();
  assertEquals(first.sent.length, 1);
  first.reply(0, oldData);
  await Promise.all([app.initial, page]);
  assertStrictEquals(oldOwner.getSnapshot().data, await page);
  const outstanding = oldOwner.reload();
  first.handlers.onClose(1006);
  app.retry();
  const second = app.sockets[1];
  second.handlers.onOpen();
  assertNotStrictEquals(app.owner, oldOwner);
  assertEquals(app.owner.getSnapshot().data, null);
  assertEquals(oldOwner.getSnapshot().data, null);
  assertEquals(await outstanding, null);
  const freshPage = app.owner.reload();
  assertEquals(second.sent.length, 1);
  // The real connection controller ignores callbacks from retired sockets.
  first.reply(1, oldData);
  first.handlers.onOpen();
  assertEquals(second.sent.length, 1);
  second.reply(0, forPrincipal("after-reconnect"));
  assertEquals(await freshPage, forPrincipal("after-reconnect"));
  await app.initial;
  app.connection.stop();
});

Deno.test("dashboard approvals: rapid principal replacement with the same session sentinel cannot retain data", async () => {
  const app = dashboard();
  app.connection.start({ token: "", authMode: "token" });
  const first = app.sockets[0];
  first.handlers.onOpen();
  first.reply(0, forPrincipal("alice-private"));
  await app.initial;
  const oldOwner = app.owner;
  // Stop/open synchronously, as a batched React update can do on reauthentication.
  app.connection.start({ token: "", authMode: "token" });
  const second = app.sockets[1];
  second.handlers.onOpen();
  assertEquals(first.closed, true);
  assertEquals(app.owner.getSnapshot().data, null);
  assertEquals(await oldOwner.refresh(), null);
  assertEquals(second.sent.length, 1);
  second.reply(0, forPrincipal("bob-private"));
  assertEquals(await app.initial, forPrincipal("bob-private"));
  first.reply(0, forPrincipal("alice-private"));
  assertEquals(app.owner.getSnapshot().data, forPrincipal("bob-private"));
  app.connection.stop();
});
