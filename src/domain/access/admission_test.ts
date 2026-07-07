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
import { checkAdmission } from "./admission.ts";

Deno.test("checkAdmission: admits user in allowed-users list", () => {
  const result = checkAdmission(
    "user:alice",
    [],
    ["acme-corp"],
    ["user:alice"],
  );
  assertEquals(result.admitted, true);
});

Deno.test("checkAdmission: admits user with matching collective", () => {
  const result = checkAdmission(
    "user:bob",
    ["acme-corp", "dev-team"],
    ["acme-corp"],
    [],
  );
  assertEquals(result.admitted, true);
  assertEquals(
    result.reason,
    "user is a member of allowed collective 'acme-corp'",
  );
});

Deno.test("checkAdmission: rejects user without matching collective", () => {
  const result = checkAdmission(
    "user:charlie",
    ["other-org"],
    ["acme-corp"],
    [],
  );
  assertEquals(result.admitted, false);
});

Deno.test("checkAdmission: rejects user with empty collectives", () => {
  const result = checkAdmission(
    "user:dave",
    [],
    ["acme-corp"],
    [],
  );
  assertEquals(result.admitted, false);
});

Deno.test("checkAdmission: allowed-users takes precedence over collectives", () => {
  const result = checkAdmission(
    "user:eve",
    [],
    ["acme-corp"],
    ["user:eve"],
  );
  assertEquals(result.admitted, true);
  assertEquals(result.reason, "user is in the allowed-users list");
});

Deno.test("checkAdmission: admits any user when no restrictions configured", () => {
  const result = checkAdmission(
    "user:frank",
    ["some-org"],
    [],
    [],
  );
  assertEquals(result.admitted, true);
  assertEquals(result.reason, "no admission restrictions configured");
});

Deno.test("checkAdmission: rejects user not in allowed-users when no collectives configured", () => {
  const result = checkAdmission(
    "user:grace",
    ["some-org"],
    [],
    ["user:admin"],
  );
  assertEquals(result.admitted, false);
  assertEquals(result.reason, "user is not in the allowed-users list");
});

Deno.test("checkAdmission: matches first collective found", () => {
  const result = checkAdmission(
    "user:heidi",
    ["dev-team", "acme-corp"],
    ["acme-corp", "dev-team"],
    [],
  );
  assertEquals(result.admitted, true);
  assertEquals(
    result.reason,
    "user is a member of allowed collective 'dev-team'",
  );
});
