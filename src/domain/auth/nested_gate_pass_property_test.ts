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
import fc from "fast-check";
import {
  formatNestedGatePass,
  parseNestedGatePass,
} from "./nested_gate_pass.ts";

const passArb = fc.record({
  parentPid: fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
  proof: fc.jsonValue().map((v) => JSON.stringify(v)),
  signature: fc.stringMatching(/^[A-Za-z0-9_-]{1,96}$/),
});

Deno.test("nested gate pass: format then parse is the identity", () => {
  fc.assert(
    fc.property(passArb, (pass) => {
      assertEquals(parseNestedGatePass(formatNestedGatePass(pass)), pass);
    }),
  );
});

Deno.test("nested gate pass: parse never throws on arbitrary input", () => {
  fc.assert(
    fc.property(fc.string(), (value) => {
      const parsed = parseNestedGatePass(value);
      if (parsed !== null) {
        assertEquals(parseNestedGatePass(formatNestedGatePass(parsed)), parsed);
      }
    }),
  );
});
