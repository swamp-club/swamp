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

import { assertEquals, assertRejects } from "@std/assert";
import { withMockedFetch } from "./mock_fetch.ts";

// --- Sequential mode ---

Deno.test("withMockedFetch: sequential mode returns responses in order", async () => {
  const { result, calls } = await withMockedFetch([
    Response.json({ value: "first" }),
    Response.json({ value: "second" }),
  ], async () => {
    const r1 = await fetch("https://api.example.com/one");
    const r2 = await fetch("https://api.example.com/two");
    return {
      first: await r1.json(),
      second: await r2.json(),
    };
  });

  assertEquals(result.first.value, "first");
  assertEquals(result.second.value, "second");
  assertEquals(calls.length, 2);
  assertEquals(calls[0].url, "https://api.example.com/one");
  assertEquals(calls[1].url, "https://api.example.com/two");
});

Deno.test("withMockedFetch: sequential mode throws when exhausted", async () => {
  await assertRejects(
    () =>
      withMockedFetch([
        Response.json({ ok: true }),
      ], async () => {
        await fetch("https://api.example.com/one");
        await fetch("https://api.example.com/two"); // no response queued
      }),
    Error,
    "no more responses",
  );
});

// --- Handler mode ---

Deno.test("withMockedFetch: handler mode routes by URL", async () => {
  const { result } = await withMockedFetch((req) => {
    if (req.url.includes("/secrets")) {
      return Response.json({ secret: "sk-123" });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }, async () => {
    const r = await fetch("https://api.example.com/secrets");
    return await r.json();
  });

  assertEquals(result.secret, "sk-123");
});

Deno.test("withMockedFetch: handler receives request body", async () => {
  const { calls } = await withMockedFetch(async (req) => {
    const body = await req.json();
    return Response.json({ echo: body.message });
  }, async () => {
    await fetch("https://api.example.com/echo", {
      method: "POST",
      body: JSON.stringify({ message: "hello" }),
    });
  });

  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "POST");
  assertEquals(calls[0].body, '{"message":"hello"}');
});

// --- Call recording ---

Deno.test("withMockedFetch: captures headers", async () => {
  const { calls } = await withMockedFetch([
    Response.json({}),
  ], async () => {
    await fetch("https://api.example.com/test", {
      headers: { "Authorization": "Bearer token123" },
    });
  });

  assertEquals(calls[0].headers["authorization"], "Bearer token123");
});

// --- Restore ---

Deno.test("withMockedFetch: restores original fetch after success", async () => {
  const originalFetch = globalThis.fetch;
  await withMockedFetch([], () => {});
  assertEquals(globalThis.fetch, originalFetch);
});

Deno.test("withMockedFetch: restores original fetch after error", async () => {
  const originalFetch = globalThis.fetch;
  try {
    await withMockedFetch([], () => {
      throw new Error("test error");
    });
  } catch {
    // expected
  }
  assertEquals(globalThis.fetch, originalFetch);
});

// --- Return value ---

Deno.test("withMockedFetch: returns callback result", async () => {
  const { result } = await withMockedFetch([
    Response.json({ val: 42 }),
  ], async () => {
    const r = await fetch("https://api.example.com/number");
    const data = await r.json();
    return data.val as number;
  });

  assertEquals(result, 42);
});
