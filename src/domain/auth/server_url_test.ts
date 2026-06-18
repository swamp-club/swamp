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
import { normalizeServerUrl } from "./server_url.ts";

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
