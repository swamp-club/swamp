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
  scopeMatches,
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
  assertStringIncludes(err.message, "swamp auth login");
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

Deno.test("scopeMatches: exact match", () => {
  assertEquals(scopeMatches("serve:*", "serve:*"), true);
  assertEquals(scopeMatches("vault:*", "vault:*"), true);
  assertEquals(scopeMatches("vault:*", "serve:*"), false);
});

Deno.test("scopeMatches: global wildcard matches everything", () => {
  assertEquals(scopeMatches("*", "serve:*"), true);
  assertEquals(scopeMatches("*", "vault:read"), true);
  assertEquals(scopeMatches("*", "anything"), true);
});

Deno.test("scopeMatches: kind wildcard matches fine-grained scopes", () => {
  assertEquals(scopeMatches("vault:*", "vault:read"), true);
  assertEquals(scopeMatches("vault:*", "vault:write"), true);
  assertEquals(scopeMatches("datastore:*", "datastore:setup"), true);
  assertEquals(scopeMatches("datastore:*", "datastore:read"), true);
});

Deno.test("scopeMatches: kind wildcard does not match different kind", () => {
  assertEquals(scopeMatches("vault:*", "serve:read"), false);
  assertEquals(scopeMatches("datastore:*", "vault:setup"), false);
});

Deno.test("scopeMatches: fine-grained scope does not match wildcard requirement", () => {
  assertEquals(scopeMatches("vault:read", "vault:*"), false);
});

Deno.test("requireScope: wildcard scope satisfies fine-grained gate", () => {
  setCollectiveToken("swamp_org_abc");
  setAuthScopes(["vault:*"]);
  requireScope("vault:read");
  setCollectiveToken("");
  setAuthScopes(undefined);
});

Deno.test("requireScope: global wildcard satisfies any gate", () => {
  setCollectiveToken("swamp_org_abc");
  setAuthScopes(["*"]);
  requireScope("serve:*");
  requireScope("vault:read");
  setCollectiveToken("");
  setAuthScopes(undefined);
});
