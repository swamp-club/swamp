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

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import fc from "fast-check";
import {
  DashboardSessionCookie,
  PLAIN_DASHBOARD_SESSION_COOKIE,
} from "./dashboard_session_cookie.ts";

// RFC 6265 cookie-name is an RFC 2616 token
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// URL parsing resolves dot segments, so they could leave no path at all
const arbSegment = fc.string({ minLength: 1, maxLength: 12 }).filter(
  (segment) => segment !== "." && segment !== "..",
);
const arbAddress = fc.array(arbSegment, { minLength: 1, maxLength: 4 }).map(
  (segments) =>
    `https://serve.example.test/${
      segments.map((segment) => encodeURIComponent(segment)).join("/")
    }`,
);

Deno.test("DashboardSessionCookie.forAddress: any path gives a token name other than the plain one, the same each time", () => {
  fc.assert(
    fc.property(arbAddress, (address) => {
      const cookie = DashboardSessionCookie.forAddress(address);
      assert(TOKEN.test(cookie.name), cookie.name);
      assertNotEquals(cookie.name, PLAIN_DASHBOARD_SESSION_COOKIE);
      assertEquals(DashboardSessionCookie.forAddress(address), cookie);
    }),
  );
});

Deno.test("DashboardSessionCookie.forAddress: two different paths never share a name", () => {
  fc.assert(
    fc.property(arbAddress, arbAddress, (a, b) => {
      const first = DashboardSessionCookie.forAddress(a);
      const second = DashboardSessionCookie.forAddress(b);
      if (first.path !== second.path) {
        assertNotEquals(first.name, second.name);
      }
    }),
  );
});
