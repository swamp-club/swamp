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
  type ForwardingOptions,
  forwardRequestHeaders,
  forwardResponseHeaders,
  forwardWebSocketHeaders,
  offeredSubprotocols,
} from "./forwarding_headers.ts";

const DIRECT: ForwardingOptions = {
  peer: "203.0.113.7",
  protocol: "https",
  trustProxy: false,
};

function request(headers: Record<string, string>): Request {
  return new Request("https://serve.acme.internal/w/a/api", { headers });
}

Deno.test("forwardRequestHeaders: credentials, Host and Content-Length pass through untouched", () => {
  const headers = forwardRequestHeaders(
    request({
      host: "serve.acme.internal",
      authorization: "Bearer swamp_abc",
      cookie: "swamp_session=1; other=2",
      origin: "https://serve.acme.internal",
      "content-length": "10",
      "x-custom": "kept",
    }),
    DIRECT,
  );
  assertEquals(headers.get("host"), "serve.acme.internal");
  assertEquals(headers.get("authorization"), "Bearer swamp_abc");
  assertEquals(headers.get("cookie"), "swamp_session=1; other=2");
  assertEquals(headers.get("origin"), "https://serve.acme.internal");
  assertEquals(headers.get("content-length"), "10");
  assertEquals(headers.get("x-custom"), "kept");
});

Deno.test("forwardRequestHeaders: Host falls back to the request authority when an HTTP/2 caller sent none", () => {
  const headers = forwardRequestHeaders(request({}), DIRECT);
  assertEquals(headers.get("host"), "serve.acme.internal");
  assertEquals(headers.get("x-forwarded-host"), "serve.acme.internal");
});

Deno.test("forwardRequestHeaders: hop-by-hop headers, the ones Connection names, Expect and Forwarded are dropped", () => {
  const headers = forwardRequestHeaders(
    request({
      connection: "keep-alive, x-hop",
      "keep-alive": "timeout=5",
      "x-hop": "gone",
      "proxy-connection": "keep-alive",
      "proxy-authorization": "Basic x",
      te: "trailers",
      trailer: "x-t",
      upgrade: "h2c",
      expect: "100-continue",
      forwarded: "for=198.51.100.1",
    }),
    DIRECT,
  );
  for (
    const name of [
      "connection",
      "keep-alive",
      "x-hop",
      "proxy-connection",
      "proxy-authorization",
      "te",
      "trailer",
      "upgrade",
      "expect",
      "forwarded",
    ]
  ) {
    assertEquals(headers.has(name), false, name);
  }
});

Deno.test("forwardRequestHeaders: forwarding headers a direct caller sends are overwritten", () => {
  const headers = forwardRequestHeaders(
    request({
      host: "serve.acme.internal",
      "x-forwarded-for": "10.0.0.1",
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "http",
    }),
    DIRECT,
  );
  assertEquals(headers.get("x-forwarded-for"), "203.0.113.7");
  assertEquals(headers.get("x-forwarded-host"), "serve.acme.internal");
  assertEquals(headers.get("x-forwarded-proto"), "https");
});

Deno.test("forwardRequestHeaders: behind a trusted proxy the reported values are carried", () => {
  const headers = forwardRequestHeaders(
    request({
      host: "10.0.0.5:8443",
      "x-forwarded-for": "198.51.100.1, 10.0.0.9",
      "x-forwarded-host": "serve.acme.internal, inner",
      "x-forwarded-proto": "HTTPS",
    }),
    { peer: "10.0.0.2", protocol: "http", trustProxy: true },
  );
  assertEquals(
    headers.get("x-forwarded-for"),
    "198.51.100.1, 10.0.0.9, 10.0.0.2",
  );
  assertEquals(headers.get("x-forwarded-host"), "serve.acme.internal");
  assertEquals(headers.get("x-forwarded-proto"), "https");
});

Deno.test("forwardRequestHeaders: behind a trusted proxy missing or unusable values fall back to the router's own", () => {
  const headers = forwardRequestHeaders(
    request({ host: "serve.acme.internal", "x-forwarded-proto": "gopher" }),
    { peer: "10.0.0.2", protocol: "https", trustProxy: true },
  );
  assertEquals(headers.get("x-forwarded-for"), "10.0.0.2");
  assertEquals(headers.get("x-forwarded-host"), "serve.acme.internal");
  assertEquals(headers.get("x-forwarded-proto"), "https");
});

Deno.test("forwardWebSocketHeaders: the handshake headers are left to the router's own client", () => {
  const headers = forwardWebSocketHeaders(
    request({
      host: "serve.acme.internal",
      origin: "https://serve.acme.internal",
      cookie: "a=b",
      authorization: "Bearer swamp_abc",
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-key": "k",
      "sec-websocket-version": "13",
      "sec-websocket-extensions": "permessage-deflate",
      "sec-websocket-protocol": "bearer.x",
    }),
    DIRECT,
  );
  for (
    const name of [
      "host",
      "connection",
      "upgrade",
      "sec-websocket-key",
      "sec-websocket-version",
      "sec-websocket-extensions",
      "sec-websocket-protocol",
    ]
  ) {
    assertEquals(headers.has(name), false, name);
  }
  assertEquals(headers.get("origin"), "https://serve.acme.internal");
  assertEquals(headers.get("cookie"), "a=b");
  assertEquals(headers.get("authorization"), "Bearer swamp_abc");
  assertEquals(headers.get("x-forwarded-host"), "serve.acme.internal");
});

Deno.test("offeredSubprotocols: lists the offered subprotocols in order", () => {
  assertEquals(
    offeredSubprotocols(
      request({ "sec-websocket-protocol": "bearer.x, swamp.v1 ,," }),
    ),
    ["bearer.x", "swamp.v1"],
  );
  assertEquals(offeredSubprotocols(request({})), []);
});

Deno.test("forwardResponseHeaders: repeated Set-Cookie headers stay separate and encoding headers pass", () => {
  const headers = forwardResponseHeaders([
    "Content-Encoding",
    "gzip",
    "Content-Length",
    "28",
    "Set-Cookie",
    "a=1; Path=/",
    "Set-Cookie",
    "b=2; Path=/",
    "Connection",
    "keep-alive, x-hop",
    "Keep-Alive",
    "timeout=5",
    "X-Hop",
    "gone",
    "Transfer-Encoding",
    "chunked",
  ]);
  assertEquals(headers.get("content-encoding"), "gzip");
  assertEquals(headers.get("content-length"), "28");
  assertEquals(headers.getSetCookie(), ["a=1; Path=/", "b=2; Path=/"]);
  for (
    const name of ["connection", "keep-alive", "x-hop", "transfer-encoding"]
  ) {
    assertEquals(headers.has(name), false, name);
  }
});
