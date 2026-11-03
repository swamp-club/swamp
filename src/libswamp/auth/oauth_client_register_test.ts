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
import { UserError } from "../../domain/errors.ts";
import { withMockedEnv } from "../../infrastructure/persistence/path_test_helpers.ts";
import { createLibSwampContext } from "../context.ts";
import { collect } from "../testing.ts";
import {
  authOAuthClientRegister,
  type AuthOAuthClientRegisterDeps,
  type AuthOAuthClientRegisterEvent,
  canonicalServerUrl,
  createAuthOAuthClientRegisterDeps,
} from "./oauth_client_register.ts";

interface RegisterCall {
  provider: string;
  apiKey: string;
  clientName: string;
}

function makeDeps(
  overrides: Partial<AuthOAuthClientRegisterDeps> = {},
): { deps: AuthOAuthClientRegisterDeps; calls: RegisterCall[] } {
  const calls: RegisterCall[] = [];
  return {
    calls,
    deps: {
      resolveApiKey: () => "swamp_org_key",
      keyServerUrl: () => "https://swamp-club.com",
      registerClient: (provider, apiKey, clientName) => {
        calls.push({ provider, apiKey, clientName });
        return Promise.resolve({
          clientId: "client-id",
          clientSecret: "client-secret",
        });
      },
      ...overrides,
    },
  };
}

function run(
  deps: AuthOAuthClientRegisterDeps,
  input: { name: string; provider?: string },
): Promise<AuthOAuthClientRegisterEvent[]> {
  return collect(authOAuthClientRegister(createLibSwampContext(), deps, input));
}

Deno.test("authOAuthClientRegister: registers on the default provider and returns the id and secret", async () => {
  const { deps, calls } = makeDeps();
  const events = await run(deps, { name: "prod-api-server" });
  assertEquals(calls, [{
    provider: "https://swamp-club.com",
    apiKey: "swamp_org_key",
    clientName: "prod-api-server",
  }]);
  assertEquals(events.map((e) => e.kind), ["registering", "completed"]);
  const completed = events[1];
  assertEquals(completed.kind === "completed" && completed.data, {
    clientId: "client-id",
    clientName: "prod-api-server",
    clientSecret: "client-secret",
    provider: "https://swamp-club.com",
  });
});

Deno.test("authOAuthClientRegister: without --oauth-provider registers with the server that issued the key", async () => {
  const { deps, calls } = makeDeps({
    keyServerUrl: () => "https://club.corp.example",
  });
  await run(deps, { name: "private" });
  assertEquals(calls[0].provider, "https://club.corp.example");
});

Deno.test("authOAuthClientRegister: an --oauth-provider matching the key's server is used", async () => {
  const { deps, calls } = makeDeps({
    keyServerUrl: () => "http://localhost:8000",
  });
  const events = await run(deps, {
    name: "local",
    provider: "http://localhost:8000/",
  });
  assertEquals(calls[0].provider, "http://localhost:8000");
  const completed = events.find((e) => e.kind === "completed");
  assertEquals(
    completed?.kind === "completed" && completed.data.provider,
    "http://localhost:8000",
  );
});

Deno.test("authOAuthClientRegister: never sends the key to an --oauth-provider that did not issue it", async () => {
  const { deps, calls } = makeDeps({
    keyServerUrl: () => "https://club.corp.example",
  });
  const events = await run(deps, {
    name: "x",
    provider: "https://swamp-club.com",
  });
  assertEquals(calls, []);
  assertEquals(events.length, 1);
  const error = events[0].kind === "error" ? events[0].error.message : "";
  assertEquals(error.includes("set SWAMP_CLUB_URL"), true);
});

Deno.test("authOAuthClientRegister: refuses a non-HTTPS provider as serve does", async () => {
  const { deps, calls } = makeDeps();
  const events = await run(deps, {
    name: "x",
    provider: "http://club.example.com",
  });
  assertEquals(calls, []);
  assertEquals(events.length, 1);
  assertEquals(
    events[0].kind === "error" && events[0].error.code,
    "validation_failed",
  );
});

Deno.test("authOAuthClientRegister: refuses without a collective API key", async () => {
  const { deps, calls } = makeDeps({ resolveApiKey: () => undefined });
  const events = await run(deps, { name: "prod" });
  assertEquals(calls, []);
  assertEquals(
    events[0].kind === "error" &&
      events[0].error.message.includes("oauth:manage"),
    true,
  );
});

Deno.test("authOAuthClientRegister: a broken key source is an error event, not a throw", async () => {
  const { deps, calls } = makeDeps({
    resolveApiKey: () => {
      throw new UserError("SWAMP_API_KEY_FILE file not found: /nope");
    },
  });
  const events = await run(deps, { name: "prod" });
  assertEquals(calls, []);
  assertEquals(
    events[0].kind === "error" && events[0].error.message.includes("not found"),
    true,
  );
});

Deno.test("authOAuthClientRegister: refuses an empty name", async () => {
  const { deps, calls } = makeDeps();
  const events = await run(deps, { name: "  " });
  assertEquals(calls, []);
  assertEquals(events[0].kind, "error");
});

Deno.test("authOAuthClientRegister: a failed registration is an error event, not a throw", async () => {
  const { deps } = makeDeps({
    registerClient: () =>
      Promise.reject(
        new Error("OAuth client registration via API key failed: 403"),
      ),
  });
  const events = await run(deps, { name: "prod" });
  assertEquals(events.map((e) => e.kind), ["registering", "error"]);
  assertEquals(
    events[1].kind === "error" && events[1].error.code,
    "registration_failed",
  );
});

Deno.test("canonicalServerUrl: strips trailing slashes and maps the legacy domain", () => {
  assertEquals(
    canonicalServerUrl("https://swamp-club.com/"),
    "https://swamp-club.com",
  );
  assertEquals(
    canonicalServerUrl("https://swamp.club"),
    "https://swamp-club.com",
  );
  assertEquals(
    canonicalServerUrl("http://localhost:8000//"),
    "http://localhost:8000",
  );
});

Deno.test("createAuthOAuthClientRegisterDeps: the key's server is SWAMP_CLUB_URL, else swamp-club.com", () => {
  withMockedEnv({ SWAMP_CLUB_URL: undefined }, () => {
    assertEquals(
      createAuthOAuthClientRegisterDeps().keyServerUrl(),
      "https://swamp-club.com",
    );
  });
  withMockedEnv({ SWAMP_CLUB_URL: " https://club.corp.example/ " }, () => {
    assertEquals(
      canonicalServerUrl(createAuthOAuthClientRegisterDeps().keyServerUrl()),
      "https://club.corp.example",
    );
  });
});

Deno.test("authOAuthClientRegister: --oauth-provider on the legacy domain matches a key for swamp-club.com", async () => {
  const { deps, calls } = makeDeps();
  await run(deps, { name: "x", provider: "https://swamp.club" });
  assertEquals(calls[0].provider, "https://swamp-club.com");
});
