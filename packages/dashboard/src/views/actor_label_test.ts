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
import { actorLabel } from "./actor_label.ts";

const initiatedBy = "user:sub-1";

Deno.test("actorLabel: shows the username and email when both are known", () => {
  assertEquals(
    actorLabel({
      initiatedBy,
      principalUsername: "alice",
      principalEmail: "alice@example.com",
    }),
    "alice <alice@example.com>",
  );
});

Deno.test("actorLabel: shows whichever of username and email is known", () => {
  assertEquals(
    actorLabel({ initiatedBy, principalUsername: "alice" }),
    "alice",
  );
  assertEquals(
    actorLabel({ initiatedBy, principalEmail: "alice@example.com" }),
    "alice@example.com",
  );
});

Deno.test("actorLabel: falls back to initiatedBy when neither is known", () => {
  assertEquals(actorLabel({ initiatedBy }), initiatedBy);
  assertEquals(
    actorLabel({ initiatedBy, principalUsername: "", principalEmail: "" }),
    initiatedBy,
  );
});
