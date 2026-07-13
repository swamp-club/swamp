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
import { isFirstRunNudge, shouldShowAuthNudge } from "./auth_nudge.ts";

Deno.test("shouldShowAuthNudge: returns true when no lastShown", () => {
  assertEquals(shouldShowAuthNudge({}), true);
});

Deno.test("shouldShowAuthNudge: returns true when firstRunShown is false and no lastShown", () => {
  assertEquals(shouldShowAuthNudge({ firstRunShown: false }), true);
});

Deno.test("shouldShowAuthNudge: returns true when lastShown is over 24 hours ago", () => {
  const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  assertEquals(
    shouldShowAuthNudge({ lastShown: twoDaysAgo, firstRunShown: true }),
    true,
  );
});

Deno.test("shouldShowAuthNudge: returns false when lastShown is within 24 hours", () => {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  assertEquals(
    shouldShowAuthNudge({ lastShown: oneHourAgo, firstRunShown: true }),
    false,
  );
});

Deno.test("shouldShowAuthNudge: returns true when lastShown is exactly 24 hours ago", () => {
  const exactly24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  assertEquals(
    shouldShowAuthNudge({ lastShown: exactly24h, firstRunShown: true }),
    true,
  );
});

Deno.test("isFirstRunNudge: returns true when firstRunShown is undefined", () => {
  assertEquals(isFirstRunNudge({}), true);
});

Deno.test("isFirstRunNudge: returns true when firstRunShown is false", () => {
  assertEquals(isFirstRunNudge({ firstRunShown: false }), true);
});

Deno.test("isFirstRunNudge: returns false when firstRunShown is true", () => {
  assertEquals(isFirstRunNudge({ firstRunShown: true }), false);
});
