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

import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  BOOT_TIME_TOLERANCE_MS,
  currentBootIdentity,
  sameBoot,
} from "./boot_identity.ts";

Deno.test("currentBootIdentity: names this boot the same way each time", () => {
  const first = currentBootIdentity();
  assertMatch(first, /^(boot-id:.+|boot-time:-?\d+)$/);
  assert(sameBoot(first, currentBootIdentity()));
});

Deno.test("sameBoot: boot ids match only exactly", () => {
  assert(sameBoot("boot-id:a", "boot-id:a"));
  assertEquals(sameBoot("boot-id:a", "boot-id:b"), false);
});

Deno.test("sameBoot: boot times match within the tolerance", () => {
  assert(
    sameBoot("boot-time:1000", `boot-time:${1000 + BOOT_TIME_TOLERANCE_MS}`),
  );
  assertEquals(
    sameBoot("boot-time:1000", `boot-time:${1001 + BOOT_TIME_TOLERANCE_MS}`),
    false,
  );
});

Deno.test("sameBoot: identities of different kinds or unreadable ones are different boots", () => {
  assertEquals(sameBoot("boot-id:1000", "boot-time:1000"), false);
  assertEquals(sameBoot("boot-time:x", "boot-time:x1"), false);
  assertEquals(sameBoot("", "boot-time:0"), false);
});
