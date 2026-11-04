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

import { assert, assertEquals, assertRejects } from "@std/assert";
import type { SocketHandlers } from "../client/connection.ts";
import type {
  HttpReadOutcome,
  HttpReadRequest,
} from "../client/http_request.ts";
import type { WireFrame } from "../client/stream.ts";
import type {
  BridgeFrame,
  BridgePort,
  HostMessage,
} from "../../../app-sdk/bridge.ts";
import {
  AppConnection,
  type AppConnectionDeps,
  appConnectionStart,
} from "./app_connection.ts";
import { AppBroker } from "./broker.ts";

interface FakeSocket {
  readonly protocols: string[] | undefined;
  readonly handlers: SocketHandlers;
  readonly sent: WireFrame[];
  closed: boolean;
}

function harness(
  readOverHttp: AppConnectionDeps["readOverHttp"] = () =>
    Promise.resolve({ kind: "route_missing" }),
) {
  const sockets: FakeSocket[] = [];
  const states: boolean[] = [];
  let ids = 0;
  const deps: AppConnectionDeps = {
    setTimer: () => 0,
    clearTimer: () => {},
    createSocket: (protocols, handlers) => {
      const socket: FakeSocket = {
        protocols,
        handlers,
        sent: [],
        closed: false,
      };
      sockets.push(socket);
      return {
        send: (data) => socket.sent.push(JSON.parse(data)),
        close: () => {
          socket.closed = true;
        },
      };
    },
    probe: () => Promise.resolve(200),
    fetchAuthInfo: () => Promise.resolve(null),
    readOverHttp,
    newId: () => `x${++ids}`,
  };
  const connection = new AppConnection(deps, (up) => states.push(up));
  const open = () => {
    connection.start({ token: "", authMode: "oauth" });
    const socket = sockets.at(-1)!;
    socket.handlers.onOpen();
    return socket;
  };
  const deliver = (socket: FakeSocket, frame: WireFrame) =>
    socket.handlers.onMessage(JSON.stringify(frame));
  return { connection, sockets, states, open, deliver };
}

async function drain(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

Deno.test("appConnectionStart: follows the dashboard's own credentials", () => {
  assertEquals(
    appConnectionStart({ token: null, authMode: "none", sessionReady: false }),
    { token: null, authMode: "none" },
  );
  assertEquals(
    appConnectionStart({ token: "", authMode: "oauth", sessionReady: true }),
    { token: "", authMode: "oauth" },
  );
  assertEquals(
    appConnectionStart({ token: null, authMode: "oauth", sessionReady: true }),
    null,
  );
  assertEquals(
    appConnectionStart({ token: "", authMode: "token", sessionReady: false }),
    null,
  );
  assertEquals(
    appConnectionStart({ token: "", authMode: null, sessionReady: true }),
    null,
  );
});

Deno.test("AppConnection: a session cookie offers no bearer subprotocol", () => {
  const { sockets, open } = harness();
  open();
  assertEquals(sockets[0].protocols, undefined);
});

Deno.test("AppConnection: replies reach the request until a terminal frame", () => {
  const { connection, states, open, deliver } = harness();
  const socket = open();
  assertEquals(states, [true]);
  const got: WireFrame[] = [];
  connection.sendFrame({ type: "run.attach", id: "app:1" }, (f) => got.push(f));
  assertEquals(socket.sent, [{ type: "run.attach", id: "app:1" }]);
  deliver(socket, { type: "event", id: "app:1", event: {} });
  deliver(socket, { type: "done", id: "app:1" });
  deliver(socket, { type: "event", id: "app:1", event: {} });
  deliver(socket, { type: "event", id: "other", event: {} });
  assertEquals(got.map((f) => f.type), ["event", "done"]);
});

Deno.test("AppConnection: a frame sent before the socket opens is refused", () => {
  const { connection } = harness();
  const got: WireFrame[] = [];
  connection.sendFrame(
    { type: "workflow.search", id: "a" },
    (f) => got.push(f),
  );
  assertEquals(got[0].error?.code, "disconnected");
});

Deno.test("AppConnection: a dropped socket fails its requests and reports it", () => {
  const { connection, states, open } = harness();
  const socket = open();
  const got: WireFrame[] = [];
  connection.sendFrame(
    { type: "workflow.search", id: "a" },
    (f) => got.push(f),
  );
  socket.handlers.onClose(1006);
  assertEquals(got[0].error?.code, "disconnected");
  assertEquals(states, [true, false]);
  assertEquals(connection.connected, false);
});

Deno.test("AppConnection: closing closes the socket for good", () => {
  const { connection, sockets, states, open } = harness();
  const socket = open();
  connection.close();
  assert(socket.closed);
  assertEquals(states, [true]);
  connection.start({ token: "", authMode: "oauth" });
  assertEquals(sockets.length, 1);
});

Deno.test("AppConnection: a read goes over HTTP while the socket is open", async () => {
  const reads: HttpReadRequest[] = [];
  const { connection, open } = harness((request) => {
    reads.push(request);
    return Promise.resolve({ kind: "payload", value: { data: 1 } });
  });
  await assertRejects(() => connection.request("data.get"), Error);
  const socket = open();
  assertEquals(await connection.request("data.get", { name: "n" }), {
    data: 1,
  });
  assertEquals(reads, [{ type: "data.get", id: "x1", payload: { name: "n" } }]);
  assertEquals(socket.sent.length, 0);
});

Deno.test("AppConnection: a read serve sends back to the socket goes on the app's own", async () => {
  const { connection, open, deliver } = harness();
  const socket = open();
  const reply = connection.request("data.get");
  await drain();
  assertEquals(socket.sent, [{ type: "data.get", id: "x2" }]);
  deliver(socket, { type: "data.get", id: "x2", payload: { data: 2 } });
  assertEquals(await reply, { data: 2 });
});

Deno.test("AppConnection: a signed-out read is an error", async () => {
  const { connection, open } = harness(() =>
    Promise.resolve<HttpReadOutcome>({ kind: "signed_out", message: "gone" })
  );
  open();
  await assertRejects(() => connection.request("data.get"), Error, "gone");
});

function brokerOn(connection: AppConnection) {
  const make = (): BridgePort & { peer?: BridgePort } => ({
    onmessage: null,
    postMessage(message) {
      queueMicrotask(() => this.peer?.onmessage?.({ data: message }));
    },
    close() {},
  });
  const app = make();
  const host = make();
  app.peer = host;
  host.peer = app;
  const received: HostMessage[] = [];
  app.onmessage = (event) => received.push(event.data as HostMessage);
  const broker = new AppBroker(host, {
    app: {
      name: "@acme/cost",
      title: "Cost",
      local: false,
      capabilities: ["runs:read"],
      run: [],
      methods: [],
    },
    theme: { mode: "light", tokens: {} },
    connected: connection.connected,
    path: "/",
    host: {
      sendFrame: (frame, onFrame) => connection.sendFrame(frame, onFrame),
      isHttpRead: () => false,
      request: (type, payload) => connection.request(type, payload),
      subscribeHealth: () => () => {},
      navigate: () => {},
      close: () => connection.close(),
    },
  });
  const post = (frame: BridgeFrame) => {
    app.postMessage({ kind: "frame", frame });
    return drain();
  };
  const framesFor = (id: string) =>
    received.flatMap((message) =>
      message.kind === "frame" && message.frame.id === id ? [message.frame] : []
    );
  return { broker, post, framesFor };
}

Deno.test("AppConnection: closing the broker closes the app's socket", () => {
  const { connection, open } = harness();
  const socket = open();
  const { broker } = brokerOn(connection);
  broker.close();
  assert(socket.closed);
});

Deno.test("AppConnection: an app's 101st concurrent request gets serve's too_many_requests", async () => {
  const { connection, open, deliver } = harness();
  const socket = open();
  const { post, framesFor } = brokerOn(connection);
  for (let i = 0; i <= 100; i++) {
    await post({ type: "workflow.run.search", id: `r${i}` });
  }
  assertEquals(socket.sent.length, 101);
  // serve answers the one past its per-socket limit as it would any client
  const over = socket.sent[100];
  deliver(socket, {
    type: "error",
    id: over.id,
    error: {
      code: "too_many_requests",
      message: "Too many concurrent requests (limit: 100)",
    },
  });
  await drain();
  assertEquals(framesFor("r100"), [{
    type: "error",
    id: "r100",
    error: {
      code: "too_many_requests",
      message: "Too many concurrent requests (limit: 100)",
    },
  }]);
  assertEquals(framesFor("r99").length, 0);
});
