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
import { isLoopbackHost } from "./loopback.ts";

Deno.test("isLoopbackHost: loopback names and addresses only", () => {
  for (const host of ["localhost", "127.0.0.1", "127.9.9.9", "::1", "[::1]"]) {
    assertEquals(isLoopbackHost(host), true, host);
  }
  for (
    const host of [
      "0.0.0.0",
      "10.0.0.1",
      "127.0.0.1.example.com",
      "::",
      "127.0.0.256",
    ]
  ) {
    assertEquals(isLoopbackHost(host), false, host);
  }
});
