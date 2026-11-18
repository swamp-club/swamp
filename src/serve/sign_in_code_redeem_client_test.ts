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
  readonly url: string;
  readonly headers: Headers;
  readonly body: unknown;
  readonly redirect: RequestRedirect | undefined;
}

function rootAt(
  answer: () => Response,
): { client: SignInCodeRedeemClient; seen: Seen[] } {
  const seen: Seen[] = [];
  const client = createSignInCodeRedeemClient({
    rootAddress: "https://host.example",
    workspace: "edge-dns",
    fetch: (input, init) => {
      seen.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
        redirect: init?.redirect,
      });
      return Promise.resolve(answer());
    },
  });
  return { client, seen };
}

Deno.test("createSignInCodeRedeemClient: sends the code and its own name, and nothing that authenticates it", async () => {
  const { client, seen } = rootAt(() => Response.json(REPLY));
  const outcome = await client.redeem("swsc1.abc");
  assertEquals(outcome, { ok: true, grant: REPLY });
  assertEquals(seen.length, 1);
  assertEquals(seen[0].url, "https://host.example/auth/sign-in-code/redeem");
  assertEquals(seen[0].body, { code: "swsc1.abc", workspace: "edge-dns" });
  assertEquals(seen[0].headers.get("authorization"), null);
  assertEquals(seen[0].headers.get("cookie"), null);
  assertEquals(seen[0].redirect, "manual");
});

Deno.test("createSignInCodeRedeemClient: only a root's own refusal is a refusal; any other answer is the root being unavailable", async () => {
  const refused = rootAt(() =>
    Response.json({ error: "sign_in_code_refused" }, { status: 404 })
  );
  assertEquals(await refused.client.redeem("swsc1.abc"), {
    ok: false,
    reason: "refused",
  });
  for (
    const answer of [
      () => new Response("Not Found", { status: 404 }),
      () => Response.json({ error: "not_found" }, { status: 404 }),
      () => new Response("down", { status: 503 }),
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.example/" },
        }),
    ]
  ) {
    const outcome = await rootAt(answer).client.redeem("swsc1.abc");
    assert(!outcome.ok && outcome.reason === "unavailable");
    assert(outcome.detail.includes("https://host.example"));
  }
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
  const { client } = rootAt(() =>
    Response.json({ ...REPLY, collectives: ["x".repeat(70 * 1024)] })
  );
  const outcome = await client.redeem("swsc1.abc");
  assert(!outcome.ok && outcome.reason === "unavailable");
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
