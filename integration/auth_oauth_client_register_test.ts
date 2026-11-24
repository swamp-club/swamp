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

import { assertEquals } from "@std/assert";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { collect } from "../src/libswamp/testing.ts";
import {
  authOAuthClientRegister,
  createAuthOAuthClientRegisterDeps,
} from "../src/libswamp/auth/oauth_client_register.ts";

interface SeenRequest {
  method: string;
  path: string;
  authorization: string | null;
  body: Record<string, unknown> | null;
}

function startProvider(scopes: string[]) {
  const seen: SeenRequest[] = [];
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (req) => {
      const path = new URL(req.url).pathname;
      const text = await req.text();
      seen.push({
        method: req.method,
        path,
        authorization: req.headers.get("authorization"),
        body: text ? JSON.parse(text) as Record<string, unknown> : null,
      });
      if (path === "/api/whoami") return Response.json({ scopes });
      if (path === "/api/auth/oauth2/register") {
        return Response.json({
          client_id: "registered-client-id",
          client_secret: "registered-client-secret",
        });
      }
      return new Response("not found", { status: 404 });
    },
  );
  return { server, seen, url: `http://127.0.0.1:${server.addr.port}` };
}

function register(providerUrl: string, apiKey: string) {
  return withMockedEnv(
    {
      SWAMP_CLUB_URL: providerUrl,
      SWAMP_API_KEY: apiKey,
      SWAMP_API_KEY_FILE: undefined,
    },
    () =>
      collect(
        authOAuthClientRegister(
          createLibSwampContext(),
          createAuthOAuthClientRegisterDeps(),
          { name: "prod-api-server" },
        ),
      ),
  );
}

Deno.test("auth oauth-client register: the real deps register through the provider's HTTP API with the key from the environment", async () => {
  const apiKey = `swamp_org_${crypto.randomUUID()}`;
  const provider = startProvider(["oauth:manage"]);
  try {
    const events = await register(provider.url, apiKey);
    const last = events[events.length - 1];
    assertEquals(last.kind, "completed");
    if (last.kind !== "completed") return;
    assertEquals(last.data, {
      clientId: "registered-client-id",
      clientName: "prod-api-server",
      clientSecret: "registered-client-secret",
      provider: provider.url,
    });
    assertEquals(
      provider.seen.map((r) => [r.method, r.path, r.authorization]),
      [
        ["GET", "/api/whoami", `Bearer ${apiKey}`],
        ["POST", "/api/auth/oauth2/register", `Bearer ${apiKey}`],
      ],
    );
    assertEquals(provider.seen[1].body?.client_name, "prod-api-server");
  } finally {
    await provider.server.shutdown();
  }
});

Deno.test("auth oauth-client register: a key without oauth:manage fails before the register endpoint is called", async () => {
  const provider = startProvider(["serve:*"]);
  try {
    const events = await register(
      provider.url,
      `swamp_org_${crypto.randomUUID()}`,
    );
    const last = events[events.length - 1];
    assertEquals(
      last.kind === "error" && last.error.code,
      "registration_failed",
    );
    assertEquals(
      last.kind === "error" && last.error.message.includes("oauth:manage"),
      true,
    );
    assertEquals(provider.seen.map((r) => r.path), ["/api/whoami"]);
  } finally {
    await provider.server.shutdown();
  }
});
