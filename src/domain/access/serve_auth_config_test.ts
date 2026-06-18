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
import { buildServeAuthConfig } from "./serve_auth_config.ts";
import { UserError } from "../errors.ts";

Deno.test("buildServeAuthConfig: mode none with no flags succeeds", () => {
  const config = buildServeAuthConfig({});
  assertEquals(config.mode, "none");
  assertEquals(config.admins, []);
  assertEquals(config.allowedCollectives, []);
  assertEquals(config.allowedUsers, []);
  assertEquals(config.oauthProvider, "https://swamp-club.com");
  assertEquals(config.oauthClientId, undefined);
  assertEquals(config.groupsField, "collectives");
});

Deno.test("buildServeAuthConfig: explicit mode none succeeds", () => {
  const config = buildServeAuthConfig({ authMode: "none" });
  assertEquals(config.mode, "none");
});

Deno.test("buildServeAuthConfig: mode token without admins refuses", () => {
  assertThrows(
    () => buildServeAuthConfig({ authMode: "token" }),
    UserError,
    '--admins is required when --auth-mode is "token"',
  );
});

Deno.test("buildServeAuthConfig: mode token with admins succeeds", () => {
  const config = buildServeAuthConfig({
    authMode: "token",
    admins: "user:oauth|user-123",
  });
  assertEquals(config.mode, "token");
  assertEquals(config.admins, ["user:oauth|user-123"]);
});

Deno.test("buildServeAuthConfig: mode token with multiple admins succeeds", () => {
  const config = buildServeAuthConfig({
    authMode: "token",
    admins: "user:oauth|user-123, user:agent-456",
  });
  assertEquals(config.admins, ["user:oauth|user-123", "user:agent-456"]);
});

Deno.test("buildServeAuthConfig: mode oauth without admins refuses", () => {
  assertThrows(
    () =>
      buildServeAuthConfig({
        authMode: "oauth",
        oauthClientId: "my-client",
      }),
    UserError,
    '--admins is required when --auth-mode is "oauth"',
  );
});

Deno.test("buildServeAuthConfig: mode oauth without client-id refuses", () => {
  assertThrows(
    () =>
      buildServeAuthConfig({
        authMode: "oauth",
        admins: "user:oauth|user-123",
      }),
    UserError,
    '--oauth-client-id is required when --auth-mode is "oauth"',
  );
});

Deno.test("buildServeAuthConfig: mode oauth with all required flags succeeds", () => {
  const config = buildServeAuthConfig({
    authMode: "oauth",
    admins: "user:oauth|user-123",
    oauthClientId: "my-client",
  });
  assertEquals(config.mode, "oauth");
  assertEquals(config.admins, ["user:oauth|user-123"]);
  assertEquals(config.oauthClientId, "my-client");
  assertEquals(config.oauthProvider, "https://swamp-club.com");
  assertEquals(config.groupsField, "collectives");
});

Deno.test("buildServeAuthConfig: mode oauth with all flags succeeds", () => {
  const config = buildServeAuthConfig({
    authMode: "oauth",
    admins: "user:oauth|user-123",
    oauthClientId: "my-client",
    oauthProvider: "https://auth.example.com",
    allowedCollectives: "team-a, team-b",
    allowedUsers: "user:alice, user:bob",
    groupsField: "groups",
  });
  assertEquals(config.mode, "oauth");
  assertEquals(config.oauthProvider, "https://auth.example.com");
  assertEquals(config.oauthClientId, "my-client");
  assertEquals(config.allowedCollectives, ["team-a", "team-b"]);
  assertEquals(config.allowedUsers, ["user:alice", "user:bob"]);
  assertEquals(config.groupsField, "groups");
});

Deno.test("buildServeAuthConfig: invalid auth-mode refuses", () => {
  assertThrows(
    () => buildServeAuthConfig({ authMode: "magic" }),
    UserError,
    'Invalid --auth-mode value "magic"',
  );
});

Deno.test("buildServeAuthConfig: invalid principal format in admins refuses", () => {
  assertThrows(
    () =>
      buildServeAuthConfig({
        authMode: "token",
        admins: "garbage-no-colon",
      }),
    UserError,
    'Invalid --admins value "garbage-no-colon"',
  );
});

Deno.test("buildServeAuthConfig: invalid principal kind in admins refuses", () => {
  assertThrows(
    () =>
      buildServeAuthConfig({
        authMode: "token",
        admins: "sub:oauth|user-123",
      }),
    UserError,
    'Invalid --admins value "sub:oauth|user-123"',
  );
});

Deno.test("buildServeAuthConfig: worker principal kind in admins refuses", () => {
  assertThrows(
    () =>
      buildServeAuthConfig({
        authMode: "token",
        admins: "worker:deploy-bot",
      }),
    UserError,
    'Invalid --admins value "worker:deploy-bot"',
  );
});

Deno.test("buildServeAuthConfig: admins with empty name after colon refuses", () => {
  assertThrows(
    () =>
      buildServeAuthConfig({
        authMode: "token",
        admins: "user:",
      }),
    UserError,
    'Invalid --admins value "user:"',
  );
});

Deno.test("buildServeAuthConfig: default oauth-provider is swamp-club.com", () => {
  const config = buildServeAuthConfig({
    authMode: "oauth",
    admins: "user:oauth|user-123",
    oauthClientId: "client",
  });
  assertEquals(config.oauthProvider, "https://swamp-club.com");
});

Deno.test("buildServeAuthConfig: default groups-field is collectives", () => {
  const config = buildServeAuthConfig({
    authMode: "oauth",
    admins: "user:oauth|user-123",
    oauthClientId: "client",
  });
  assertEquals(config.groupsField, "collectives");
});

Deno.test("buildServeAuthConfig: comma-separated admins trims whitespace", () => {
  const config = buildServeAuthConfig({
    authMode: "token",
    admins: " user:alice , user:bob , user:agent-1 ",
  });
  assertEquals(config.admins, ["user:alice", "user:bob", "user:agent-1"]);
});

Deno.test("buildServeAuthConfig: empty strings in comma list are filtered", () => {
  const config = buildServeAuthConfig({
    authMode: "token",
    admins: "user:alice,,user:bob,",
  });
  assertEquals(config.admins, ["user:alice", "user:bob"]);
});

Deno.test("buildServeAuthConfig: mode none with admins succeeds with warning", () => {
  const config = buildServeAuthConfig({
    authMode: "none",
    admins: "user:oauth|user-123",
  });
  assertEquals(config.mode, "none");
  assertEquals(config.admins, ["user:oauth|user-123"]);
});
