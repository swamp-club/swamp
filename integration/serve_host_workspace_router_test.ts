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
import { waitFor } from "@swamp-club/swamp-testing";
import http from "node:http";
import {
  createWorkspaceRouter,
  type WorkspaceDirectory,
  type WorkspaceRoute,
} from "../src/serve/host/workspace_router.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface StandIn {
  readonly port: number;
  /** resolves the SSE route's second event */
  releaseSse(): void;
  readonly cancelled: { value: boolean };
  shutdown(): Promise<void>;
}

/** a port-0 server shaped like a serve: it reports what reached it */
function startStandIn(who: string): StandIn {
  let releaseSse = () => {};
  const cancelled = { value: false };
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (req) => {
      const url = new URL(req.url);
      const seen = {
        who,
        method: req.method,
        path: url.pathname,
        search: url.search,
        host: req.headers.get("host"),
        authorization: req.headers.get("authorization"),
        cookie: req.headers.get("cookie"),
        origin: req.headers.get("origin"),
        forwardedFor: req.headers.get("x-forwarded-for"),
        forwardedHost: req.headers.get("x-forwarded-host"),
        forwardedProto: req.headers.get("x-forwarded-proto"),
        forwarded: req.headers.get("forwarded"),
        contentLength: req.headers.get("content-length"),
        transferEncoding: req.headers.get("transfer-encoding"),
        subprotocols: req.headers.get("sec-websocket-protocol"),
      };
      switch (url.pathname) {
        case "/ws": {
          const offered = seen.subprotocols?.split(",")[0]?.trim();
          const { socket, response } = Deno.upgradeWebSocket(
            req,
            offered ? { protocol: offered } : {},
          );
          socket.binaryType = "arraybuffer";
          socket.onopen = () => socket.send(JSON.stringify(seen));
          socket.onmessage = (e) => {
            if (e.data === "close-4001") socket.close(4001, "bye");
            else socket.send(e.data);
          };
          return response;
        }
        case "/ws-refuse":
          return new Response("no", { status: 401 });
        case "/upload": {
          const size = (await req.arrayBuffer()).byteLength;
          return Response.json({ ...seen, size });
        }
        case "/duplex": {
          const reader = req.body!.getReader();
          return new Response(
            new ReadableStream<Uint8Array>({
              async pull(controller) {
                const { value, done } = await reader.read();
                if (done) controller.close();
                else controller.enqueue(value);
              },
            }),
          );
        }
        case "/sse": {
          const second = new Promise<void>((resolve) => {
            releaseSse = resolve;
          });
          return new Response(
            new ReadableStream<Uint8Array>({
              async start(controller) {
                controller.enqueue(encoder.encode("data: one\n\n"));
                await second;
                controller.enqueue(encoder.encode("data: two\n\n"));
                controller.close();
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        case "/endless":
          return new Response(
            new ReadableStream<Uint8Array>({
              pull: async (controller) => {
                await new Promise((resolve) => setTimeout(resolve, 10));
                controller.enqueue(encoder.encode("tick\n"));
              },
              cancel() {
                cancelled.value = true;
              },
            }),
          );
        case "/die":
          return new Response(
            new ReadableStream<Uint8Array>({
              async start(controller) {
                controller.enqueue(encoder.encode("partial"));
                await new Promise((resolve) => setTimeout(resolve, 10));
                controller.error(new Error("child died"));
              },
            }),
          );
        case "/gzip": {
          const gzipped = new Uint8Array(
            await new Response(
              new Blob([encoder.encode("hello hello hello")]).stream()
                .pipeThrough(new CompressionStream("gzip")),
            ).arrayBuffer(),
          );
          const headers = new Headers({
            "content-encoding": "gzip",
            "content-length": String(gzipped.byteLength),
          });
          headers.append("set-cookie", "a=1; Path=/");
          headers.append("set-cookie", "b=2; Path=/");
          return new Response(gzipped, { headers });
        }
        case "/no-content":
          return new Response(null, { status: 204 });
        case "/not-modified":
          return new Response(null, { status: 304 });
        default:
          return Response.json(seen, {
            headers: { "x-who": who, "content-length-hint": "json" },
          });
      }
    },
  );
  return {
    port: server.addr.port,
    releaseSse: () => releaseSse(),
    cancelled,
    shutdown: () => server.shutdown(),
  };
}

interface RunningRouter {
  readonly port: number;
  readonly shutdownSignal: AbortController;
  shutdown(): Promise<void>;
}

function startRouter(
  directory: WorkspaceDirectory,
  trustProxy = false,
): RunningRouter {
  const shutdownSignal = new AbortController();
  const router = createWorkspaceRouter({
    directory,
    protocol: "https",
    trustProxy,
    signal: shutdownSignal.signal,
    webSocketOpenTimeoutMs: 5_000,
  });
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (req, info) => router.handle(req, info),
  );
  return {
    port: server.addr.port,
    shutdownSignal,
    async shutdown() {
      shutdownSignal.abort();
      await server.shutdown();
    },
  };
}

interface NodeReply {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

/** a caller that can name its own Host, which fetch cannot */
function nodeRequest(
  port: number,
  path: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<NodeReply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: init.method ?? "GET",
        headers: init.headers,
        agent: false,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => body += chunk);
        res.on(
          "end",
          () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body,
            }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}

interface Fixture {
  readonly child: StandIn;
  readonly root: StandIn;
  readonly router: RunningRouter;
}

async function withFixture(
  run: (fixture: Fixture) => Promise<void>,
  options: { root?: boolean; trustProxy?: boolean } = {},
): Promise<void> {
  const child = startStandIn("edge-dns");
  const root = startStandIn("root");
  const workspaces: Record<string, WorkspaceRoute> = {
    "edge-dns": { kind: "running", port: child.port },
    stopped: { kind: "unavailable", state: "stopped" },
  };
  const router = startRouter({
    workspace: (name) => workspaces[name],
    root: () =>
      options.root === false ? undefined : { kind: "running", port: root.port },
  }, options.trustProxy);
  try {
    await run({ child, root, router });
  } finally {
    await router.shutdown();
    child.releaseSse();
    root.releaseSse();
    await child.shutdown();
    await root.shutdown();
  }
}

function base(router: RunningRouter): string {
  return `http://127.0.0.1:${router.port}`;
}

Deno.test("workspace router: a request reaches its workspace without the prefix and the reply comes back", async () => {
  await withFixture(async ({ router }) => {
    const reply = await nodeRequest(router.port, "/w/edge-dns/api/v1/x?q=1", {
      method: "POST",
      headers: {
        host: "serve.acme.internal",
        authorization: "Bearer swamp_abc",
        cookie: "swamp_session=s1",
        origin: "https://serve.acme.internal",
        "content-type": "application/json",
      },
      body: "{}",
    });
    assertEquals(reply.status, 200);
    assertEquals(reply.headers["x-who"], "edge-dns");
    const seen = JSON.parse(reply.body);
    assertEquals(seen.who, "edge-dns");
    assertEquals(seen.method, "POST");
    assertEquals(seen.path, "/api/v1/x");
    assertEquals(seen.search, "?q=1");
    assertEquals(seen.host, "serve.acme.internal");
    assertEquals(seen.authorization, "Bearer swamp_abc");
    assertEquals(seen.cookie, "swamp_session=s1");
    assertEquals(seen.origin, "https://serve.acme.internal");
  });
});

Deno.test("workspace router: a child sees the caller's public host and protocol and the caller's own forwarding headers are replaced", async () => {
  await withFixture(async ({ router }) => {
    const reply = await nodeRequest(router.port, "/w/edge-dns/whoami", {
      headers: {
        host: "serve.acme.internal",
        "x-forwarded-for": "10.9.9.9",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "http",
        forwarded: "for=10.9.9.9",
      },
    });
    const seen = JSON.parse(reply.body);
    assertEquals(seen.forwardedFor, "127.0.0.1");
    assertEquals(seen.forwardedHost, "serve.acme.internal");
    assertEquals(seen.forwardedProto, "https");
    assertEquals(seen.forwarded, null);
  });
});

Deno.test("workspace router: behind a trusted proxy the proxy's forwarding headers are carried", async () => {
  await withFixture(async ({ router }) => {
    const reply = await nodeRequest(router.port, "/w/edge-dns/whoami", {
      headers: {
        host: "10.0.0.5",
        "x-forwarded-for": "198.51.100.1",
        "x-forwarded-host": "serve.acme.internal",
        "x-forwarded-proto": "https",
      },
    });
    const seen = JSON.parse(reply.body);
    assertEquals(seen.forwardedFor, "198.51.100.1, 127.0.0.1");
    assertEquals(seen.forwardedHost, "serve.acme.internal");
    assertEquals(seen.forwardedProto, "https");
  }, { trustProxy: true });
});

Deno.test("workspace router: an upload keeps its Content-Length, and a chunked one arrives chunked", async () => {
  await withFixture(async ({ router }) => {
    const sized = await fetch(`${base(router)}/w/edge-dns/upload`, {
      method: "PUT",
      body: new Uint8Array(4096),
    });
    const sizedSeen = await sized.json();
    assertEquals(sizedSeen.contentLength, "4096");
    assertEquals(sizedSeen.transferEncoding, null);
    assertEquals(sizedSeen.size, 4096);

    const chunked = await fetch(`${base(router)}/w/edge-dns/upload`, {
      method: "PUT",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(10));
          controller.enqueue(new Uint8Array(20));
          controller.close();
        },
      }),
    });
    const chunkedSeen = await chunked.json();
    assertEquals(chunkedSeen.contentLength, null);
    assertEquals(chunkedSeen.transferEncoding, "chunked");
    assertEquals(chunkedSeen.size, 30);
  });
});

Deno.test("workspace router: a GET that declares a body is sent without its length, so later requests on the pooled connection are read whole", async () => {
  await withFixture(async ({ router }) => {
    for (let i = 0; i < 3; i++) {
      const declared = await nodeRequest(router.port, "/w/edge-dns/x", {
        headers: { "content-length": "10" },
        body: "0123456789",
      });
      assertEquals(declared.status, 200);
      assertEquals(JSON.parse(declared.body).contentLength, null);

      const next = await nodeRequest(router.port, "/w/edge-dns/upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const seen = JSON.parse(next.body);
      assertEquals(seen.method, "POST");
      assertEquals(seen.path, "/upload");
      assertEquals(seen.size, 2);
    }
  });
});

Deno.test("workspace router: a body streams both ways, each chunk crossing before the sender finishes", async () => {
  await withFixture(async ({ router }) => {
    let sendNext = (_chunk: string | null) => {};
    const upload = new ReadableStream<Uint8Array>({
      start(controller) {
        sendNext = (chunk) => {
          if (chunk === null) controller.close();
          else controller.enqueue(encoder.encode(chunk));
        };
      },
    });
    const pending = fetch(`${base(router)}/w/edge-dns/duplex`, {
      method: "POST",
      body: upload,
    });
    sendNext("first");
    const reply = await pending;
    const reader = reply.body!.getReader();
    const first = await reader.read();
    assertEquals(decoder.decode(first.value), "first");
    sendNext("second");
    const second = await reader.read();
    assertEquals(decoder.decode(second.value), "second");
    sendNext(null);
    assertEquals((await reader.read()).done, true);
  });
});

Deno.test("workspace router: SSE events arrive one at a time", async () => {
  await withFixture(async ({ router, child }) => {
    const reply = await fetch(`${base(router)}/w/edge-dns/sse`);
    assertEquals(reply.headers.get("content-type"), "text/event-stream");
    const reader = reply.body!.getReader();
    assertEquals(decoder.decode((await reader.read()).value), "data: one\n\n");
    child.releaseSse();
    assertEquals(decoder.decode((await reader.read()).value), "data: two\n\n");
    assertEquals((await reader.read()).done, true);
  });
});

Deno.test("workspace router: an encoded reply and repeated Set-Cookie headers pass unchanged", async () => {
  await withFixture(async ({ router }) => {
    const reply = await nodeRequest(router.port, "/w/edge-dns/gzip");
    assertEquals(reply.headers["content-encoding"], "gzip");
    assertEquals(reply.headers["set-cookie"], ["a=1; Path=/", "b=2; Path=/"]);
    const decoded = await fetch(`${base(router)}/w/edge-dns/gzip`);
    assertEquals(await decoded.text(), "hello hello hello");
  });
});

Deno.test("workspace router: 204, 304 and HEAD replies pass with no body", async () => {
  await withFixture(async ({ router }) => {
    const noContent = await fetch(`${base(router)}/w/edge-dns/no-content`);
    assertEquals(noContent.status, 204);
    assertEquals(noContent.body, null);
    const notModified = await fetch(`${base(router)}/w/edge-dns/not-modified`);
    assertEquals(notModified.status, 304);
    await notModified.body?.cancel();
    const head = await fetch(`${base(router)}/w/edge-dns/x`, {
      method: "HEAD",
    });
    assertEquals(head.status, 200);
    assertEquals(head.headers.get("x-who"), "edge-dns");
    await head.body?.cancel();
  });
});

Deno.test("workspace router: a WebSocket is relayed with its subprotocol, Origin, cookies and query", async () => {
  await withFixture(async ({ router }) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${router.port}/w/edge-dns/ws?compress=1`,
      {
        protocols: ["bearer.swamp_abc", "other"],
        headers: {
          origin: "https://serve.acme.internal",
          cookie: "swamp_session=s1",
        },
      },
    );
    ws.binaryType = "arraybuffer";
    const messages: Array<string | ArrayBuffer> = [];
    ws.onmessage = (e) => messages.push(e.data);
    const closed = new Promise<CloseEvent>((resolve) => {
      ws.onclose = resolve;
    });
    try {
      await waitFor(() => messages.length >= 1, "the child's first frame");
      assertEquals(ws.protocol, "bearer.swamp_abc");
      const seen = JSON.parse(messages[0] as string);
      assertEquals(seen.path, "/ws");
      assertEquals(seen.search, "?compress=1");
      assertEquals(seen.origin, "https://serve.acme.internal");
      assertEquals(seen.cookie, "swamp_session=s1");
      assertEquals(seen.subprotocols, "bearer.swamp_abc, other");
      assertEquals(seen.forwardedFor, "127.0.0.1");
      assertEquals(seen.forwardedProto, "https");

      ws.send("text frame");
      ws.send(new Uint8Array([1, 2, 3]));
      await waitFor(() => messages.length >= 3, "both echoed frames");
      assertEquals(messages[1], "text frame");
      assertEquals([...new Uint8Array(messages[2] as ArrayBuffer)], [1, 2, 3]);

      ws.send("close-4001");
      const close = await closed;
      assertEquals(close.code, 4001);
      assertEquals(close.reason, "bye");
    } finally {
      ws.close();
    }
  });
});

Deno.test("workspace router: a child that refuses a WebSocket upgrade is answered 502", async () => {
  await withFixture(async ({ router }) => {
    const reply = await nodeRequest(router.port, "/w/edge-dns/ws-refuse", {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": btoa("0123456789abcdef"),
      },
    });
    assertEquals(reply.status, 502);
  });
});

Deno.test("workspace router: a stopped workspace answers 503 naming its state, an unknown one 404", async () => {
  await withFixture(async ({ router }) => {
    const stopped = await fetch(`${base(router)}/w/stopped/api`);
    assertEquals(stopped.status, 503);
    assertEquals(await stopped.json(), {
      error: "The workspace is not running.",
      workspace: "stopped",
      state: "stopped",
    });
    const unknown = await fetch(`${base(router)}/w/nobody/api`);
    assertEquals(unknown.status, 404);
    await unknown.body?.cancel();
    const invalid = await fetch(`${base(router)}/w/Not_A_Name/api`);
    assertEquals(invalid.status, 404);
    await invalid.body?.cancel();
  });
});

Deno.test("workspace router: a path outside /w/ reaches the root unchanged", async () => {
  await withFixture(async ({ router }) => {
    const reply = await fetch(`${base(router)}/api/v1/request?x=y`);
    const seen = await reply.json();
    assertEquals(seen.who, "root");
    assertEquals(seen.path, "/api/v1/request");
    assertEquals(seen.search, "?x=y");
  });
});

Deno.test("workspace router: a path outside /w/ answers 404 when there is no root", async () => {
  await withFixture(async ({ router }) => {
    const reply = await fetch(`${base(router)}/api/v1/request`);
    assertEquals(reply.status, 404);
    await reply.body?.cancel();
  }, { root: false });
});

Deno.test("workspace router: a running workspace with nothing on its port answers 502 naming no internals", async () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const deadPort = (listener.addr as Deno.NetAddr).port;
  listener.close();
  const router = startRouter({
    workspace: () => ({ kind: "running", port: deadPort }),
    root: () => undefined,
  });
  try {
    const reply = await fetch(`http://127.0.0.1:${router.port}/w/gone/api`);
    assertEquals(reply.status, 502);
    const body = await reply.text();
    assert(!body.includes(String(deadPort)), body);
    assert(!body.toLowerCase().includes("econnrefused"), body);
  } finally {
    await router.shutdown();
  }
});

Deno.test("workspace router: a caller dropping a stream releases the child's stream", async () => {
  await withFixture(async ({ router, child }) => {
    const caller = new AbortController();
    const reply = await fetch(`${base(router)}/w/edge-dns/endless`, {
      signal: caller.signal,
    });
    await reply.body!.getReader().read();
    caller.abort();
    await waitFor(() => child.cancelled.value, "the child's stream cancelled");
  });
});

Deno.test("workspace router: a child dying mid-reply and a caller aborting mid-upload leave the router answering", async () => {
  await withFixture(async ({ router }) => {
    const dying = await fetch(`${base(router)}/w/edge-dns/die`);
    let failed = false;
    try {
      await dying.text();
    } catch {
      failed = true;
    }
    assert(failed, "a reply cut short by the child must not end cleanly");

    const caller = new AbortController();
    const upload = fetch(`${base(router)}/w/edge-dns/upload`, {
      method: "PUT",
      signal: caller.signal,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(10));
        },
      }),
    });
    caller.abort();
    await upload.then((r) => r.body?.cancel(), () => {});

    const after = await fetch(`${base(router)}/w/edge-dns/still-here`);
    assertEquals((await after.json()).path, "/still-here");
  });
});

Deno.test("workspace router: shutdown ends an open stream and closes a relayed WebSocket", async () => {
  await withFixture(async ({ router }) => {
    const reply = await fetch(`${base(router)}/w/edge-dns/sse`);
    const reader = reply.body!.getReader();
    await reader.read();

    const ws = new WebSocket(`ws://127.0.0.1:${router.port}/w/edge-dns/ws`);
    let opened = false;
    ws.onopen = () => opened = true;
    const closed = new Promise<void>((resolve) => {
      ws.onclose = () => resolve();
    });
    await waitFor(() => opened, "the relayed WebSocket open");

    router.shutdownSignal.abort();
    await closed;
    const end = await reader.read().then((r) => r.done, () => true);
    assert(end, "the stream must end at shutdown");
  });
});
