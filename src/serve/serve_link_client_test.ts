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
  ServeLinkClient,
  ServeLinkError,
} from "./serve_link_client.ts";

interface Seen {
  method: string;
  path: string;
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
  assertEquals(displaySafeReason("  a​b\nc  "), "a b c");
  assertEquals(displaySafeReason("\u0001"), "refused");
  assertEquals(displaySafeReason("y".repeat(300)).length, MAX_REFUSAL_REASON);
});
