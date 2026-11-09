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

import fc from "fast-check";
import { assertEquals } from "@std/assert";
import { checkAdmission, checkPrincipalAdmission } from "./admission.ts";

const name = fc.stringMatching(/^[a-z0-9-]{1,8}$/);

Deno.test("checkPrincipalAdmission: decides exactly as login does for the same sub and collectives", () => {
  fc.assert(
    fc.property(
      name,
      fc.array(name, { maxLength: 4 }),
      fc.array(name, { maxLength: 4 }),
      fc.array(name, { maxLength: 4 }),
      (sub, collectives, allowedCollectives, allowedUsers) => {
        assertEquals(
          checkPrincipalAdmission(`user:${sub}`, collectives, {
            allowedCollectives,
            allowedUsers,
          }),
          checkAdmission(sub, collectives, allowedCollectives, allowedUsers),
        );
      },
    ),
  );
});
