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

import { assertEquals, assertRejects } from "@std/assert";
import {
  createDashboardSessionClient,
  DASHBOARD_SESSION_PATH,
} from "./dashboard_session.ts";

Deno.test("createDashboardSessionClient: restores only an accepted cookie session", async () => {
  const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
  const client = createDashboardSessionClient((input, init) => {
    calls.push({ input, init });
    return Promise.resolve(new Response(null, { status: 200 }));
  });

  assertEquals(await client.restore(), true);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].input, DASHBOARD_SESSION_PATH);
  assertEquals(calls[0].init?.signal instanceof AbortSignal, true);
});

Deno.test("createDashboardSessionClient: reports an absent or revoked session", async () => {
  const client = createDashboardSessionClient(() =>
    Promise.resolve(new Response(null, { status: 401 }))
  );
  assertEquals(await client.restore(), false);
});

Deno.test("createDashboardSessionClient: retries restoration after a transient response", async () => {
  const client = createDashboardSessionClient(() =>
    Promise.resolve(new Response(null, { status: 503 }))
  );

  await assertRejects(
    () => client.restore(),
    Error,
    "Could not restore dashboard session",
  );
});

Deno.test("createDashboardSessionClient: exchanges a manually entered token only with the session endpoint", async () => {
  let seen: RequestInit | undefined;
  const client = createDashboardSessionClient((_input, init) => {
    seen = init;
    return Promise.resolve(new Response(null, { status: 204 }));
  });

  assertEquals(await client.exchange("admin.secret"), true);
  assertEquals(seen?.method, "POST");
  assertEquals(seen?.headers, { "content-type": "application/json" });
  assertEquals(seen?.body, JSON.stringify({ token: "admin.secret" }));
  assertEquals(seen?.signal instanceof AbortSignal, true);
});

Deno.test("createDashboardSessionClient: clears the cookie session without a credential", async () => {
  let seen: RequestInit | undefined;
  const client = createDashboardSessionClient((_input, init) => {
    seen = init;
    return Promise.resolve(new Response(null, { status: 204 }));
  });

  await client.clear();
  assertEquals(seen?.method, "DELETE");
  assertEquals(seen?.signal instanceof AbortSignal, true);
});

Deno.test("createDashboardSessionClient: describes an origin rejection to the login form", async () => {
  const client = createDashboardSessionClient(() =>
    Promise.resolve(new Response(null, { status: 403 }))
  );
  await assertRejects(
    () => client.exchange("admin.secret"),
    Error,
    "origin check",
  );
});
