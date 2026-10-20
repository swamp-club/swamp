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
import { InputRecordSchema } from "./input_record.ts";

Deno.test("InputRecordSchema: preserves own prototype-named keys without changing prototypes", () => {
  const inputs: Record<string, unknown> = JSON.parse(
    '{"__proto__":{"nested":{"__proto__":"value"}},"constructor":"c","prototype":"p"}',
  );
  const parsed = InputRecordSchema.parse(inputs);
  assertEquals(parsed, inputs);
  assertEquals(Object.getPrototypeOf(parsed), Object.prototype);
  assertEquals(Object.hasOwn(parsed, "__proto__"), true);
});

Deno.test("InputRecordSchema: accepts null-prototype records and rejects non-record values", () => {
  const inputs = Object.assign(Object.create(null), { key: "value" });
  assertEquals(InputRecordSchema.parse(inputs), { key: "value" });
  for (
    const value of [undefined, null, "input", 1, [], new Date(), new Map()]
  ) {
    assertEquals(InputRecordSchema.safeParse(value).success, false);
  }
});
