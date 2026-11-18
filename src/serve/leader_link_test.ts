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

import { waitFor } from "@swamp-club/swamp-testing";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { ServeLeader } from "../domain/datastore_v3/serve_leader.ts";
import {
  forwardedHeaders,
  forwardNeverSent,
  FROZEN_LEADER_PROBE_MS,
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

Deno.test("LeaderLink.forward: reads trustProxy on every forward, so a reload that changes it applies to the next request", async () => {
  let trustProxy = false;
  const forwardedFor: (string | null)[] = [];
  const forwarder = new LeaderLink({
    leader: () => LEADER,
    createClient: () => undefined,
    get trustProxy() {
      return trustProxy;
    },
    fetch: (_input, init) => {
      forwardedFor.push(new Headers(init?.headers).get("x-forwarded-for"));
      return Promise.resolve(new Response("ok"));
    },
  });
  const request = () =>
    new Request("http://lb.example/api/v1/signal/x", {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.66" },
      body: "payload",
    });
  await forwarder.forward(request(), { clientIp: "10.0.0.7" });
  trustProxy = true;
  await forwarder.forward(request(), { clientIp: "10.0.0.7" });
  assertEquals(forwardedFor, ["10.0.0.7", "198.51.100.66, 10.0.0.7"]);
});

const CHANGES_URL =
  "https://node-b.internal:9090/api/v1/datastore/_default/changes";

function frozenLink(
  fetchImpl: typeof fetch,
  options: { leader?: () => ServeLeader; now?: () => number } = {},
): LeaderLink {
  return new LeaderLink({
    leader: options.leader ?? (() => LEADER),
    createClient: () => undefined,
    responseBaseMs: 20,
    now: options.now ?? (() => 0),
    fetch: fetchImpl,
  });
}

async function forwardOnce(
  forwarder: LeaderLink,
): Promise<{ status: number; inFlight: unknown; code: unknown }> {
  const reply = await forwarder.forward(new Request(CHANGES_URL));
  if (reply.status !== 503) {
    await reply.body?.cancel();
    return { status: reply.status, inFlight: undefined, code: undefined };
  }
  const json = await reply.json();
  return { status: reply.status, inFlight: json.inFlight, code: json.code };
}

const FAST_REFUSAL = {
  status: 503,
  inFlight: undefined,
  code: "serve_not_leader",
};

Deno.test("LeaderLink.forward: after a leader refused a connection, forwards to it are refused at once as never sent", async () => {
  let calls = 0;
  const forwarder = frozenLink(() => {
    calls++;
    return Promise.reject(
      new TypeError("tcp connect error: Connection refused"),
    );
  });
  try {
    assertEquals(await forwardOnce(forwarder), FAST_REFUSAL);
    assertEquals(await forwardOnce(forwarder), FAST_REFUSAL);
    assertEquals(calls, 1);
  } finally {
    forwarder.close();
  }
});

Deno.test("LeaderLink.forward: one forward a slow leader left unanswered does not stop the next", async () => {
  let now = 0;
  let calls = 0;
  const forwarder = frozenLink(
    (_input, init) =>
      ++calls === 1
        ? neverAnswered(init?.signal)
        : Promise.resolve(new Response("ok")),
    { now: () => now },
  );
  try {
    assertEquals((await forwardOnce(forwarder)).inFlight, true);
    now++;
    assertEquals((await forwardOnce(forwarder)).status, 200);
    now++;
    // the answer reset the count: one more unanswered is again only one
    calls = 0;
    assertEquals((await forwardOnce(forwarder)).inFlight, true);
    now++;
    assertEquals((await forwardOnce(forwarder)).status, 200);
    assertEquals(calls, 2);
  } finally {
    forwarder.close();
  }
});

Deno.test("LeaderLink.forward: forwards that waited on one stall together count as one unanswered", async () => {
  let calls = 0;
  const forwarder = frozenLink((_input, init) =>
    ++calls <= 3
      ? neverAnswered(init?.signal)
      : Promise.resolve(new Response("ok"))
  );
  try {
    const together = await Promise.all([
      forwardOnce(forwarder),
      forwardOnce(forwarder),
      forwardOnce(forwarder),
    ]);
    assertEquals(together.map((r) => r.inFlight), [true, true, true]);
    assertEquals((await forwardOnce(forwarder)).status, 200);
    assertEquals(calls, 4);
  } finally {
    forwarder.close();
  }
});

Deno.test("LeaderLink.forward: a leader that left two forwards in a row unanswered is refused at once until a probe gets an answer", async () => {
  let now = 0;
  let calls = 0;
  let answers = false;
  const forwarder = frozenLink((_input, init) => {
    calls++;
    return answers
      ? Promise.resolve(new Response("ok"))
      : neverAnswered(init?.signal);
  }, { now: () => now });
  try {
    assertEquals((await forwardOnce(forwarder)).inFlight, true);
    now++;
    assertEquals((await forwardOnce(forwarder)).inFlight, true);
    now++;
    assertEquals(calls, 2);
    assertEquals(await forwardOnce(forwarder), FAST_REFUSAL);
    assertEquals(calls, 2);

    // a probe the leader leaves unanswered keeps it frozen
    now += FROZEN_LEADER_PROBE_MS;
    assertEquals((await forwardOnce(forwarder)).inFlight, true);
    assertEquals(calls, 3);
    assertEquals(await forwardOnce(forwarder), FAST_REFUSAL);
    assertEquals(calls, 3);

    now += FROZEN_LEADER_PROBE_MS;
    answers = true;
    assertEquals((await forwardOnce(forwarder)).status, 200);
    assertEquals((await forwardOnce(forwarder)).status, 200);
    assertEquals(calls, 5);
  } finally {
    forwarder.close();
  }
});

Deno.test("LeaderLink.forward: two forwards in a row left unanswered within one clock tick mark the leader frozen", async () => {
  let calls = 0;
  const forwarder = frozenLink((_input, init) => {
    calls++;
    return neverAnswered(init?.signal);
  });
  try {
    assertEquals((await forwardOnce(forwarder)).inFlight, true);
    assertEquals((await forwardOnce(forwarder)).inFlight, true);
    assertEquals(await forwardOnce(forwarder), FAST_REFUSAL);
    assertEquals(calls, 2);
  } finally {
    forwarder.close();
  }
});

Deno.test("LeaderLink.forward: a lock wait to a frozen leader is refused at once, before and past its probe time, and leaves the probe slot free", async () => {
  let now = 0;
  let calls = 0;
  let answers = false;
  const forwarder = frozenLink((_input, init) => {
    calls++;
    return answers
      ? Promise.resolve(new Response("ok"))
      : neverAnswered(init?.signal);
  }, { now: () => now });
  const lockWait = async () => {
    const body = new TextEncoder().encode(
      JSON.stringify({ lockKey: "k", waitMs: 5_000 }),
    );
    const reply = await forwarder.forward(
      new Request(
        "https://node-b.internal:9090/api/v1/datastore/_default/locks",
        { method: "POST", body },
      ),
      { body },
    );
    const json = await reply.json();
    return { status: reply.status, inFlight: json.inFlight, code: json.code };
  };
  try {
    await forwardOnce(forwarder);
    await forwardOnce(forwarder);
    assertEquals(calls, 2);
    assertEquals(await lockWait(), FAST_REFUSAL);
    now += FROZEN_LEADER_PROBE_MS;
    answers = true;
    assertEquals(await lockWait(), FAST_REFUSAL);
    assertEquals(calls, 2);
    assertEquals((await forwardOnce(forwarder)).status, 200);
    assertEquals(calls, 3);
  } finally {
    forwarder.close();
  }
});

Deno.test("LeaderLink.abortForwards: ends a forward in flight as in flight, without waiting for its deadline", async () => {
  let calls = 0;
  const forwarder = new LeaderLink({
    leader: () => LEADER,
    createClient: () => undefined,
    responseBaseMs: 60_000,
    fetch: (_input, init) => {
      calls++;
      return neverAnswered(init?.signal);
    },
  });
  try {
    const pending = forwardOnce(forwarder);
    await waitFor(() => calls === 1, "the forward to go out");
    forwarder.abortForwards();
    assertEquals(await pending, {
      status: 503,
      inFlight: true,
      code: "serve_not_leader",
    });
  } finally {
    forwarder.close();
  }
});

Deno.test("LeaderLink.abortForwards: forwards it ends never mark the leader frozen, and later forwards still go out", async () => {
  let calls = 0;
  let answers = false;
  const forwarder = new LeaderLink({
    leader: () => LEADER,
    createClient: () => undefined,
    responseBaseMs: 60_000,
    now: () => 0,
    fetch: (_input, init) => {
      calls++;
      return answers
        ? Promise.resolve(new Response("ok"))
        : neverAnswered(init?.signal);
    },
  });
  try {
    const pending = [forwardOnce(forwarder), forwardOnce(forwarder)];
    await waitFor(() => calls === 2, "both forwards to go out");
    forwarder.abortForwards();
    for (const reply of await Promise.all(pending)) {
      assertEquals(reply.inFlight, true);
    }
    answers = true;
    assertEquals((await forwardOnce(forwarder)).status, 200);
    assertEquals(calls, 3);
  } finally {
    forwarder.close();
  }
});

Deno.test("LeaderLink.forward: a webhook or action forward to a frozen leader past its probe time goes out, and its answer clears the mark", async () => {
  let now = 0;
  let calls = 0;
  let answers = false;
  const forwarder = frozenLink((_input, init) => {
    calls++;
    return answers
      ? Promise.resolve(new Response("ok"))
      : neverAnswered(init?.signal);
  }, { now: () => now });
  try {
    await forwardOnce(forwarder);
    await forwardOnce(forwarder);
    const webhook = () =>
      forwarder.forward(
        new Request("https://node-b.internal:9090/api/v1/webhooks/deploy", {
          method: "POST",
        }),
      );
    const refused = await webhook();
    assertEquals(refused.status, 503);
    await refused.body?.cancel();
    assertEquals(calls, 2);
    now += FROZEN_LEADER_PROBE_MS;
    answers = true;
    const sent = await webhook();
    assertEquals(sent.status, 200);
    await sent.body?.cancel();
    assertEquals((await forwardOnce(forwarder)).status, 200);
    assertEquals(calls, 4);
  } finally {
    forwarder.close();
  }
});

Deno.test("LeaderLink.forward: while a probe of a frozen leader waits, other forwards are refused at once", async () => {
  let now = 0;
  let calls = 0;
  let release: (() => void) | undefined;
  const forwarder = frozenLink(() => {
    calls++;
    if (calls === 1) {
      return Promise.reject(
        new TypeError("tcp connect error: Connection refused"),
      );
    }
    return new Promise<Response>((resolve) => {
      release = () => resolve(new Response("ok"));
    });
  }, { now: () => now });
  try {
    await forwardOnce(forwarder);
    now += FROZEN_LEADER_PROBE_MS;
    const probe = forwardOnce(forwarder);
    assertEquals(await forwardOnce(forwarder), FAST_REFUSAL);
    assertEquals(calls, 2);
    release?.();
    assertEquals((await probe).status, 200);
  } finally {
    forwarder.close();
  }
});

Deno.test("LeaderLink.forward: a new leader is forwarded to at once, whatever the old one was marked", async () => {
  let leader = LEADER;
  const seen: string[] = [];
  const forwarder = frozenLink((input) => {
    const origin = new URL(String(input)).origin;
    seen.push(origin);
    return origin === "https://node-a.internal:9090"
      ? Promise.reject(new TypeError("tcp connect error: Connection refused"))
      : Promise.resolve(new Response("ok"));
  }, { leader: () => leader });
  try {
    await forwardOnce(forwarder);
    leader = {
      ...LEADER,
      instanceId: "instance-c",
      fence: 4,
      address: "https://node-c.internal:9090",
    };
    assertEquals((await forwardOnce(forwarder)).status, 200);
    assertEquals(seen, [
      "https://node-a.internal:9090",
      "https://node-c.internal:9090",
    ]);
  } finally {
    forwarder.close();
  }
});

Deno.test("LeaderLink.drain: waits for a forward the leader is answering to finish relaying, then closes", async () => {
  const answered = Promise.withResolvers<void>();
  let fetches = 0;
  const leaderLink = link(async () => {
    fetches++;
    await answered.promise;
    return new Response("delivered", { status: 202 });
  });
  const forwarding = leaderLink.forward(
    new Request("http://follower/hooks/x", { method: "POST", body: "{}" }),
  );
  await waitFor(() => fetches === 1, "the forward sent");
  let drained = false;
  const draining = leaderLink.drain(60_000).then(() => (drained = true));
  assertEquals(drained, false);
  answered.resolve();
  const reply = await forwarding;
  assertEquals(reply.status, 202);
  assertEquals(drained, false);
  assertEquals(await reply.text(), "delivered");
  await draining;
  const after = await leaderLink.forward(new Request("http://follower/x"));
  assertEquals(after.status, 503);
  await after.body?.cancel();
  assertEquals(fetches, 1);
});

Deno.test("LeaderLink.drain: a forward that outlasts the wait is cut off and closing goes ahead", async () => {
  const leaderLink = link((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("closed", "AbortError")),
        { once: true },
      );
    })
  );
  const forwarding = leaderLink.forward(
    new Request("http://follower/hooks/x", { method: "POST", body: "{}" }),
  );
  await leaderLink.drain(10);
  const reply = await forwarding;
  assertEquals(reply.status, 503);
  await reply.body?.cancel();
});

Deno.test("LeaderLink.drain: with nothing in flight closes at once", async () => {
  const leaderLink = link(() => Promise.resolve(new Response("ok")));
  await leaderLink.drain(60_000);
  const after = await leaderLink.forward(new Request("http://follower/x"));
  assertEquals(after.status, 503);
  await after.body?.cancel();
});

Deno.test("LeaderLink.drain: a GET still streaming its reply does not hold the close", async () => {
  const leaderLink = link(() =>
    Promise.resolve(new Response(new ReadableStream<Uint8Array>()))
  );
  const reply = await leaderLink.forward(
    new Request("http://follower/api/v1/events"),
  );
  await leaderLink.drain(60_000);
  await reply.body?.cancel();
});

Deno.test("notLeaderResponse: an unnamed refusal in flight says the request may have run, never to try again", async () => {
  const lost = await notLeaderResponse(
    new ServeNotLeaderError(LEADER, false, true),
    false,
  ).json();
  assertEquals(lost.inFlight, true);
  assertEquals(lost.leader, undefined);
  assertStringIncludes(lost.message, "may already have run");
  assert(!String(lost.message).includes("try again"));
  assert(!String(lost.message).includes("instance-a"));
  const refused = await notLeaderResponse(
    new ServeNotLeaderError(LEADER),
    false,
  )
    .json();
  assertEquals(refused.inFlight, undefined);
  assertStringIncludes(refused.message, "try again");
});
