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
import type { OutputMode } from "../../presentation/output/output.ts";
import { inboxPickerApplies } from "./inbox.ts";

Deno.test("inboxPickerApplies: only in log mode with stdin and stdout on a terminal", () => {
  const cases: [OutputMode, boolean, boolean, boolean][] = [
    ["log", true, true, true],
    ["log", true, false, false],
    ["log", false, true, false],
    ["log", false, false, false],
    ["json", true, true, false],
    ["json", true, false, false],
    ["json", false, true, false],
    ["json", false, false, false],
  ];
  for (const [mode, stdinIsTty, stdoutIsTty, expected] of cases) {
    assertEquals(
      inboxPickerApplies(mode, stdinIsTty, stdoutIsTty),
      expected,
      `${mode} stdin=${stdinIsTty} stdout=${stdoutIsTty}`,
    );
  }
});
