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
import { collectServeExtraArgs } from "./serve.ts";

Deno.test("collectServeExtraArgs: returns empty for defaults", () => {
  const args = collectServeExtraArgs({
    schedule: true,
    grantReload: "manual",
    authMode: "none",
  });
  assertEquals(args, []);
});

Deno.test("collectServeExtraArgs: includes --no-schedule", () => {
  const args = collectServeExtraArgs({ schedule: false });
  assertEquals(args, ["--no-schedule"]);
});

Deno.test("collectServeExtraArgs: includes --grant-reload when not manual", () => {
  const args = collectServeExtraArgs({ grantReload: "auto" });
  assertEquals(args, ["--grant-reload", "auto"]);
});

Deno.test("collectServeExtraArgs: skips --grant-reload when manual", () => {
  const args = collectServeExtraArgs({ grantReload: "manual" });
  assertEquals(args, []);
});

Deno.test("collectServeExtraArgs: includes multiple webhooks", () => {
  const args = collectServeExtraArgs({
    webhook: ["/hooks/a:wf1:secret1", "/hooks/b:wf2:secret2"],
  });
  assertEquals(args, [
    "--webhook",
    "/hooks/a:wf1:secret1",
    "--webhook",
    "/hooks/b:wf2:secret2",
  ]);
});

Deno.test("collectServeExtraArgs: includes --auth-mode when not none", () => {
  const args = collectServeExtraArgs({ authMode: "token" });
  assertEquals(args, ["--auth-mode", "token"]);
});

Deno.test("collectServeExtraArgs: skips --auth-mode none", () => {
  const args = collectServeExtraArgs({ authMode: "none" });
  assertEquals(args, []);
});

Deno.test("collectServeExtraArgs: includes --admins", () => {
  const args = collectServeExtraArgs({ admins: "user:oauth|admin-1" });
  assertEquals(args, ["--admins", "user:oauth|admin-1"]);
});

Deno.test("collectServeExtraArgs: includes OAuth flags", () => {
  const args = collectServeExtraArgs({
    allowedCollectives: "team-a,team-b",
    allowedUsers: "user1,user2",
    oauthProvider: "https://auth.example.com",
    oauthClientId: "client-123",
    groupsField: "groups",
  });
  assertEquals(args, [
    "--allowed-collectives",
    "team-a,team-b",
    "--allowed-users",
    "user1,user2",
    "--oauth-provider",
    "https://auth.example.com",
    "--oauth-client-id",
    "client-123",
    "--groups-field",
    "groups",
  ]);
});

Deno.test("collectServeExtraArgs: includes --trust-proxy", () => {
  const args = collectServeExtraArgs({ trustProxy: true });
  assertEquals(args, ["--trust-proxy"]);
});

Deno.test("collectServeExtraArgs: combines multiple flags", () => {
  const args = collectServeExtraArgs({
    schedule: false,
    authMode: "oauth",
    trustProxy: true,
    admins: "user:oauth|admin-1",
  });
  assertEquals(args, [
    "--no-schedule",
    "--auth-mode",
    "oauth",
    "--admins",
    "user:oauth|admin-1",
    "--trust-proxy",
  ]);
});
