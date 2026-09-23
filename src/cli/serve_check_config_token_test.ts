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

import { assertEquals, assertThrows } from "@std/assert";
import { UserError } from "../domain/errors.ts";
import { selectCheckConfigToken } from "./serve_check_config_token.ts";

const CLUB = "https://swamp-club.com";
const login = { serverUrl: CLUB, apiKey: "swamp_login_key" };

Deno.test("selectCheckConfigToken: prefers SWAMP_API_KEY", () => {
  assertEquals(
    selectCheckConfigToken("https://other.test", "swamp_org_env", login),
    "swamp_org_env",
  );
});

Deno.test("selectCheckConfigToken: uses the stored login for the same origin", () => {
  assertEquals(
    selectCheckConfigToken(`${CLUB}/`, undefined, login),
    "swamp_login_key",
  );
});

Deno.test("selectCheckConfigToken: never sends the stored login to another origin", () => {
  for (
    const provider of [
      "https://evil.test",
      "http://swamp-club.com",
      "https://swamp-club.com:8443",
      "https://sub.swamp-club.com",
    ]
  ) {
    assertThrows(
      () => selectCheckConfigToken(provider, undefined, login),
      UserError,
      "Set SWAMP_API_KEY",
    );
  }
});

Deno.test("selectCheckConfigToken: an empty SWAMP_API_KEY falls back to the login", () => {
  assertEquals(selectCheckConfigToken(CLUB, "", login), "swamp_login_key");
});

Deno.test("selectCheckConfigToken: fails without any credential", () => {
  assertThrows(
    () => selectCheckConfigToken(CLUB, undefined, null),
    UserError,
    "Run 'swamp auth login'",
  );
});
