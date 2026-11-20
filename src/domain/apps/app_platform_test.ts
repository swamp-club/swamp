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
import {
  PlatformFieldSchema,
  platformRefusal,
  platformRequirement,
} from "./app_platform.ts";

Deno.test("platformRequirement: a major alone needs nothing past its first minor", () => {
  assertEquals(platformRequirement(1), { major: 1, minor: 0 });
  assertEquals(platformRequirement("1.4"), { major: 1, minor: 4 });
});

Deno.test("PlatformFieldSchema: only a major or a major.minor", () => {
  assertEquals(PlatformFieldSchema.safeParse("1.4").success, true);
  for (const bad of ["1.4.2", "v1", "0", 0, 1.5, "^1"]) {
    assertEquals(
      PlatformFieldSchema.safeParse(bad).success,
      false,
      String(bad),
    );
  }
});

Deno.test("platformRefusal: says what to do for each mismatch", () => {
  const held = [{ major: 1, minor: 3 }, { major: 2, minor: 0 }];
  assertEquals(platformRefusal({ major: 1, minor: 2 }, held), null);
  assertStringIncludes(
    platformRefusal({ major: 1, minor: 4 }, held) ?? "",
    "has 1.3. Upgrade swamp.",
  );
  assertStringIncludes(
    platformRefusal({ major: 3, minor: 0 }, held) ?? "",
    "does not have",
  );
  assertStringIncludes(
    platformRefusal({ major: 1, minor: 0 }, [{ major: 2, minor: 0 }]) ?? "",
    "Rebuild it against platform 2",
  );
});

Deno.test("platformRefusal: a build without any platform says so instead of asking for an upgrade", () => {
  const refusal = platformRefusal({ major: 1, minor: 4 }, []) ?? "";
  assertStringIncludes(refusal, "this swamp build has no app platform");
  assertEquals(refusal.includes("Upgrade swamp"), false);
});
