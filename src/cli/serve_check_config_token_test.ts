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
import {
  type CheckConfigCredential,
  selectCheckConfigToken,
} from "./serve_check_config_token.ts";

const CLUB = "https://swamp-club.com";
const login: CheckConfigCredential = {
  serverUrl: CLUB,
  apiKey: "swamp_login_key",
  source: "login",
};
const envKey: CheckConfigCredential = {
  serverUrl: CLUB,
  apiKey: "swamp_org_env",
  source: "env",
};

const OTHER_ORIGINS = [
  "https://evil.test",
  "http://swamp-club.com",
  "https://swamp-club.com:8443",
  "https://sub.swamp-club.com",
];

Deno.test("selectCheckConfigToken: sends a credential to the origin that issued it", () => {
  assertEquals(selectCheckConfigToken(`${CLUB}/`, login), "swamp_login_key");
  assertEquals(selectCheckConfigToken(CLUB, envKey), "swamp_org_env");
});

Deno.test("selectCheckConfigToken: never sends the stored login to another origin", () => {
  for (const provider of OTHER_ORIGINS) {
    assertThrows(
      () => selectCheckConfigToken(provider, login),
      UserError,
      "You are logged in to https://swamp-club.com",
    );
  }
});

Deno.test("selectCheckConfigToken: never sends SWAMP_API_KEY to another origin", () => {
  for (const provider of OTHER_ORIGINS) {
    assertThrows(
      () => selectCheckConfigToken(provider, envKey),
      UserError,
      "SWAMP_API_KEY is a credential for https://swamp-club.com",
    );
  }
});

Deno.test("selectCheckConfigToken: a key for a custom provider works when SWAMP_CLUB_URL points at it", () => {
  assertEquals(
    selectCheckConfigToken("https://idp.example.com/", {
      ...envKey,
      serverUrl: "https://idp.example.com",
    }),
    "swamp_org_env",
  );
});

Deno.test("selectCheckConfigToken: fails without any credential", () => {
  assertThrows(
    () => selectCheckConfigToken(CLUB, null),
    UserError,
    "Run 'swamp auth login'",
  );
});

Deno.test("selectCheckConfigToken: a malformed stored server URL is a UserError", () => {
  assertThrows(
    () => selectCheckConfigToken(CLUB, { ...login, serverUrl: "not a url" }),
    UserError,
    'Invalid swamp-club server URL "not a url"',
  );
});
