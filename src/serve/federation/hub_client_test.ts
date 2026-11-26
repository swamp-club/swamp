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
import { Fingerprint } from "../../domain/serve/fingerprint.ts";
import { sampleFingerprintProps } from "../../domain/serve/federation_test_helpers.ts";
import { MemberCredential } from "../../domain/serve/member_credential.ts";
import { HubClient, type HubClientOptions } from "./hub_client.ts";

const HUB = "https://hub.example.com/prefix";
const FINGERPRINT = Fingerprint.create(sampleFingerprintProps());
const INSTANCE = crypto.randomUUID();
const HUB_IDENTITY = {
  name: "central",
  swampVersion: "1.0.0",
  protocolVersion: 1,
};

interface Sent {
  url: string;
  init: RequestInit & { client?: Deno.HttpClient };
}

function clientWith(
  respond: (sent: Sent) => Response | Promise<Response>,
  options: Partial<HubClientOptions> = {},
): { client: HubClient; sent: Sent[] } {
  const sent: Sent[] = [];
  const client = new HubClient({
    hubUrl: HUB,
    fetch: ((url: string, init: Sent["init"]) => {
      const entry = { url, init };
      sent.push(entry);
      return Promise.resolve(respond(entry));
    }) as typeof fetch,
    ...options,
  });
  return { client, sent };
}

function json(status: number, body: unknown, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function joinReply(memberId = crypto.randomUUID()) {
  const credential = MemberCredential.issue(memberId);
  return {
    credential,
    body: {
      memberId,
      memberName: "edge",
      credential: credential.toWire(),
      hub: HUB_IDENTITY,
      checkInIntervalSeconds: 30,
    },
  };
}

Deno.test("HubClient.join: posts the protocol body to the hub's join path, never following a redirect", async () => {
  const { body, credential } = joinReply();
  const { client, sent } = clientWith(() => json(200, body));
  const outcome = await client.join("edge.secret", FINGERPRINT);
  assertEquals(outcome.kind, "ok");
  if (outcome.kind === "ok") {
    assertEquals(outcome.value.credential.toWire(), credential.toWire());
    assertEquals(outcome.value.memberName, "edge");
  }
  assertEquals(sent[0].url, `${HUB}/federation/v1/join`);
  assertEquals(sent[0].init.redirect, "manual");
  assertEquals(new Headers(sent[0].init.headers).get("authorization"), null);
  assertEquals(JSON.parse(sent[0].init.body as string), {
    joinToken: "edge.secret",
    fingerprint: FINGERPRINT.toJSON(),
    protocolVersion: 1,
    capabilities: [],
  });
});

Deno.test("HubClient.join: a reply whose credential is malformed or names another member is rejected", async () => {
  const { body } = joinReply();
  for (
    const reply of [
      { ...body, credential: "swfm1.nope" },
      { ...body, memberId: crypto.randomUUID() },
      { ...body, memberId: body.memberId.toUpperCase() },
      { ...body, hub: undefined },
    ]
  ) {
    const { client } = clientWith(() => json(200, reply));
    assertEquals(await client.join("t", FINGERPRINT), {
      kind: "rejected",
      status: 200,
    });
  }
});

Deno.test("HubClient.checkIn: sends the credential as a bearer token with the instance and fingerprint", async () => {
  const credential = MemberCredential.issue(crypto.randomUUID());
  const { client, sent } = clientWith(() =>
    json(200, { hub: HUB_IDENTITY, checkInIntervalSeconds: 15, jobs: [] })
  );
  const outcome = await client.checkIn(credential, INSTANCE, FINGERPRINT);
  assertEquals(outcome, {
    kind: "ok",
    value: { hub: HUB_IDENTITY, checkInIntervalSeconds: 15 },
  });
  assertEquals(sent[0].url, `${HUB}/federation/v1/check-in`);
  assertEquals(
    new Headers(sent[0].init.headers).get("authorization"),
    `Bearer ${credential.toWire()}`,
  );
  assertEquals(JSON.parse(sent[0].init.body as string).instanceId, INSTANCE);
});

Deno.test("HubClient: maps each refusal to its outcome", async () => {
  const credential = MemberCredential.issue(crypto.randomUUID());
  const cases: [Response, unknown][] = [
    [json(401, { error: "unauthorized" }), { kind: "unauthorized" }],
    [json(409, { error: "instance_limit" }), {
      kind: "conflict",
      error: "conflict",
    }],
    [
      json(429, { error: "rate_limited" }, { "retry-after": "42" }),
      { kind: "rate_limited", retryAfterSeconds: 42 },
    ],
    [json(429, {}, { "retry-after": "soon" }), { kind: "rate_limited" }],
    [json(503, {}), { kind: "server_error", status: 503 }],
    [json(400, { error: "invalid_request" }), {
      kind: "rejected",
      status: 400,
    }],
    [
      new Response(null, { status: 307, headers: { location: "https://x" } }),
      { kind: "rejected", status: 307 },
    ],
    [new Response("not json", { status: 200 }), {
      kind: "rejected",
      status: 200,
    }],
  ];
  for (const [response, expected] of cases) {
    const { client } = clientWith(() => response);
    assertEquals(
      await client.checkIn(credential, INSTANCE, FINGERPRINT),
      expected,
    );
  }
});

Deno.test("HubClient: a reply larger than 64 KiB is refused", async () => {
  const { client } = clientWith(() =>
    new Response(JSON.stringify({ pad: "x".repeat(70 * 1024) }), {
      status: 200,
    })
  );
  assertEquals(
    await client.checkIn(
      MemberCredential.issue(crypto.randomUUID()),
      INSTANCE,
      FINGERPRINT,
    ),
    { kind: "rejected", status: 200 },
  );
});

Deno.test("HubClient: a network error is unreachable", async () => {
  const { client } = clientWith(() => {
    throw new TypeError("connection refused");
  });
  assertEquals(await client.join("t", FINGERPRINT), { kind: "unreachable" });
});

function hangingFetch(): typeof fetch {
  return ((_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })) as typeof fetch;
}

Deno.test("HubClient: a hub that never answers times out as unreachable", async () => {
  const client = new HubClient({
    hubUrl: HUB,
    fetch: hangingFetch(),
    timeoutMs: 10,
  });
  assertEquals(await client.join("t", FINGERPRINT), { kind: "unreachable" });
});

Deno.test("HubClient.dispose: aborts a request in flight, and later calls stop at once", async () => {
  const client = new HubClient({ hubUrl: HUB, fetch: hangingFetch() });
  const pending = client.join("t", FINGERPRINT);
  client.dispose();
  assertEquals(await pending, { kind: "stopped" });
  assertEquals(await client.join("t", FINGERPRINT), { kind: "stopped" });
});

Deno.test("HubClient: builds its own HTTP client only with CA roots, once, and closes it on dispose", async () => {
  let created = 0;
  let closed = 0;
  const fake = { close: () => closed++ } as unknown as Deno.HttpClient;
  const { client, sent } = clientWith(
    () => json(401, {}),
    {
      caCerts: ["-----BEGIN CERTIFICATE-----"],
      createClient: (options) => {
        created++;
        assertEquals(options.caCerts, ["-----BEGIN CERTIFICATE-----"]);
        return fake;
      },
    },
  );
  await client.join("t", FINGERPRINT);
  await client.join("t", FINGERPRINT);
  assertEquals(created, 1);
  assert(sent.every((s) => s.init.client === fake));
  client.dispose();
  assertEquals(closed, 1);

  const plain = clientWith(() => json(401, {}));
  await plain.client.join("t", FINGERPRINT);
  assertEquals(plain.sent[0].init.client, undefined);
});
