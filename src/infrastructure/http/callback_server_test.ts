// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assertEquals, assertExists } from "@std/assert";
import { startCallbackServer } from "./callback_server.ts";

Deno.test("callback server - resolves token on valid callback", async () => {
  const state = crypto.randomUUID();
  const serverUrl = "https://swamp-club.com";
  const server = startCallbackServer(state, serverUrl);
  assertExists(server.port);

  const token = "test-session-token-123";
  const res = await fetch(
    `http://localhost:${server.port}/callback?token=${token}&state=${state}`,
    { redirect: "manual" },
  );

  assertEquals(res.status, 302);
  assertEquals(
    res.headers.get("location"),
    "https://swamp-club.com/cli/success",
  );
  await res.body?.cancel();

  const resolved = await server.token;
  assertEquals(resolved, token);
  await server.shutdown();
});

Deno.test("callback server - rejects mismatched state", async () => {
  const state = crypto.randomUUID();
  const server = startCallbackServer(state, "https://swamp-club.com");

  const res = await fetch(
    `http://localhost:${server.port}/callback?token=tok&state=wrong-state`,
  );

  assertEquals(res.status, 400);
  await res.body?.cancel();
  await server.shutdown();
});

Deno.test("callback server - rejects missing token", async () => {
  const state = crypto.randomUUID();
  const server = startCallbackServer(state, "https://swamp-club.com");

  const res = await fetch(
    `http://localhost:${server.port}/callback?state=${state}`,
  );

  assertEquals(res.status, 400);
  await res.body?.cancel();
  await server.shutdown();
});

Deno.test("callback server - returns 404 for non-callback paths", async () => {
  const state = crypto.randomUUID();
  const server = startCallbackServer(state, "https://swamp-club.com");

  const res = await fetch(`http://localhost:${server.port}/other`);

  assertEquals(res.status, 404);
  await res.body?.cancel();
  await server.shutdown();
});

Deno.test("callback server - allocates a random port", async () => {
  const server = startCallbackServer("test-state", "https://swamp-club.com");
  assertEquals(server.port > 0, true);
  await server.shutdown();
});
