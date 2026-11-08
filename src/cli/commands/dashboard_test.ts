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
import { UserError } from "../../domain/errors.ts";
import { parsePort } from "./dashboard.ts";

Deno.test("parsePort: no --port takes any free port", () => {
  assertEquals(parsePort(undefined), 0);
});

Deno.test("parsePort: a port from 1 to 65535 is used as given", () => {
  assertEquals(parsePort(1), 1);
  assertEquals(parsePort(8765), 8765);
  assertEquals(parsePort(65535), 65535);
});

Deno.test("parsePort: zero, out of range or fractional is a UserError", () => {
  for (const port of [0, -1, 65536, 80.5, NaN]) {
    assertThrows(() => parsePort(port), UserError, "--port", String(port));
  }
});
