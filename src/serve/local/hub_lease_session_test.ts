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
import { waitFor } from "@swamp-club/swamp-testing";
import { type HubLeaseClient, HubLeaseSession } from "./hub_lease_session.ts";

function fakeClient() {
  const calls: string[] = [];
  let pages: number | null = 0;
  const client: HubLeaseClient = {
    issueLease: (request) => {
      calls.push(`issue ${JSON.stringify(request)}`);
      return Promise.resolve({ id: "lease-1", token: "page-token" });
    },
    setBackend: (id, port) => {
      calls.push(`backend ${id} ${port}`);
      return Promise.resolve();
    },
    renew: (id) => {
      calls.push(`renew ${id}`);
      return Promise.resolve(pages === null ? null : { pages });
    },
    revoke: (id) => {
      calls.push(`revoke ${id}`);
      return Promise.resolve();
    },
  };
  return {
    client,
    calls,
    setPages: (value: number | null) => pages = value,
  };
}

Deno.test("HubLeaseSession: issues, attaches the backend, renews with page counts and revokes on close", async () => {
  const fake = fakeClient();
  const session = await HubLeaseSession.open(fake.client, { scope: "all" }, {
    renewMs: 5,
  });
  assertEquals(session.token, "page-token");
  await session.attachBackend(4321);
  const seen: number[] = [];
  session.onPages((pages) => seen.push(pages));
  fake.setPages(2);
  await waitFor(() => session.pages === 2, "renewal reports two pages");
  await session.close();
  assertEquals(fake.calls[0], `issue {"scope":"all"}`);
  assertEquals(fake.calls[1], "backend lease-1 4321");
  assertEquals(fake.calls.at(-1), "revoke lease-1");
  assertEquals(seen.includes(2), true);
});

Deno.test("HubLeaseSession: a lease the hub forgot is lost and never revoked", async () => {
  const fake = fakeClient();
  fake.setPages(null);
  const session = await HubLeaseSession.open(
    fake.client,
    { scope: "workspace", workspace: "alpha", path: "/repos/alpha" },
    { renewMs: 5 },
  );
  await waitFor(() => session.lost, "the lease is lost");
  await session.close();
  assertEquals(fake.calls.includes("revoke lease-1"), false);
});

Deno.test("HubLeaseSession: closing before the first renewal revokes at once", async () => {
  const fake = fakeClient();
  const session = await HubLeaseSession.open(fake.client, { scope: "all" }, {
    renewMs: 60_000,
  });
  await session.close();
  assertEquals(fake.calls, [`issue {"scope":"all"}`, "revoke lease-1"]);
});
