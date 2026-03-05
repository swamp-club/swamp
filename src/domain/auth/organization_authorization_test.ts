// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { isOrganizationAuthorized } from "./organization_authorization.ts";

Deno.test("isOrganizationAuthorized - returns true for matching org", () => {
  assertEquals(
    isOrganizationAuthorized("bogcrew", ["swamplord0", "bogcrew", "marsh-ops"]),
    true,
  );
});

Deno.test("isOrganizationAuthorized - returns true for personal org", () => {
  assertEquals(
    isOrganizationAuthorized("swamplord0", ["swamplord0", "bogcrew"]),
    true,
  );
});

Deno.test("isOrganizationAuthorized - returns false for non-member org", () => {
  assertEquals(
    isOrganizationAuthorized("other-org", ["swamplord0", "bogcrew"]),
    false,
  );
});

Deno.test("isOrganizationAuthorized - returns false for empty org list", () => {
  assertEquals(isOrganizationAuthorized("anything", []), false);
});
