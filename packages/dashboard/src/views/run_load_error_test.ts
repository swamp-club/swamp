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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { runUnreadableHint } from "./run_load_error.ts";

Deno.test("runUnreadableHint: serve keeps its wording", () => {
  assertEquals(
    runUnreadableHint(false),
    "Step-level detail is only available for runs swamp serve can read; a run executed with the CLI elsewhere may not be visible here.",
  );
});

Deno.test("runUnreadableHint: the local dashboard points at this repo, not swamp serve", () => {
  const hint = runUnreadableHint(true);
  assertStringIncludes(hint, "recorded in this repo");
  assertEquals(hint.includes("swamp serve can read"), false);
});
