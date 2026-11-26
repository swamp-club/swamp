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
import { InstanceId, InstanceIdError, normalizedUuid } from "./instance_id.ts";

Deno.test("InstanceId.create: accepts a UUID and lower-cases it", () => {
  const id = crypto.randomUUID();
  assertEquals(InstanceId.create(id).value, id);
  assertEquals(InstanceId.create(id.toUpperCase()).value, id);
  assertEquals(
    InstanceId.create(id).equals(InstanceId.create(id.toUpperCase())),
    true,
  );
});

Deno.test("InstanceId.create: refuses anything that is not a UUID, path forms included", () => {
  for (
    const value of [
      "",
      "../etc",
      `${crypto.randomUUID()}/..`,
      `../${crypto.randomUUID()}`,
      "not-a-uuid",
      `${crypto.randomUUID()} `,
      42,
      null,
    ]
  ) {
    assertThrows(() => InstanceId.create(value), InstanceIdError);
    assertEquals(InstanceId.isValid(value), false);
  }
});

Deno.test("normalizedUuid: undefined for non-strings", () => {
  assertEquals(normalizedUuid({}), undefined);
});
