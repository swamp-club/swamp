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
import { formatBytes } from "./download_progress.ts";

Deno.test("formatBytes: whole bytes below 1 KB", () => {
  assertEquals(formatBytes(0), "0 B");
  assertEquals(formatBytes(1023), "1023 B");
});

Deno.test("formatBytes: one decimal place from KB up", () => {
  assertEquals(formatBytes(1536), "1.5 KB");
  assertEquals(formatBytes(124361374), "118.6 MB");
  assertEquals(formatBytes(3 * 1024 ** 3), "3.0 GB");
});
