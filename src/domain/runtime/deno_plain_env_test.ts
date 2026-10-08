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
import { plainDenoEnv } from "./deno_plain_env.ts";

Deno.test("plainDenoEnv: overrides FORCE_COLOR with an empty value at any setting", () => {
  for (const value of ["3", "1", "0", "true"]) {
    assertEquals(plainDenoEnv({ FORCE_COLOR: value }), {
      NO_COLOR: "1",
      FORCE_COLOR: "",
    });
  }
});

Deno.test("plainDenoEnv: sets an empty FORCE_COLOR when the base has none", () => {
  // The child inherits the parent's FORCE_COLOR unless the record names it.
  assertEquals(plainDenoEnv({}), { NO_COLOR: "1", FORCE_COLOR: "" });
});

Deno.test("plainDenoEnv: drops other casings of FORCE_COLOR", () => {
  assertEquals(plainDenoEnv({ Force_Color: "3", force_color: "1" }), {
    NO_COLOR: "1",
    FORCE_COLOR: "",
  });
});

Deno.test("plainDenoEnv: sets NO_COLOR over an inherited value", () => {
  assertEquals(plainDenoEnv({ NO_COLOR: "" }).NO_COLOR, "1");
});

Deno.test("plainDenoEnv: keeps every other variable", () => {
  assertEquals(
    plainDenoEnv({ PATH: "/usr/bin", DENO_DIR: "/cache", FORCE_COLOR: "3" }),
    { PATH: "/usr/bin", DENO_DIR: "/cache", NO_COLOR: "1", FORCE_COLOR: "" },
  );
});

Deno.test("plainDenoEnv: does not mutate the base environment", () => {
  const base = { PATH: "/usr/bin", FORCE_COLOR: "3" };
  plainDenoEnv(base);
  assertEquals(base, { PATH: "/usr/bin", FORCE_COLOR: "3" });
});
