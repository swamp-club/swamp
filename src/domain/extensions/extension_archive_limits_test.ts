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
import {
  formatArchiveBytes,
  MAX_EXTENSION_ARCHIVE_BYTES,
} from "./extension_archive_limits.ts";

Deno.test("formatArchiveBytes: prints whole MiB without a decimal", () => {
  assertEquals(formatArchiveBytes(MAX_EXTENSION_ARCHIVE_BYTES), "50 MiB");
});

Deno.test("formatArchiveBytes: rounds up so a size over a limit never prints as the limit", () => {
  assertEquals(formatArchiveBytes(MAX_EXTENSION_ARCHIVE_BYTES + 1), "50.1 MiB");
  assertEquals(formatArchiveBytes(1.5 * 1024 * 1024), "1.5 MiB");
});
