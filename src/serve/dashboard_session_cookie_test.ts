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

import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import {
  DashboardSessionCookie,
  PLAIN_DASHBOARD_SESSION_COOKIE,
} from "./dashboard_session_cookie.ts";

Deno.test("DashboardSessionCookie.forAddress: no address, or one with no path, is the plain cookie at /", () => {
  for (
    const address of [
      undefined,
      "https://serve.example.test",
      "https://serve.example.test/",
      "http://localhost:9090//",
    ]
  ) {
    const cookie = DashboardSessionCookie.forAddress(address);
    assertEquals(cookie.name, PLAIN_DASHBOARD_SESSION_COOKIE);
    assertEquals(cookie.path, "/");
  }
});

Deno.test("DashboardSessionCookie.forServe: only a host's workspace scopes its cookie to its address path", () => {
  const address = "https://serve.example.test/w/edge-dns";
  assertEquals(
    DashboardSessionCookie.forServe(address, true),
    DashboardSessionCookie.forAddress(address),
  );
  assertEquals(
    DashboardSessionCookie.forServe("https://example.test/swamp", false),
    DashboardSessionCookie.plain,
  );
  assertEquals(
    DashboardSessionCookie.forServe(undefined, true),
    DashboardSessionCookie.plain,
  );
});

Deno.test("DashboardSessionCookie.forAddress: a path names the cookie and scopes it to that path", () => {
  const cookie = DashboardSessionCookie.forAddress(
    "https://serve.example.test/w/edge-dns",
  );
  assertEquals(cookie.name, "swamp-dashboard-session_2Fw_2Fedge-dns");
  assertEquals(cookie.path, "/w/edge-dns");
});

Deno.test("DashboardSessionCookie.forAddress: a trailing slash, default port or ws scheme names the same cookie", () => {
  const expected = DashboardSessionCookie.forAddress(
    "https://serve.example.test/w/a",
  );
  for (
    const address of [
      "https://serve.example.test/w/a/",
      "https://serve.example.test:443/w/a",
      "wss://serve.example.test/w/a",
    ]
  ) {
    assertEquals(DashboardSessionCookie.forAddress(address), expected);
  }
});

Deno.test("DashboardSessionCookie.forAddress: a host behind a proxy path names its workspaces under it", () => {
  const cookie = DashboardSessionCookie.forAddress(
    "https://example.test/swamp/w/data",
  );
  assertEquals(cookie.name, "swamp-dashboard-session_2Fswamp_2Fw_2Fdata");
  assertEquals(cookie.path, "/swamp/w/data");
});

Deno.test("DashboardSessionCookie.forAddress: a semicolon in the path cannot add an attribute", () => {
  const cookie = DashboardSessionCookie.forAddress(
    "https://serve.example.test/a;Domain=evil.test",
  );
  assertEquals(cookie.path, "/a%3BDomain=evil.test");
  assertEquals(cookie.name.includes(";"), false);
  assertEquals(cookie.setHeader("x", true).includes("; Domain="), false);
});

Deno.test("DashboardSessionCookie.forAddress: refuses an address that is not a URL", () => {
  assertThrows(() => DashboardSessionCookie.forAddress("not a url"));
});

Deno.test("DashboardSessionCookie: set and expire carry the same name and Path", () => {
  const cookie = DashboardSessionCookie.forAddress(
    "https://serve.example.test/w/data",
  );
  assertEquals(
    cookie.setHeader("id/1", true),
    "swamp-dashboard-session_2Fw_2Fdata=id%2F1; Path=/w/data; HttpOnly; SameSite=Strict; Secure",
  );
  assertEquals(
    cookie.expireHeader(false),
    "swamp-dashboard-session_2Fw_2Fdata=; Path=/w/data; HttpOnly; SameSite=Strict; Max-Age=0",
  );
});

Deno.test("DashboardSessionCookie: the plain cookie's headers are unchanged", () => {
  assertEquals(
    DashboardSessionCookie.plain.setHeader("abc", false),
    "swamp-dashboard-session=abc; Path=/; HttpOnly; SameSite=Strict",
  );
  assertEquals(
    DashboardSessionCookie.plain.expireHeader(true),
    "swamp-dashboard-session=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0",
  );
});

Deno.test("DashboardSessionCookie.forAddress: neighbouring workspaces get different names", () => {
  assertNotEquals(
    DashboardSessionCookie.forAddress("https://h.test/w/data").name,
    DashboardSessionCookie.forAddress("https://h.test/w/data-2").name,
  );
});
