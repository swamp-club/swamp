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

import { assertEquals, assertInstanceOf } from "@std/assert";
import { ServeNotLeaderError } from "../domain/datastore_v3/serve_leader.ts";
import {
  type FollowerGate,
  followerHttpRefusal,
  followerRefusal,
} from "./follower_requests.ts";

const leader = {
  instanceId: "lead",
  fence: 2,
  since: "2026-10-28T12:00:00.000Z",
};

function gate(role: "leader" | "follower", stale = false): FollowerGate {
  return { role, leader: () => leader, isStale: () => stale };
}

Deno.test("followerRefusal: a leader, or serve outside team mode, refuses nothing", () => {
  assertEquals(followerRefusal("workflow.run", undefined), undefined);
  assertEquals(followerRefusal("workflow.run", gate("leader")), undefined);
});

Deno.test("followerRefusal: a follower refuses writes and runs, naming the leader", () => {
  for (const type of ["workflow.run", "model.method.run", "vault.put"]) {
    const refusal = followerRefusal(type, gate("follower"));
    assertInstanceOf(refusal, ServeNotLeaderError);
    assertEquals(refusal.leader, leader);
  }
});

Deno.test("followerRefusal: a follower refuses a request it does not know", () => {
  assertInstanceOf(
    followerRefusal("some.future.request", gate("follower")),
    ServeNotLeaderError,
  );
});

Deno.test("followerRefusal: a follower answers reads until its copy is stale", () => {
  assertEquals(followerRefusal("data.get", gate("follower")), undefined);
  const stale = followerRefusal("data.get", gate("follower", true));
  assertInstanceOf(stale, ServeNotLeaderError);
  assertEquals(stale.message.includes("its copy is behind"), true);
  assertEquals(
    followerRefusal("server.version", gate("follower", true)),
    undefined,
  );
});

Deno.test("followerHttpRefusal: a retryable 503 naming the leader on a follower, nothing on a leader", async () => {
  assertEquals(
    followerHttpRefusal("workflow.cancel", gate("leader")),
    undefined,
  );
  const refused = followerHttpRefusal("workflow.cancel", gate("follower"))!;
  assertEquals(refused.status, 503);
  assertEquals(refused.headers.get("retry-after"), "5");
  const body = await refused.json();
  assertEquals(body.code, "serve_not_leader");
  assertEquals(body.leader, leader);
});
