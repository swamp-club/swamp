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
import { reloadsOnHangup } from "./reload_on_hangup.ts";

Deno.test("reloadsOnHangup: a terminal serve without --hot-reload shuts down on SIGHUP", () => {
  assertEquals(
    reloadsOnHangup({ os: "linux", hotReload: false, stdinIsTerminal: true }),
    false,
  );
});

Deno.test("reloadsOnHangup: a daemon, a container or a --hot-reload serve reloads on SIGHUP", () => {
  assertEquals(
    reloadsOnHangup({ os: "linux", hotReload: false, stdinIsTerminal: false }),
    true,
  );
  assertEquals(
    reloadsOnHangup({ os: "darwin", hotReload: true, stdinIsTerminal: true }),
    true,
  );
});

Deno.test("reloadsOnHangup: never on Windows, which has no SIGHUP", () => {
  assertEquals(
    reloadsOnHangup({ os: "windows", hotReload: true, stdinIsTerminal: false }),
    false,
  );
});
