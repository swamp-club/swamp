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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { configure, type LogRecord, reset } from "@logtape/logtape";
import { withCapturedSpans } from "../../infrastructure/tracing/span_test_helpers.ts";
import { traceHttpRequests } from "../http_request_span.ts";
import { sampleFingerprintProps } from "../../domain/serve/federation_test_helpers.ts";
import {
  checkFailedAttempts,
  failedAttemptKey,
  resetRateLimitState,
} from "../rate_limiter.ts";
import type { ForwardOptions } from "../leader_link.ts";
import { VERSION } from "../../infrastructure/runtime/build_info.ts";
import { createTestHub, type TestHub } from "./federation_hub_test_helpers.ts";
import {
  FEDERATION_CHECK_IN_PATH,
  FEDERATION_HUB_ROUTES,
  FEDERATION_JOIN_PATH,
  handleFederationRequest,
  MAX_CAPABILITIES,
  MAX_FEDERATION_BODY_BYTES,
  routeFederationRequest,
} from "./hub_routes.ts";

function address(): string {
  const n = () => Math.floor(Math.random() * 250) + 1;
  return `10.${n()}.${n()}.${n()}`;
}

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://hub.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function joinBody(joinToken: unknown, extra: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    capabilities: [],
    fingerprint: sampleFingerprintProps(),
    joinToken,
    ...extra,
  };
}

function checkInBody(
  instanceId: unknown = crypto.randomUUID(),
  extra: Record<string, unknown> = {},
) {
  return {
    protocolVersion: 1,
    capabilities: ["future-verb"],
    fingerprint: sampleFingerprintProps(),
    instanceId,
    ...extra,
  };
}

async function call(
  t: TestHub,
  req: Request,
  clientAddress: string,
): Promise<Response> {
  const response = await handleFederationRequest(req, {
    hub: t.hub,
    clientAddress,
  });
  assert(response !== null);
  return response;
}

async function join(t: TestHub, ip: string, name = "edge-1") {
  const { plaintext } = await t.hub.createToken(name);
  const response = await call(
    t,
    post(FEDERATION_JOIN_PATH, joinBody(plaintext)),
    ip,
  );
  assertEquals(response.status, 200);
  return await response.json() as {
    memberId: string;
    memberName: string;
    credential: string;
    hub: { name: string; swampVersion: string; protocolVersion: number };
    checkInIntervalSeconds: number;
  };
}

function checkIn(credential: string, body: unknown = checkInBody()) {
  return post(FEDERATION_CHECK_IN_PATH, body, {
    authorization: `Bearer ${credential}`,
  });
}

Deno.test("handleFederationRequest: answers only its two paths, and only POST", async () => {
  const t = createTestHub();
  assertEquals(
    await handleFederationRequest(new Request("http://hub.test/health"), {
      hub: t.hub,
      clientAddress: address(),
    }),
    null,
  );
  const get = await call(
    t,
    new Request(`http://hub.test${FEDERATION_JOIN_PATH}`),
    address(),
  );
  assertEquals(get.status, 405);
  assertEquals(get.headers.get("allow"), "POST");
  await get.body?.cancel();
});

Deno.test("handleFederationRequest: join replies with the member, its credential, the hub and the interval", async () => {
  resetRateLimitState();
  const t = createTestHub({ hubName: "central" });
  const reply = await join(t, address());
  assertEquals(reply.memberName, "edge-1");
  assertEquals(reply.hub, {
    name: "central",
    swampVersion: VERSION,
    protocolVersion: 1,
  });
  assertEquals(reply.checkInIntervalSeconds, 30);
  assert(reply.credential.startsWith(`swfm1.${reply.memberId}.`));
});

Deno.test("handleFederationRequest: every refused join token gets the same 401 body", async () => {
  resetRateLimitState();
  const t = createTestHub();
  const used = await t.hub.createToken("used");
  await call(
    t,
    post(FEDERATION_JOIN_PATH, joinBody(used.plaintext)),
    address(),
  );
  const revoked = await t.hub.createToken("revoked");
  await t.hub.revokeToken("revoked");
  const bodies = new Set<string>();
  for (
    const token of [
      used.plaintext,
      revoked.plaintext,
      `missing.${"A".repeat(43)}`,
      "garbage",
    ]
  ) {
    const response = await call(
      t,
      post(FEDERATION_JOIN_PATH, joinBody(token)),
      address(),
    );
    assertEquals(response.status, 401);
    const text = await response.text();
    assert(!text.includes("used") && !text.includes("revoked"), text);
    bodies.add(text);
  }
  assertEquals(bodies.size, 1);
});

Deno.test("handleFederationRequest: a live member's name gives 409", async () => {
  resetRateLimitState();
  const t = createTestHub();
  await join(t, address());
  const { plaintext } = await t.hub.createToken("edge-1");
  const response = await call(
    t,
    post(FEDERATION_JOIN_PATH, joinBody(plaintext)),
    address(),
  );
  assertEquals(response.status, 409);
  assertEquals((await response.json()).error, "name_taken");
});

Deno.test("handleFederationRequest: an oversize body gives 413 on both routes", async () => {
  resetRateLimitState();
  const t = createTestHub();
  const big = "x".repeat(MAX_FEDERATION_BODY_BYTES + 1);
  for (const path of [FEDERATION_JOIN_PATH, FEDERATION_CHECK_IN_PATH]) {
    const response = await call(t, post(path, big), address());
    assertEquals(response.status, 413, path);
    await response.body?.cancel();
  }
});

Deno.test("handleFederationRequest: another protocolVersion gives 400 naming the supported one", async () => {
  resetRateLimitState();
  const t = createTestHub();
  for (const version of [2, "1", undefined]) {
    const response = await call(
      t,
      post(FEDERATION_JOIN_PATH, joinBody("x", { protocolVersion: version })),
      address(),
    );
    assertEquals(response.status, 400);
    assertStringIncludes(
      (await response.json()).message,
      "supports protocolVersion 1",
    );
  }
});

Deno.test("handleFederationRequest: capabilities are capped and unknown ones ignored", async () => {
  resetRateLimitState();
  const t = createTestHub();
  const reply = await join(t, address());
  const tooMany = await call(
    t,
    checkIn(
      reply.credential,
      checkInBody(undefined, {
        capabilities: Array.from(
          { length: MAX_CAPABILITIES + 1 },
          (_, i) => `c${i}`,
        ),
      }),
    ),
    address(),
  );
  assertEquals(tooMany.status, 400);
  assertStringIncludes((await tooMany.json()).message, "capabilities");
  const fine = await call(t, checkIn(reply.credential), address());
  assertEquals(fine.status, 200);
  assertEquals(await fine.json(), {
    hub: { name: "hub", swampVersion: VERSION, protocolVersion: 1 },
    checkInIntervalSeconds: 30,
    jobs: [],
  });
});

Deno.test("handleFederationRequest: a fingerprint refusal names the path and echoes nothing the caller sent", async () => {
  resetRateLimitState();
  const t = createTestHub();
  const response = await call(
    t,
    post(
      FEDERATION_JOIN_PATH,
      joinBody("x", {
        fingerprint: {
          ...sampleFingerprintProps(),
          leakedHostname: "secret-host.internal",
        },
      }),
    ),
    address(),
  );
  assertEquals(response.status, 400);
  const text = await response.text();
  assertStringIncludes(text, "fingerprint");
  assertStringIncludes(text, "unknown field");
  assert(!text.includes("leakedHostname"), text);
  assert(!text.includes("secret-host"), text);
  const wrongType = await call(
    t,
    post(
      FEDERATION_JOIN_PATH,
      joinBody("x", {
        fingerprint: { ...sampleFingerprintProps(), platform: 1234567 },
      }),
    ),
    address(),
  );
  const message = (await wrongType.json()).message as string;
  assertStringIncludes(message, "fingerprint.platform");
  assert(!message.includes("1234567"), message);
});

Deno.test("handleFederationRequest: the address burst limit applies to join, never to check-in", async () => {
  resetRateLimitState();
  const t = createTestHub();
  const ip = address();
  const reply = await join(t, ip);
  for (let i = 0; i < 60; i++) {
    const response = await call(t, checkIn(reply.credential), ip);
    assertEquals(response.status, 200, `check-in ${i}`);
    await response.body?.cancel();
  }
  let limited: Response | undefined;
  for (let i = 0; i < 60 && limited === undefined; i++) {
    const response = await call(
      t,
      post(FEDERATION_JOIN_PATH, joinBody("garbage")),
      ip,
    );
    if (response.status === 429) limited = response;
    else await response.body?.cancel();
  }
  assert(limited !== undefined, "join was never limited");
  assert(Number(limited.headers.get("retry-after")) > 0);
  await limited.body?.cancel();
});

Deno.test("handleFederationRequest: instance ids that are not UUIDs give 400 and write no key", async () => {
  resetRateLimitState();
  const t = createTestHub();
  const reply = await join(t, address());
  for (
    const instanceId of [
      "../../credentials/x",
      "..%2f..%2fx",
      `${crypto.randomUUID()}/..`,
      "a/b",
      "",
      42,
      undefined,
    ]
  ) {
    const response = await call(
      t,
      checkIn(
        reply.credential,
        checkInBody(crypto.randomUUID(), { instanceId }),
      ),
      address(),
    );
    assertEquals(response.status, 400, String(instanceId));
    assertStringIncludes((await response.json()).message, "instanceId");
  }
  assertEquals(await t.store.list("federation/seen/"), []);
  assertEquals(t.members.version("edge-1"), 1);
});

Deno.test("handleFederationRequest: a 65th live instance gives 409", async () => {
  resetRateLimitState();
  const t = createTestHub();
  const reply = await join(t, address());
  const ip = address();
  for (let i = 0; i < 64; i++) {
    const response = await call(t, checkIn(reply.credential), ip);
    assertEquals(response.status, 200);
    await response.body?.cancel();
  }
  const response = await call(t, checkIn(reply.credential), ip);
  assertEquals(response.status, 409);
  assertEquals((await response.json()).error, "instance_limit");
});

Deno.test("handleFederationRequest: refused check-ins count per member and address, or per address when unparseable", async () => {
  resetRateLimitState();
  const t = createTestHub();
  const a = await join(t, address(), "member-a");
  const b = await join(t, address(), "member-b");
  const ip = address();
  const forgedA = `swfm1.${a.memberId}.${"A".repeat(43)}`;
  const bodies = new Set<string>();
  for (let i = 0; i < 5; i++) {
    const response = await call(t, checkIn(forgedA), ip);
    assertEquals(response.status, 401);
    bodies.add(await response.text());
  }
  assert(
    !checkFailedAttempts(
      failedAttemptKey(null, ip, `federation-check-in:${a.memberId}`),
    ).allowed,
  );
  const limited = await call(t, checkIn(a.credential), ip);
  assertEquals(limited.status, 429);
  await limited.body?.cancel();
  const otherMember = await call(t, checkIn(b.credential), ip);
  assertEquals(otherMember.status, 200);
  await otherMember.body?.cancel();
  const otherAddress = await call(t, checkIn(a.credential), address());
  assertEquals(otherAddress.status, 200);
  await otherAddress.body?.cancel();

  const garbageIp = address();
  for (let i = 0; i < 5; i++) {
    const response = await call(t, checkIn("not-a-credential"), garbageIp);
    assertEquals(response.status, 401);
    bodies.add(await response.text());
  }
  assert(
    !checkFailedAttempts(
      failedAttemptKey(null, garbageIp, "federation-check-in"),
    ).allowed,
  );
  const garbageLimited = await call(t, checkIn("not-a-credential"), garbageIp);
  assertEquals(garbageLimited.status, 429);
  await garbageLimited.body?.cancel();
  const valid = await call(t, checkIn(b.credential), garbageIp);
  assertEquals(valid.status, 200);
  await valid.body?.cancel();
  assertEquals(bodies.size, 1);
});

Deno.test("handleFederationRequest: a removed member's next check-in gets 401", async () => {
  resetRateLimitState();
  const t = createTestHub();
  const reply = await join(t, address());
  const ok = await call(t, checkIn(reply.credential), address());
  assertEquals(ok.status, 200);
  await ok.body?.cancel();
  await t.hub.removeMember("edge-1");
  const refused = await call(t, checkIn(reply.credential), address());
  assertEquals(refused.status, 401);
  await refused.body?.cancel();
});

Deno.test("routeFederationRequest: without a hub or off its paths it answers nothing", async () => {
  const t = createTestHub();
  const forwarded: Request[] = [];
  const leader = {
    isFollowing: () => true,
    forward: (req: Request) => {
      forwarded.push(req);
      return Promise.resolve(new Response("leader"));
    },
  };
  assertEquals(
    await routeFederationRequest(post(FEDERATION_JOIN_PATH, joinBody("x")), {
      hub: undefined,
      clientAddress: () => "127.0.0.1",
      leader,
    }),
    null,
  );
  assertEquals(
    await routeFederationRequest(post("/hooks/x", {}), {
      hub: t.hub,
      clientAddress: () => "127.0.0.1",
      leader,
    }),
    null,
  );
  assertEquals(forwarded, []);
});

Deno.test("routeFederationRequest: a following node forwards the body to its leader, naming no leader", async () => {
  const t = createTestHub();
  const calls: Array<{ req: Request; options: ForwardOptions }> = [];
  const leader = {
    isFollowing: () => true,
    forward: (req: Request, options: ForwardOptions) => {
      calls.push({ req, options });
      return Promise.resolve(new Response("from leader", { status: 202 }));
    },
  };
  const body = checkInBody();
  const response = await routeFederationRequest(
    checkIn("swfm1.x.y", body),
    { hub: t.hub, clientAddress: () => "198.51.100.7", leader },
  );
  assertEquals(response?.status, 202);
  assertEquals(await response?.text(), "from leader");
  assertEquals(calls.length, 1);
  assertEquals(calls[0].options.nameLeader, false);
  assertEquals(calls[0].options.clientIp, "198.51.100.7");
  assertEquals(
    JSON.parse(new TextDecoder().decode(calls[0].options.body)),
    body,
  );
  assertEquals(t.members.calls, []);

  const tooBig = await routeFederationRequest(
    post(FEDERATION_JOIN_PATH, "x".repeat(MAX_FEDERATION_BODY_BYTES + 1)),
    { hub: t.hub, clientAddress: () => "198.51.100.7", leader },
  );
  assertEquals(tooBig?.status, 413);
  await tooBig?.body?.cancel();
  assertEquals(calls.length, 1);
});

Deno.test("routeFederationRequest: the leading node answers itself", async () => {
  resetRateLimitState();
  const t = createTestHub();
  const { plaintext } = await t.hub.createToken("edge-1");
  const response = await routeFederationRequest(
    post(FEDERATION_JOIN_PATH, joinBody(plaintext)),
    {
      hub: t.hub,
      clientAddress: () => address(),
      leader: {
        isFollowing: () => false,
        forward: () => Promise.reject(new Error("must not forward")),
      },
    },
  );
  assertEquals(response?.status, 200);
  await response?.body?.cancel();
});

Deno.test("handleFederationRequest: no join token or credential secret reaches a span or a log", async () => {
  resetRateLimitState();
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => records.push(record) },
    loggers: [{ category: [], lowestLevel: "debug", sinks: ["capture"] }],
    reset: true,
  });
  try {
    await withCapturedSpans(async (spans) => {
      const t = createTestHub();
      const ip = address();
      const served = traceHttpRequests(
        async (req) => await call(t, req, ip),
        FEDERATION_HUB_ROUTES,
      );
      const info = {
        remoteAddr: { transport: "tcp", hostname: ip, port: 1234 },
        completed: Promise.resolve(),
      } as unknown as Deno.ServeHandlerInfo;
      const { plaintext } = await t.hub.createToken("edge-1");
      const joined = await served(
        post(FEDERATION_JOIN_PATH, joinBody(plaintext)),
        info,
      );
      const { credential } = await joined.json();
      const reused = await served(
        post(FEDERATION_JOIN_PATH, joinBody(plaintext)),
        info,
      );
      assertEquals(reused.status, 401);
      await reused.body?.cancel();
      const checkedIn = await served(checkIn(credential), info);
      assertEquals(checkedIn.status, 200);
      await checkedIn.body?.cancel();
      const forged = `${credential.slice(0, -4)}AAAA`;
      const refused = await served(checkIn(forged), info);
      assertEquals(refused.status, 401);
      await refused.body?.cancel();
      await t.hub.settled();

      assert(spans.length >= 4, `${spans.length} spans`);
      const telemetry = JSON.stringify([
        spans.map((span) => [span.name, span.attributes, span.events]),
        records.map((r) => [r.category, r.message, r.properties]),
      ]);
      for (
        const secret of [
          plaintext,
          plaintext.split(".")[1],
          credential,
          credential.split(".")[2],
          forged.split(".")[2],
        ]
      ) {
        assert(!telemetry.includes(secret), "a secret reached telemetry");
      }
    });
  } finally {
    await reset();
  }
});
