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
import { dashboardUrl, hubStopSignals } from "./start.ts";

Deno.test("hubStopSignals: swamp start stops on SIGTERM and SIGHUP with their exit codes", () => {
  assertEquals(hubStopSignals("linux", false), [
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ]);
});

Deno.test("hubStopSignals: swamp dashboard ignores SIGHUP and still stops on SIGTERM", () => {
  for (const os of ["linux", "darwin"] as const) {
    assertEquals(hubStopSignals(os, true), [
      ["SIGTERM", 143],
      ["SIGHUP", null],
    ]);
  }
});

Deno.test("hubStopSignals: nothing on Windows, which has neither signal", () => {
  assertEquals(hubStopSignals("windows", true), []);
  assertEquals(hubStopSignals("windows", false), []);
});

Deno.test("dashboardUrl: the repo's page on the given origin, with the token in the fragment", () => {
  assertEquals(
    dashboardUrl("https://box.tail1.ts.net", "tok", "my repo"),
    "https://box.tail1.ts.net/dashboard/w/my%20repo#token=tok",
  );
});
