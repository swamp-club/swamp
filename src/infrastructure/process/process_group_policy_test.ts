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
  resolveProcessGroupIsolation,
  setProcessGroupIsolation,
  shouldIsolateProcessGroup,
} from "./process_group_policy.ts";

Deno.test("resolveProcessGroupIsolation: auto isolates only without a controlling terminal", () => {
  assertEquals(
    resolveProcessGroupIsolation({
      mode: "auto",
      os: "linux",
      hasControllingTerminal: () => true,
    }),
    false,
  );
  assertEquals(
    resolveProcessGroupIsolation({
      mode: "auto",
      os: "darwin",
      hasControllingTerminal: () => false,
    }),
    true,
  );
});

Deno.test("resolveProcessGroupIsolation: always isolates even with a controlling terminal", () => {
  let probed = false;
  assertEquals(
    resolveProcessGroupIsolation({
      mode: "always",
      os: "linux",
      hasControllingTerminal: () => {
        probed = true;
        return true;
      },
    }),
    true,
  );
  assertEquals(probed, false, "always must not probe the terminal");
});

Deno.test("resolveProcessGroupIsolation: never isolates on Windows", () => {
  for (const mode of ["auto", "always"] as const) {
    assertEquals(
      resolveProcessGroupIsolation({
        mode,
        os: "windows",
        hasControllingTerminal: () => false,
      }),
      false,
    );
  }
});

Deno.test("setProcessGroupIsolation: returns the previous policy", () => {
  const original = setProcessGroupIsolation("always");
  try {
    assertEquals(setProcessGroupIsolation("auto"), "always");
    assertEquals(setProcessGroupIsolation("always"), "auto");
    assertEquals(
      shouldIsolateProcessGroup(),
      Deno.build.os !== "windows",
    );
  } finally {
    setProcessGroupIsolation(original);
  }
});
