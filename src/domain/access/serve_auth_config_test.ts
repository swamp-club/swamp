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

Deno.test("buildServeAuthConfig: mode oauth without admission restrictions refuses", () => {
  assertThrows(
    () =>
      buildServeAuthConfig({
        authMode: "oauth",
        admins: "swampadmin",
      }),
    UserError,
    "--allowed-collectives or --allowed-users is required",
  );
});

Deno.test("buildServeAuthConfig: mode oauth without client-id succeeds for auto-registration", () => {
  const config = buildServeAuthConfig({
    authMode: "oauth",
    admins: "swampadmin",
    allowedCollectives: "acme-corp",
  });
  assertEquals(config.mode, "oauth");
  assertEquals(config.oauthClientId, undefined);
});

Deno.test("buildServeAuthConfig: mode oauth with allowed-collectives succeeds", () => {
  const config = buildServeAuthConfig({
    authMode: "oauth",
    admins: "swampadmin",
    allowedCollectives: "acme-corp",
  });
  assertEquals(config.mode, "oauth");
  assertEquals(config.allowedCollectives, ["acme-corp"]);
});

Deno.test("buildServeAuthConfig: mode oauth with allowed-users succeeds", () => {
  const config = buildServeAuthConfig({
    authMode: "oauth",
    admins: "swampadmin",
    allowedUsers: "user:alice",
  });
  assertEquals(config.mode, "oauth");
  assertEquals(config.allowedUsers, ["user:alice"]);
});

Deno.test("buildServeAuthConfig: mode oauth with all required flags succeeds", () => {
  const config = buildServeAuthConfig({
    authMode: "oauth",
    admins: "swampadmin",
    oauthClientId: "my-client",
    allowedCollectives: "acme-corp",
  });
  assertEquals(config.mode, "oauth");
  assertEquals(config.admins, ["swampadmin"]);
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
    admins: "swampadmin",
    allowedCollectives: "acme-corp",
  });
  assertEquals(config.oauthProvider, "https://swamp-club.com");
});

Deno.test("buildServeAuthConfig: default groups-field is collectives", () => {
  const config = buildServeAuthConfig({
    authMode: "oauth",
    admins: "swampadmin",
    allowedCollectives: "acme-corp",
  });
  assertEquals(config.groupsField, "collectives");
});

Deno.test("buildServeAuthConfig: mode oauth rejects HTTP provider", () => {
  assertThrows(
    () =>
      buildServeAuthConfig({
        authMode: "oauth",
        admins: "swampadmin",
        allowedCollectives: "acme-corp",
        oauthProvider: "http://evil.example.com",
      }),
    UserError,
    "--oauth-provider must use HTTPS",
  );
});

Deno.test("buildServeAuthConfig: mode oauth allows HTTP for localhost", () => {
  const config = buildServeAuthConfig({
    authMode: "oauth",
    admins: "swampadmin",
    allowedCollectives: "acme-corp",
    oauthProvider: "http://localhost:8000",
  });
  assertEquals(config.oauthProvider, "http://localhost:8000");
});

Deno.test("buildServeAuthConfig: mode token without admission restrictions succeeds", () => {
  const config = buildServeAuthConfig({
    authMode: "token",
    admins: "user:oauth|user-123",
  });
  assertEquals(config.mode, "token");
  assertEquals(config.allowedCollectives, []);
  assertEquals(config.allowedUsers, []);
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
