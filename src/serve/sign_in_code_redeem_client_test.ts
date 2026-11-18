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
import {
  createSignInCodeRedeemClient,
  parseRedeemReply,
  type SignInCodeRedeemClient,
} from "./sign_in_code_redeem_client.ts";

const REPLY = {
  principal: "user:sub-alice",
  username: "alice",
  email: "alice@example.com",
  collectives: ["acme"],
  groups: ["ops"],
  expiresAt: "2099-01-01T00:00:00.000Z",
};

interface Seen {
  readonly path: string;
  readonly headers: Headers;
  readonly body: unknown;
}

async function withRoot(
  answer: () => Response,
  fn: (client: SignInCodeRedeemClient, seen: Seen[]) => Promise<void>,
): Promise<void> {
  const seen: Seen[] = [];
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (req) => {
      seen.push({
        path: new URL(req.url).pathname,
        headers: req.headers,
        body: await req.json(),
      });
      return answer();
    },
  );
  try {
    await fn(
      createSignInCodeRedeemClient({
        rootAddress: `http://127.0.0.1:${server.addr.port}`,
        workspace: "edge-dns",
      }),
      seen,
    );
  } finally {
    await server.shutdown();
  }
}

Deno.test("createSignInCodeRedeemClient: sends the code and its own name, and nothing that authenticates it", async () => {
  await withRoot(() => Response.json(REPLY), async (client, seen) => {
    const outcome = await client.redeem("swsc1.abc");
    assertEquals(outcome, { ok: true, grant: REPLY });
    assertEquals(seen.length, 1);
    assertEquals(seen[0].path, "/auth/sign-in-code/redeem");
    assertEquals(seen[0].body, { code: "swsc1.abc", workspace: "edge-dns" });
    assertEquals(seen[0].headers.get("authorization"), null);
    assertEquals(seen[0].headers.get("cookie"), null);
  });
});

Deno.test("createSignInCodeRedeemClient: a 404 is a refusal; any other status is the root being unavailable", async () => {
  await withRoot(
    () => Response.json({ error: "not_found" }, { status: 404 }),
    async (client) => {
      assertEquals(await client.redeem("swsc1.abc"), {
        ok: false,
        reason: "refused",
      });
    },
  );
  await withRoot(
    () => new Response("down", { status: 503 }),
    async (client) => {
      const outcome = await client.redeem("swsc1.abc");
      assert(!outcome.ok && outcome.reason === "unavailable");
      assert(outcome.detail.includes("503"));
    },
  );
});

Deno.test("createSignInCodeRedeemClient: a redirect is not followed", async () => {
  await withRoot(
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1:1/elsewhere" },
      }),
    async (client) => {
      const outcome = await client.redeem("swsc1.abc");
      assert(!outcome.ok && outcome.reason === "unavailable");
    },
  );
});

Deno.test("createSignInCodeRedeemClient: an unreachable root names its address", async () => {
  const client = createSignInCodeRedeemClient({
    rootAddress: "http://root.invalid",
    workspace: "edge-dns",
    fetch: () => Promise.reject(new TypeError("connection refused")),
  });
  const outcome = await client.redeem("swsc1.abc");
  assert(!outcome.ok && outcome.reason === "unavailable");
  assert(outcome.detail.includes("http://root.invalid"));
});

Deno.test("createSignInCodeRedeemClient: a reply past its size limit is refused", async () => {
  await withRoot(
    () => Response.json({ ...REPLY, collectives: ["x".repeat(70 * 1024)] }),
    async (client) => {
      const outcome = await client.redeem("swsc1.abc");
      assert(!outcome.ok && outcome.reason === "unavailable");
    },
  );
});

Deno.test("parseRedeemReply: refuses every reply a root would not send", () => {
  const hostile: unknown[] = [
    null,
    "user:sub-alice",
    { ...REPLY, principal: "worker:edge-1" },
    { ...REPLY, principal: "service:scheduler" },
    { ...REPLY, principal: "nobody" },
    { ...REPLY, principal: 7 },
    { ...REPLY, username: 7 },
    { ...REPLY, email: ["a"] },
    { ...REPLY, collectives: "acme" },
    { ...REPLY, collectives: [1] },
    { ...REPLY, groups: Array.from({ length: 257 }, () => "g") },
    { ...REPLY, expiresAt: "soon" },
    { ...REPLY, expiresAt: undefined },
  ];
  for (const reply of hostile) {
    assertEquals(parseRedeemReply(reply), null, JSON.stringify(reply));
  }
  assertEquals(parseRedeemReply({ ...REPLY, username: null, email: null }), {
    ...REPLY,
    username: null,
    email: null,
  });
});
