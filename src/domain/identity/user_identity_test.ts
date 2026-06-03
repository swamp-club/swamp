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
import { createUserIdentity } from "./user_identity.ts";

Deno.test("createUserIdentity returns a valid UUID userId", () => {
  const identity = createUserIdentity();
  // UUID v4 format: 8-4-4-4-12 hex characters
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  assertEquals(uuidRegex.test(identity.userId), true);
});

Deno.test("createUserIdentity returns an ISO 8601 createdAt", () => {
  const before = new Date().toISOString();
  const identity = createUserIdentity();
  const after = new Date().toISOString();

  // createdAt should be between before and after
  assertEquals(identity.createdAt >= before, true);
  assertEquals(identity.createdAt <= after, true);
});

Deno.test("createUserIdentity returns unique ids on each call", () => {
  const identity1 = createUserIdentity();
  const identity2 = createUserIdentity();
  assertNotEquals(identity1.userId, identity2.userId);
});
