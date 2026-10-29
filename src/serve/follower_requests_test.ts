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
  FOLLOWER_FORWARDED_REQUESTS,
  FOLLOWER_READ_REQUESTS,
  type FollowerGate,
  followerHttpForward,
  followerHttpRefusal,
  followerRefusal,
} from "./follower_requests.ts";
import { LeaderLink } from "./leader_link.ts";

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

function forwardingLink(calls: string[]): LeaderLink {
  return new LeaderLink({
    leader: () => ({ ...leader, address: "http://10.0.0.2:9090" }),
    createClient: () => undefined,
    fetch: (input) => {
      calls.push(String(input));
      return Promise.resolve(new Response("from the leader", { status: 200 }));
    },
  });
}

Deno.test("followerHttpForward: a leader answers itself; a follower passes a write on to the leader", async () => {
  const calls: string[] = [];
  const req = () =>
    new Request("http://lb.example/api/v1/cancel/workflow-run/r1", {
      method: "POST",
    });
  assertEquals(
    followerHttpForward("workflow.cancel", req(), {
      followerGate: gate("leader"),
      leaderLink: forwardingLink(calls),
    }),
    undefined,
  );
  const reply = await followerHttpForward("workflow.cancel", req(), {
    followerGate: gate("follower"),
    leaderLink: forwardingLink(calls),
  });
  assertEquals(reply?.status, 200);
  assertEquals(await reply?.text(), "from the leader");
  assertEquals(calls, ["http://10.0.0.2:9090/api/v1/cancel/workflow-run/r1"]);
});

Deno.test("followerHttpForward: without a route to the leader, or for a stale read, it refuses", async () => {
  const calls: string[] = [];
  const refused = await followerHttpForward(
    "workflow.cancel",
    new Request("http://lb.example/x", { method: "POST" }),
    { followerGate: gate("follower") },
  );
  assertEquals(refused?.status, 503);
  const stale = await followerHttpForward(
    "data.get",
    new Request("http://lb.example/x"),
    { followerGate: gate("follower", true), leaderLink: forwardingLink(calls) },
  );
  assertEquals(stale?.status, 503);
  assertEquals(calls, []);
});

Deno.test("follower requests: attaching to a run goes to the leader, the commit feed is answered here", () => {
  assertEquals(FOLLOWER_FORWARDED_REQUESTS.has("run.attach"), true);
  assertEquals(FOLLOWER_READ_REQUESTS.has("run.attach"), false);
  assertEquals(FOLLOWER_READ_REQUESTS.has("commits.subscribe"), true);
  assertEquals(FOLLOWER_READ_REQUESTS.has("commits.head"), true);
});
