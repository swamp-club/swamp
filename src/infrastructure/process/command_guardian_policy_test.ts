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
  getCommandGuardian,
  setCommandGuardian,
} from "./command_guardian_policy.ts";

Deno.test("command guardian policy: nested engine scopes restore ordinary execution", () => {
  const original = setCommandGuardian(undefined);
  try {
    assertEquals(getCommandGuardian(), undefined);
    const first = setCommandGuardian({
      executable: "/trusted/swamp-serve",
      fence: "/private/fence",
    });
    assertEquals(first, undefined);
    assertEquals(
      getCommandGuardian(),
      Deno.build.os === "windows"
        ? undefined
        : { executable: "/trusted/swamp-serve", fence: "/private/fence" },
    );
    const second = setCommandGuardian({
      executable: "/other/swamp-serve",
      fence: "/other/fence",
    });
    assertEquals(second, {
      executable: "/trusted/swamp-serve",
      fence: "/private/fence",
    });
    setCommandGuardian(second);
    setCommandGuardian(first);
    assertEquals(getCommandGuardian(), undefined);
  } finally {
    setCommandGuardian(original);
  }
});
