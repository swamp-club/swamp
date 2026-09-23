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

import { assertEquals, assertThrows } from "@std/assert";
import { normalizeServerUrl, redactServerUrl } from "./server_url.ts";

Deno.test("normalizeServerUrl: strips trailing slash", () => {
  assertEquals(
    normalizeServerUrl("https://swamp.example.com/"),
    "https://swamp.example.com",
  );
});

Deno.test("normalizeServerUrl: strips multiple trailing slashes", () => {
  assertEquals(
    normalizeServerUrl("https://swamp.example.com///"),
    "https://swamp.example.com",
  );
});

Deno.test("normalizeServerUrl: lowercases hostname", () => {
  assertEquals(
    normalizeServerUrl("https://SWAMP.Example.COM"),
    "https://swamp.example.com",
  );
});

Deno.test("normalizeServerUrl: preserves non-default port", () => {
  assertEquals(
    normalizeServerUrl("https://swamp.example.com:9090"),
    "https://swamp.example.com:9090",
  );
});

Deno.test("normalizeServerUrl: strips default https port 443", () => {
  assertEquals(
    normalizeServerUrl("https://swamp.example.com:443"),
    "https://swamp.example.com",
  );
});

Deno.test("normalizeServerUrl: strips default http port 80", () => {
  assertEquals(
    normalizeServerUrl("http://swamp.example.com:80"),
    "http://swamp.example.com",
  );
});

Deno.test("normalizeServerUrl: preserves non-root path", () => {
  assertEquals(
    normalizeServerUrl("https://swamp.example.com/api/v1/"),
    "https://swamp.example.com/api/v1",
  );
});

Deno.test("normalizeServerUrl: handles IPv6 address", () => {
  assertEquals(
    normalizeServerUrl("https://[::1]:9090"),
    "https://[::1]:9090",
  );
});

Deno.test("normalizeServerUrl: same URL normalizes identically", () => {
  const a = normalizeServerUrl("https://Swamp.Example.COM:443/");
  const b = normalizeServerUrl("https://swamp.example.com");
  assertEquals(a, b);
});

Deno.test("normalizeServerUrl: throws on invalid URL", () => {
  assertThrows(() => normalizeServerUrl("not a url"), TypeError);
});

Deno.test("normalizeServerUrl: throws on unsupported protocol", () => {
  assertThrows(
    () => normalizeServerUrl("ftp://swamp.example.com"),
    TypeError,
    "Unsupported protocol",
  );
});

Deno.test("normalizeServerUrl: http scheme preserved", () => {
  assertEquals(
    normalizeServerUrl("http://localhost:8080"),
    "http://localhost:8080",
  );
});

Deno.test("normalizeServerUrl: ws converts to http", () => {
  assertEquals(
    normalizeServerUrl("ws://swamp.example.com:8080"),
    "http://swamp.example.com:8080",
  );
});

Deno.test("normalizeServerUrl: wss converts to https", () => {
  assertEquals(
    normalizeServerUrl("wss://swamp.example.com"),
    "https://swamp.example.com",
  );
});

Deno.test("normalizeServerUrl: wss with port converts to https with port", () => {
  assertEquals(
    normalizeServerUrl("wss://swamp.example.com:9090/"),
    "https://swamp.example.com:9090",
  );
});

Deno.test("normalizeServerUrl: ws and http normalize to same key", () => {
  assertEquals(
    normalizeServerUrl("ws://swamp.example.com:8080"),
    normalizeServerUrl("http://swamp.example.com:8080"),
  );
});

Deno.test("normalizeServerUrl: wss and https normalize to same key", () => {
  assertEquals(
    normalizeServerUrl("wss://SWAMP.Example.COM:443/"),
    normalizeServerUrl("https://swamp.example.com"),
  );
});

Deno.test("redactServerUrl: drops a token query string", () => {
  assertEquals(
    redactServerUrl("http://127.0.0.1:9000/?token=abc.s3cret"),
    "http://127.0.0.1:9000",
  );
});

Deno.test("redactServerUrl: drops userinfo", () => {
  assertEquals(
    redactServerUrl("https://alice:hunter2@serve.example.com"),
    "https://serve.example.com",
  );
});

Deno.test("redactServerUrl: drops the fragment", () => {
  assertEquals(
    redactServerUrl("wss://serve.example.com:4000/#s3cret"),
    "wss://serve.example.com:4000",
  );
});

Deno.test("redactServerUrl: keeps the scheme as given", () => {
  assertEquals(redactServerUrl("ws://h:1"), "ws://h:1");
  assertEquals(redactServerUrl("wss://h:1"), "wss://h:1");
  assertEquals(redactServerUrl("http://h:1"), "http://h:1");
  assertEquals(redactServerUrl("https://h:1"), "https://h:1");
  assertEquals(redactServerUrl("ftp://u:p@h/?token=x"), "ftp://h");
});

Deno.test("redactServerUrl: keeps a non-root path", () => {
  assertEquals(
    redactServerUrl("https://u:p@serve.example.com/swamp/?token=x#f"),
    "https://serve.example.com/swamp/",
  );
});

Deno.test("redactServerUrl: returns undefined for a value that does not parse", () => {
  assertEquals(redactServerUrl("not a url"), undefined);
  assertEquals(redactServerUrl(""), undefined);
});

Deno.test("redactServerUrl: returns undefined for a URL without a host", () => {
  assertEquals(redactServerUrl("localhost:9000/?token=s3cret"), undefined);
  assertEquals(redactServerUrl("mailto:alice@example.com"), undefined);
});
