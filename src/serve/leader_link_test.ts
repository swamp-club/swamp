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

import { assert, assertEquals } from "@std/assert";
import type { ServeLeader } from "../domain/datastore_v3/serve_leader.ts";
import {
  forwardedHeaders,
  forwardNeverSent,
  LeaderLink,
  leaderTarget,
  notLeaderResponse,
} from "./leader_link.ts";
import { ServeNotLeaderError } from "../domain/datastore_v3/serve_leader.ts";
import { serveErrorFromReply } from "../infrastructure/datastore_v3/serve_upstream_errors.ts";
import { TEAM_PEER_HEADER } from "./peer_auth.ts";
import { withSpan } from "../infrastructure/tracing/tracer.ts";
import {
  findSpan,
  withCapturedSpans,
} from "../infrastructure/tracing/span_test_helpers.ts";

const LEADER: ServeLeader = {
  instanceId: "instance-a",
  fence: 3,
  address: "https://node-a.internal:9090",
  since: "2026-10-29T00:00:00.000Z",
};

function link(
  fetchImpl: typeof fetch,
  leader: ServeLeader | undefined = LEADER,
): LeaderLink {
  return new LeaderLink({
    leader: () => leader,
    createClient: () => undefined,
    fetch: fetchImpl,
  });
}

Deno.test("forwardNeverSent: connect, DNS and TLS failures never left the node; anything else may have", () => {
  assert(
    forwardNeverSent(new TypeError("tcp connect error: Connection refused")),
  );
  assert(forwardNeverSent(
    new TypeError("error sending request", {
      cause: new Error("dns error: failed to lookup address"),
    }),
  ));
  assert(
    forwardNeverSent(new TypeError("invalid peer certificate: UnknownIssuer")),
  );
  assert(
    !forwardNeverSent(
      new TypeError("connection closed before message completed"),
    ),
  );
  assert(!forwardNeverSent(new Error("connection reset by peer")));
  assert(!forwardNeverSent("not an error"));
});

Deno.test("forwardedHeaders: a caller's own X-Forwarded-For is replaced unless this node trusts its proxy", () => {
  const incoming = new Headers({ "x-forwarded-for": "198.51.100.66" });
  assertEquals(
    forwardedHeaders(incoming, "10.0.0.5").get("x-forwarded-for"),
    "10.0.0.5",
  );
  assertEquals(
    forwardedHeaders(incoming, "10.0.0.5", true).get("x-forwarded-for"),
    "198.51.100.66, 10.0.0.5",
  );
});

Deno.test("forwardedHeaders: keeps the caller's credential, drops hop headers, appends the caller to a trusted X-Forwarded-For", () => {
  const headers = forwardedHeaders(
    new Headers({
      authorization: "Bearer alice.secret",
      host: "lb.example",
      connection: "keep-alive",
      "content-length": "12",
      "x-forwarded-for": "203.0.113.9",
    }),
    "10.0.0.5",
    true,
  );
  assertEquals(headers.get("authorization"), "Bearer alice.secret");
  assertEquals(headers.get("host"), null);
  assertEquals(headers.get("connection"), null);
  assertEquals(headers.get("content-length"), null);
  assertEquals(headers.get("x-forwarded-for"), "203.0.113.9, 10.0.0.5");
});

Deno.test("LeaderLink.forward: sends the request to the leader at the same path and passes its reply back", async () => {
  let seen:
    | { url: string; method: string; auth: string | null; body: string }
    | undefined;
  const reply = await link(async (input, init) => {
    seen = {
      url: String(input),
      method: init?.method ?? "",
      auth: new Headers(init?.headers).get("authorization"),
      body: await new Response(init?.body).text(),
    };
    return new Response("landed", { status: 201 });
  }).forward(
    new Request("http://lb.example/api/v1/signal/x?y=1", {
      method: "POST",
      headers: { authorization: "Bearer bob.secret" },
      body: "payload",
    }),
    { clientIp: "10.0.0.7" },
  );
  assertEquals(reply.status, 201);
  assertEquals(await reply.text(), "landed");
  assertEquals(seen, {
    url: "https://node-a.internal:9090/api/v1/signal/x?y=1",
    method: "POST",
    auth: "Bearer bob.secret",
    body: "payload",
  });
});

Deno.test("LeaderLink.forward: names this node's span as the leader's parent, not the caller's", async () => {
  await withCapturedSpans(async (spans) => {
    let traceparent: string | null = null;
    await withSpan("follower", {}, async () => {
      const reply = await link((_input, init) => {
        traceparent = new Headers(init?.headers).get("traceparent");
        return Promise.resolve(new Response(null, { status: 204 }));
      }).forward(
        new Request("http://lb.example/api/v1/datastore/_default/locks", {
          method: "POST",
          headers: {
            traceparent:
              "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          },
        }),
      );
      await reply.body?.cancel();
    });
    const follower = findSpan(spans, "follower").spanContext();
    assertEquals(
      traceparent,
      `00-${follower.traceId}-${follower.spanId}-01`,
    );
  });
});

Deno.test("LeaderLink.forward: a body already read is sent as given", async () => {
  let body = "";
  await link(async (_input, init) => {
    body = await new Response(init?.body).text();
    return new Response(null, { status: 202 });
  }).forward(
    new Request("http://lb.example/hooks/x", { method: "POST" }),
    { body: new TextEncoder().encode("raw delivery") },
  );
  assertEquals(body, "raw delivery");
});

Deno.test("LeaderLink.forward: with no leader address it refuses, retryable, without calling out", async () => {
  let called = false;
  const reply = await link(() => {
    called = true;
    return Promise.resolve(new Response());
  }, { ...LEADER, address: undefined }).forward(
    new Request("http://lb.example/x", { method: "POST" }),
  );
  assertEquals(called, false);
  assertEquals(reply.status, 503);
  const json = await reply.json();
  assertEquals(json.code, "serve_not_leader");
  assertEquals(json.inFlight, undefined);
});

Deno.test("LeaderLink.forward: a leader that could not be reached is a plain refusal; one lost after sending is in flight", async () => {
  const refused = await link(() =>
    Promise.reject(new TypeError("tcp connect error: Connection refused"))
  ).forward(new Request("http://lb.example/x", { method: "POST" }));
  const refusedJson = await refused.json();
  assertEquals(refused.status, 503);
  assertEquals(refusedJson.inFlight, undefined);
  assertEquals(refusedJson.leader.instanceId, "instance-a");
  assert(String(refusedJson.message).includes("Nothing was changed"));

  const lost = await link(() =>
    Promise.reject(new TypeError("connection closed before message completed"))
  ).forward(new Request("http://lb.example/x", { method: "POST" }));
  const lostJson = await lost.json();
  assertEquals(lost.status, 503);
  assertEquals(lostJson.code, "serve_not_leader");
  assertEquals(lostJson.inFlight, true);
  assert(String(lostJson.message).includes("may already have run"));
});

Deno.test("LeaderLink.forward: a refusal for an unauthenticated sender names no leader", async () => {
  const reply = await link(() =>
    Promise.reject(new TypeError("tcp connect error: Connection refused"))
  ).forward(new Request("http://lb.example/hooks/x", { method: "POST" }), {
    nameLeader: false,
  });
  const json = await reply.json();
  assertEquals(json.leader, undefined);
  assert(!String(json.message).includes("instance-a"));
});

Deno.test("LeaderLink.forward: refuses once closed", async () => {
  const target = link(() => Promise.resolve(new Response("x")));
  target.close();
  const reply = await target.forward(
    new Request("http://lb.example/x", { method: "POST" }),
  );
  assertEquals(reply.status, 503);
});

Deno.test("leaderTarget: a caller's path never leaves the leader's origin", () => {
  assertEquals(
    leaderTarget("https://node-a.internal:9090", "//10.0.0.7:8080/admin", "")
      .origin,
    "https://node-a.internal:9090",
  );
});

Deno.test("LeaderLink.forward: a request target starting with // still goes to the leader", async () => {
  let seen = "";
  await link((input) => {
    seen = String(input);
    return Promise.resolve(new Response(null, { status: 204 }));
  }).forward(
    new Request("http://lb.example//evil.example/data/x?y=1", {
      method: "POST",
    }),
  );
  assertEquals(new URL(seen).origin, "https://node-a.internal:9090");
  assertEquals(new URL(seen).pathname, "//evil.example/data/x");
});

Deno.test("LeaderLink.forward: adds the team's forwarding header and drops one a caller sent (swamp-club#4148)", async () => {
  const seen: (string | null)[] = [];
  const forward = (peerToken: string | undefined) =>
    new LeaderLink({
      leader: () => LEADER,
      createClient: () => undefined,
      peerToken: () => peerToken,
      fetch: (_input, init) => {
        seen.push(new Headers(init?.headers).get(TEAM_PEER_HEADER));
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    }).forward(
      new Request("http://lb.example/x", {
        method: "POST",
        headers: { [TEAM_PEER_HEADER]: "swamp-peer.forged" },
      }),
    );
  await forward("swamp-peer.team");
  await forward(undefined);
  assertEquals(seen, ["swamp-peer.team", null]);
});

function neverAnswered(
  signal: AbortSignal | undefined | null,
): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason));
  });
}

Deno.test("LeaderLink.forward: a leader that never starts its reply is refused as in flight at the forward deadline", async () => {
  const forwarder = new LeaderLink({
    leader: () => LEADER,
    createClient: () => undefined,
    responseBaseMs: 20,
    fetch: (_input, init) => neverAnswered(init?.signal),
  });
  const reply = await forwarder.forward(
    new Request(
      "https://node-b.internal:9090/api/v1/datastore/_default/changes",
    ),
  );
  assertEquals(reply.status, 503);
  const body = await reply.json();
  assertEquals(body.code, "serve_not_leader");
  assertEquals(body.inFlight, true);
  forwarder.close();
});

Deno.test("LeaderLink.forward: after a leader left a forward unanswered, the next one opens a fresh connection", async () => {
  let made = 0;
  let calls = 0;
  const forwarder = new LeaderLink({
    leader: () => LEADER,
    createClient: () => {
      made++;
      return Deno.createHttpClient({});
    },
    responseBaseMs: 20,
    fetch: (_input, init) =>
      ++calls === 1
        ? neverAnswered(init?.signal)
        : Promise.resolve(new Response("ok")),
  });
  try {
    const url =
      "https://node-b.internal:9090/api/v1/datastore/_default/changes";
    assertEquals((await forwarder.forward(new Request(url))).status, 503);
    assertEquals(
      await (await forwarder.forward(new Request(url))).text(),
      "ok",
    );
    assertEquals(made, 2);
  } finally {
    forwarder.close();
  }
});

Deno.test("LeaderLink.forward: a forwarded lock request's deadline waits out the wait it asks of the leader", async () => {
  const forwarder = new LeaderLink({
    leader: () => LEADER,
    createClient: () => undefined,
    responseBaseMs: 10,
    fetch: async () => {
      await new Promise((done) => setTimeout(done, 60));
      return new Response("held", { status: 409 });
    },
  });
  const reply = await forwarder.forward(
    new Request(
      "https://node-b.internal:9090/api/v1/datastore/_default/locks",
      {
        method: "POST",
        body: JSON.stringify({ lockKey: "k", waitMs: 5_000 }),
      },
    ),
  );
  assertEquals(reply.status, 409);
  forwarder.close();
});

Deno.test("LeaderLink.forward: a forward outside the datastore API keeps its caller's deadline, not the datastore's", async () => {
  const forwarder = new LeaderLink({
    leader: () => LEADER,
    createClient: () => undefined,
    responseBaseMs: 10,
    commitResponseBaseMs: 10,
    fetch: async () => {
      await new Promise((done) => setTimeout(done, 60));
      return new Response("done");
    },
  });
  const reply = await forwarder.forward(
    new Request("https://node-b.internal:9090/api/v1/actions/deploy", {
      method: "POST",
      body: "{}",
    }),
  );
  assertEquals(await reply.text(), "done");
  forwarder.close();
});

Deno.test("notLeaderResponse: says whether a read or a write was refused, so the client tells a stale copy from a node that only follows", async () => {
  for (const reads of [true, false]) {
    const response = notLeaderResponse(new ServeNotLeaderError(LEADER, reads));
    const refusal = serveErrorFromReply(
      response.status,
      await response.json(),
      "https://serve.example.com",
    );
    assert(refusal instanceof ServeNotLeaderError);
    assertEquals(refusal.reads, reads);
    assertEquals(refusal.leader, LEADER);
  }
  const unnamed = notLeaderResponse(
    new ServeNotLeaderError(undefined, true),
    false,
  );
  assertEquals("reads" in await unnamed.json(), false);
});
