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

import { assertEquals, assertNotEquals } from "@std/assert";
import { serveCallerFingerprint } from "./checkout_view.ts";
import {
  ACCESS_RESET_COOLDOWN_MS,
  accessResetDue,
  serveUpstreamLocalRoot,
} from "./serve_upstream_binding.ts";

Deno.test("serveUpstreamLocalRoot: one copy per serve and namespace, whatever the token", () => {
  const root = (url: string, ns: string) =>
    serveUpstreamLocalRoot("/repo", url, ns);
  const base = root("http://serve.example.com", "");
  assertEquals(base, root("http://serve.example.com", ""));
  assertNotEquals(base, root("http://serve.example.com", "team"));
  assertNotEquals(base, root("http://other.example.com", ""));
});

Deno.test("serveCallerFingerprint: tells tokens apart without holding them", () => {
  const alice = serveCallerFingerprint("alice.secret");
  assertEquals(alice, serveCallerFingerprint("alice.secret"));
  assertNotEquals(alice, serveCallerFingerprint("bob.secret"));
  assertNotEquals(alice, serveCallerFingerprint(undefined));
  assertEquals(serveCallerFingerprint(undefined), serveCallerFingerprint(""));
  assertEquals(alice.includes("alice"), false);
  assertEquals(alice.length, 64);
});

Deno.test("accessResetDue: resets when serve sent another access, except within the cooldown of the last access reset (swamp-club#4089)", () => {
  const now = 10 * ACCESS_RESET_COOLDOWN_MS;
  // Nothing to compare: an old serve, or a copy not yet read.
  assertEquals(accessResetDue({}, now), "current");
  assertEquals(accessResetDue({ built: "a1" }, now), "current");
  assertEquals(accessResetDue({ built: "a1", seen: "a1" }, now), "current");
  assertEquals(accessResetDue({ built: "a1", seen: "b2" }, now), "reset");
  // Replicas that disagree send two in turn: within the cooldown it waits.
  assertEquals(
    accessResetDue({ built: "a1", seen: "b2", resetAt: now - 1 }, now),
    "cooling",
  );
  assertEquals(
    accessResetDue(
      { built: "a1", seen: "b2", resetAt: now - ACCESS_RESET_COOLDOWN_MS },
      now,
    ),
    "reset",
  );
  // A reset recorded in the future (the clock moved back) holds nothing off.
  assertEquals(
    accessResetDue({ built: "a1", seen: "b2", resetAt: now + 1 }, now),
    "reset",
  );
  assertEquals(
    accessResetDue({ built: "a1", seen: "a1", resetAt: now - 1 }, now),
    "current",
  );
});
