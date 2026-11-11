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

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  displaySafeReason,
  MAX_REFUSAL_REASON,
  REQUIRES_PLAN_MESSAGE,
  ServeLinkClient,
  ServeLinkError,
} from "./serve_link_client.ts";

interface Seen {
  method: string;
  path: string;
  search: string;
  authorization: string | null;
  body: unknown;
}

async function withMock(
  answer: (path: string, method: string) => { status: number; body?: unknown },
  fn: (client: ServeLinkClient, seen: Seen[]) => Promise<void>,
): Promise<void> {
  const seen: Seen[] = [];
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (req) => {
      const url = new URL(req.url);
      const text = await req.text();
      seen.push({
        method: req.method,
        path: url.pathname,
        search: url.search,
        authorization: req.headers.get("authorization"),
        body: text ? JSON.parse(text) : undefined,
      });
      const { status, body } = answer(url.pathname, req.method);
      return Response.json(body ?? {}, { status });
    },
  );
  try {
    await fn(
      new ServeLinkClient({
        baseUrl: `http://127.0.0.1:${server.addr.port}/`,
        clientId: "client-1",
        clientSecret: "s3cret",
      }),
      seen,
    );
  } finally {
    await server.shutdown();
  }
}

const START = {
  integration: { id: "slack-bot", name: "Slack bot" },
  external: {
    platform: "slack",
    team_id: "T1",
    user_id: "U1",
    display: "Pat",
    workspace: "Acme",
  },
  requireEmailMatch: false,
  ceiling: { version: 1 as const, ceiling: [] },
  ceilingDigest: "sha256:x",
};

Deno.test("ServeLinkClient: start sends Basic client credentials and returns the started link", async () => {
  await withMock(
    () => ({
      status: 200,
      body: {
        requestId: "r1",
        consentUrl: "https://club/link?code=abc",
        digest: "d1",
        expiresIn: 600,
        interval: 5,
      },
    }),
    async (client, seen) => {
      const started = await client.start(START);
      assertEquals(started.requestId, "r1");
      assertEquals(seen[0].path, "/api/v1/serve/links");
      assertEquals(seen[0].method, "POST");
      assertEquals(seen[0].authorization, `Basic ${btoa("client-1:s3cret")}`);
      assertEquals(seen[0].body, START);
    },
  );
});

Deno.test("ServeLinkClient: a disabled collective, a missing instance and a refusal are told apart", async () => {
  const cases: [number, unknown, string][] = [
    [404, { error: "not_found" }, "not_enabled"],
    [409, { error: "no_instance" }, "no_instance"],
    [400, { error: "ceiling_digest_mismatch" }, "refused"],
    [429, { error: "rate_limited" }, "rate_limited"],
    [401, { error: "invalid_client" }, "unauthorized"],
    [503, { error: "unavailable" }, "unavailable"],
  ];
  for (const [status, body, kind] of cases) {
    await withMock(() => ({ status, body }), async (client) => {
      const error = await assertRejects(
        () => client.start(START),
        ServeLinkError,
      );
      assertEquals(error.kind, kind, String(status));
    });
  }
});

Deno.test("ServeLinkClient: capabilities answers 404 as not enabled", async () => {
  await withMock(() => ({ status: 404 }), async (client) => {
    const error = await assertRejects(
      () => client.capabilities(),
      ServeLinkError,
    );
    assertEquals(error.kind, "not_enabled");
  });
});

Deno.test("ServeLinkClient: a collective without a plan is requires_plan with swamp-club's message at capabilities and start, never not_enabled", async () => {
  const message = "Links need a trial or a paid plan.";
  await withMock(
    () => ({ status: 403, body: { error: "links_require_plan", message } }),
    async (client) => {
      for (
        const call of [() => client.capabilities(), () => client.start(START)]
      ) {
        const error = await assertRejects(call, ServeLinkError);
        assertEquals(error.kind, "requires_plan");
        assertEquals(error.code, "links_require_plan");
        assertEquals(error.message, message);
      }
    },
  );
});

Deno.test("ServeLinkClient: a client that isn't a collective's is unauthorized with client_not_collective at capabilities and start", async () => {
  await withMock(
    () => ({ status: 403, body: { error: "client_not_collective" } }),
    async (client) => {
      for (
        const call of [() => client.capabilities(), () => client.start(START)]
      ) {
        const error = await assertRejects(call, ServeLinkError);
        assertEquals(error.kind, "unauthorized");
        assertEquals(error.code, "client_not_collective");
      }
    },
  );
});

Deno.test("ServeLinkClient: a plan refusal without a usable message carries serve's own wording", async () => {
  for (
    const body of [
      { error: "links_require_plan" },
      { error: "links_require_plan", message: 7 },
      { error: "links_require_plan", message: "\u200b\u0000 " },
    ]
  ) {
    await withMock(() => ({ status: 403, body }), async (client) => {
      const error = await assertRejects(
        () => client.start(START),
        ServeLinkError,
      );
      assertEquals(error.message, REQUIRES_PLAN_MESSAGE, JSON.stringify(body));
    });
  }
});

Deno.test("displaySafeReason: an empty reason takes the caller's fallback", () => {
  assertEquals(displaySafeReason(" \u0007 "), "refused");
  assertEquals(displaySafeReason(" \u0007 ", "no plan"), "no plan");
});

Deno.test("ServeLinkClient: report returns the link id, a refusal ack, and terminal conflicts", async () => {
  await withMock(
    () => ({ status: 200, body: { ack: true, linkId: "L1" } }),
    async (client, seen) => {
      assertEquals(await client.report("r1", { outcome: "recorded" }), {
        kind: "recorded",
        linkId: "L1",
      });
      assertEquals(seen[0].path, "/api/v1/serve/links/r1/report");
    },
  );
  await withMock(
    () => ({ status: 200, body: { ack: true } }),
    async (client, seen) => {
      const reason = `not a member\u0000${"x".repeat(500)}`;
      assertEquals(
        await client.report("r1", { outcome: "refused", reason }),
        { kind: "refused" },
      );
      const sent = (seen[0].body as { reason: string }).reason;
      assert(sent.length <= MAX_REFUSAL_REASON);
      assert(!sent.includes("\u0000"));
    },
  );
  for (const code of ["not_approved", "person_unavailable"]) {
    await withMock(
      () => ({ status: 409, body: { error: code } }),
      async (client) => {
        assertEquals(await client.report("r1", { outcome: "recorded" }), {
          kind: "terminal",
          code: code as "not_approved",
        });
      },
    );
  }
});

Deno.test("ServeLinkClient: ending a link swamp-club no longer knows succeeds", async () => {
  await withMock(() => ({ status: 404 }), async (client, seen) => {
    await client.end("L1");
    assertEquals(seen[0].path, "/api/v1/serve/links/L1/end");
  });
  await withMock(() => ({ status: 503 }), async (client) => {
    await assertRejects(() => client.end("L1"), ServeLinkError);
  });
});

Deno.test("ServeLinkClient: an unreachable swamp-club is unavailable, and names no credentials", async () => {
  const client = new ServeLinkClient({
    baseUrl: "http://127.0.0.1:1",
    clientId: "client-1",
    clientSecret: "s3cret",
    timeoutMs: 2000,
  });
  const error = await assertRejects(
    () => client.status("r1"),
    ServeLinkError,
  );
  assertEquals(error.kind, "unavailable");
  assert(!error.message.includes("s3cret"));
});

Deno.test("displaySafeReason: cuts to swamp-club's limit and drops invisible characters", () => {
  assertEquals(displaySafeReason("  a\u200bb\nc  "), "a b c");
  assertEquals(displaySafeReason("\u0001"), "refused");
  assertEquals(displaySafeReason("y".repeat(300)).length, MAX_REFUSAL_REASON);
});

Deno.test("ServeLinkClient: changes passes the cursor and reads a page", async () => {
  await withMock(
    () => ({ status: 200, body: { ended: ["l1"], cursor: "c2", more: true } }),
    async (client, seen) => {
      assertEquals(await client.changes(undefined), {
        ended: ["l1"],
        cursor: "c2",
        more: true,
      });
      await client.changes("a/b=");
      assertEquals(seen[0].path, "/api/v1/serve/links/changes");
      assertEquals(seen[0].search, "");
      assertEquals(seen[1].search, "?since=a%2Fb%3D");
      assertEquals(seen[0].method, "GET");
      assertEquals(seen[0].authorization, `Basic ${btoa("client-1:s3cret")}`);
    },
  );
});

Deno.test("ServeLinkClient: an unreadable cursor answers invalid_cursor, a malformed page is unavailable", async () => {
  await withMock(
    () => ({ status: 400, body: { error: "invalid_cursor" } }),
    async (client) => {
      assertEquals(await client.changes("bad"), "invalid_cursor");
    },
  );
  await withMock(
    () => ({ status: 200, body: { ended: "l1" } }),
    async (client) => {
      const error = await assertRejects(
        () => client.changes(undefined),
        ServeLinkError,
      );
      assertEquals(error.kind, "unavailable");
    },
  );
});

Deno.test("ServeLinkClient: a refused client is unauthorized with swamp-club's code, and a rate limit is not", async () => {
  for (
    const [status, code] of [[401, "invalid_client"], [
      403,
      "client_not_collective",
    ]] as const
  ) {
    await withMock(
      () => ({ status, body: { error: code } }),
      async (client) => {
        const error = await assertRejects(
          () => client.changes(undefined),
          ServeLinkError,
        );
        assertEquals(error.kind, "unauthorized");
        assertEquals(error.code, code);
        assert(!error.message.includes("s3cret"));
      },
    );
  }
  await withMock(
    () => ({ status: 429, body: { error: "too_many_attempts" } }),
    async (client) => {
      const error = await assertRejects(
        () => client.people(["l1"]),
        ServeLinkError,
      );
      assertEquals(error.kind, "rate_limited");
    },
  );
});

Deno.test("ServeLinkClient: people sends link IDs, reads each state, and drops IDs it didn't ask about", async () => {
  await withMock(
    () => ({
      status: 200,
      body: {
        people: [
          {
            linkId: "l1",
            state: "active",
            identity: {
              sub: "p1",
              email: "p@x",
              username: "p",
              collectives: [],
              groups: [],
            },
          },
          { linkId: "l2", state: "suspended" },
          { linkId: "l3", state: "ended", endedReason: "disowned" },
          { linkId: "stranger", state: "suspended" },
        ],
      },
    }),
    async (client, seen) => {
      const people = await client.people(["l1", "l2", "l3"]);
      assertEquals(people.map((p) => [p.linkId, p.state]), [
        ["l1", "active"],
        ["l2", "suspended"],
        ["l3", "ended"],
      ]);
      assertEquals(seen[0].body, { linkIds: ["l1", "l2", "l3"] });
      assertEquals(seen[0].path, "/api/v1/serve/links/people");
    },
  );
});

Deno.test("ServeLinkClient: people refuses more IDs than swamp-club takes", async () => {
  await withMock(
    () => ({ status: 200, body: { people: [] } }),
    async (client, seen) => {
      await assertRejects(
        () => client.people(Array.from({ length: 201 }, (_, i) => `l${i}`)),
        RangeError,
      );
      assertEquals(seen.length, 0);
    },
  );
});
