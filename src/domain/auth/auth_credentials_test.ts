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

import { assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import { keyFingerprint } from "./auth_credentials.ts";

Deno.test("keyFingerprint: matches the swamp-club derivation for a known key", async () => {
  // Test vector from swamp-club lab #2485; not a real credential.
  const key =
    "swamp_TESTKEYabcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl";
  assertEquals(await keyFingerprint(key), "7cba95208c56e033");
});

Deno.test("keyFingerprint: is 16 lowercase hex characters", async () => {
  assertMatch(await keyFingerprint("swamp_anything"), /^[0-9a-f]{16}$/);
});

Deno.test("keyFingerprint: distinguishes keys that share their first 12 characters", async () => {
  const a = await keyFingerprint("swamp_org_abXXXXXXXXXXXXXXXXXXXX");
  const b = await keyFingerprint("swamp_org_abYYYYYYYYYYYYYYYYYYYY");
  assertNotEquals(a, b);
});

Deno.test("keyFingerprint: is stable for the same key", async () => {
  assertEquals(
    await keyFingerprint("swamp_org_abMyToken123"),
    await keyFingerprint("swamp_org_abMyToken123"),
  );
});
