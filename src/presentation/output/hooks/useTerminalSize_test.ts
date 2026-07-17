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
import { getTerminalDimensions } from "./useTerminalSize.ts";

Deno.test("getTerminalDimensions: falls back to stdout properties when Deno.consoleSize() throws", () => {
  const fakeStdout = {
    columns: 120,
    rows: 40,
  } as unknown as NodeJS.WriteStream;
  // In test environments Deno.consoleSize() throws (no TTY), so the function
  // should fall back to stdout properties.
  const size = getTerminalDimensions(fakeStdout);
  assertEquals(size.width, 120);
  assertEquals(size.height, 40);
});

Deno.test("getTerminalDimensions: falls back to defaults when stdout is undefined", () => {
  const size = getTerminalDimensions(undefined);
  assertEquals(size.width, 80);
  assertEquals(size.height, 24);
});

Deno.test("getTerminalDimensions: falls back to defaults when stdout has no columns/rows", () => {
  const fakeStdout = {} as unknown as NodeJS.WriteStream;
  const size = getTerminalDimensions(fakeStdout);
  assertEquals(size.width, 80);
  assertEquals(size.height, 24);
});
