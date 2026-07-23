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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  isAuthenticated,
  requireAuthenticated,
  requireScope,
  setAuthenticated,
  setAuthScopes,
  setCollectiveToken,
} from "./auth_context.ts";
import { UserError } from "../domain/errors.ts";

Deno.test("auth_context: defaults to not authenticated", () => {
  setAuthenticated(false);
  assertEquals(isAuthenticated(), false);
});

Deno.test("auth_context: setAuthenticated true makes isAuthenticated return true", () => {
  setAuthenticated(true);
  assertEquals(isAuthenticated(), true);
  setAuthenticated(false);
});

Deno.test("auth_context: setAuthenticated false makes isAuthenticated return false", () => {
  setAuthenticated(true);
  setAuthenticated(false);
  assertEquals(isAuthenticated(), false);
});

Deno.test("requireAuthenticated: throws UserError when not authenticated", () => {
  setAuthenticated(false);
  const err = assertThrows(
    () => requireAuthenticated("swamp serve is a team feature", "serve:*"),
    UserError,
  );
  assertEquals(err.code, "auth_required");
  assertStringIncludes(
    err.message,
    "swamp serve is a team feature that requires a free swamp-club.com account",
  );
  assertStringIncludes(err.message, "swamp auth login");
  assertStringIncludes(err.message, "SWAMP_API_KEY");
  assertStringIncludes(err.message, "serve:*");
});

Deno.test("requireAuthenticated: does not throw when authenticated", () => {
  setAuthenticated(true);
  requireAuthenticated("swamp serve is a team feature", "serve:*");
  setAuthenticated(false);
});

Deno.test("requireScope: passes for personal token (not collective)", () => {
  setCollectiveToken("swamp_personal_abc");
  setAuthScopes(undefined);
  requireScope("serve:*");
});

Deno.test("requireScope: passes when collective token has required scope", () => {
  setCollectiveToken("swamp_org_abc");
  setAuthScopes(["serve:*", "datastore:*"]);
  requireScope("serve:*");
  setCollectiveToken("");
  setAuthScopes(undefined);
});

Deno.test("requireScope: throws when collective token lacks scope", () => {
  setCollectiveToken("swamp_org_abc");
  setAuthScopes(["datastore:*"]);
  const err = assertThrows(
    () => requireScope("serve:*"),
    UserError,
  );
  assertEquals(err.code, "missing_scope");
  assertStringIncludes(err.message, "serve:*");
  assertStringIncludes(err.message, "swamp-club.com");
  setCollectiveToken("");
  setAuthScopes(undefined);
});

Deno.test("requireScope: throws when collective token has empty scopes", () => {
  setCollectiveToken("swamp_org_abc");
  setAuthScopes([]);
  assertThrows(
    () => requireScope("vault:*"),
    UserError,
  );
  setCollectiveToken("");
  setAuthScopes(undefined);
});

Deno.test("requireScope: throws when collective token has undefined scopes (whoami failed)", () => {
  setCollectiveToken("swamp_org_abc");
  setAuthScopes(undefined);
  assertThrows(
    () => requireScope("serve:*"),
    UserError,
  );
  setCollectiveToken("");
});
