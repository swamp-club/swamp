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
} from "./leader_link.ts";

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
