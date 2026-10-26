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

import { assertEquals, assertStrictEquals } from "@std/assert";
import type { AuthCredentials } from "../../domain/auth/auth_credentials.ts";
import type { WhoamiResponse } from "../../infrastructure/http/swamp_club_client.ts";
import { type AuthDeps, entitlementsOf } from "../auth/whoami.ts";
import { createLibSwampContext } from "../context.ts";
import { collect } from "../testing.ts";
import {
  billingUrl,
  subscriptionStatus,
  type SubscriptionStatusEvent,
  type SubscriptionStatusView,
} from "./status.ts";

const credentials: AuthCredentials = {
  serverUrl: "https://swamp-club.com",
  apiKey: "swamp_test_key",
  apiKeyId: "key-1",
  username: "keeb",
};

/** The response a current swamp-club returns for an owner (see whoami_test). */
const ownerFixture: WhoamiResponse = JSON.parse(
  await Deno.readTextFile(
    new URL("../auth/whoami_response.fixture.json", import.meta.url),
  ),
);

function makeDeps(overrides: {
  credentials?: AuthCredentials | null;
  response?: WhoamiResponse;
  serverUrlOverride?: string;
  fetchWhoami?: AuthDeps["fetchWhoami"];
}): AuthDeps {
  return {
    loadCredentials: () =>
      Promise.resolve(
        overrides.credentials === undefined
          ? credentials
          : overrides.credentials,
      ),
    saveCredentials: () => Promise.resolve(),
    fetchWhoami: overrides.fetchWhoami ??
      (() => Promise.resolve(overrides.response ?? ownerFixture)),
    serverUrlOverride: overrides.serverUrlOverride,
  };
}

async function statusOf(deps: AuthDeps): Promise<SubscriptionStatusView> {
  const events = await collect<SubscriptionStatusEvent>(
    subscriptionStatus(createLibSwampContext(), deps),
  );
  const last = events.at(-1);
  if (last?.kind !== "completed") {
    throw new Error(`expected completed, got ${JSON.stringify(last)}`);
  }
  return last.status;
}

async function errorCodeOf(
  deps: AuthDeps,
  signal?: AbortSignal,
): Promise<string> {
  const events = await collect<SubscriptionStatusEvent>(
    subscriptionStatus(createLibSwampContext({ signal }), deps),
  );
  const last = events.at(-1);
  if (last?.kind !== "error") {
    throw new Error(`expected error, got ${JSON.stringify(last)}`);
  }
  return last.error.code;
}

Deno.test("subscriptionStatus: maps the owner fixture onto the view", async () => {
  const deps = makeDeps({});
  const events = await collect<SubscriptionStatusEvent>(
    subscriptionStatus(createLibSwampContext(), deps),
  );

  assertEquals(events.slice(0, 2), [
    { kind: "loading_credentials" },
    { kind: "contacting_server", serverUrl: "https://swamp-club.com" },
  ]);
  assertEquals(events.at(-1), {
    kind: "completed",
    status: {
      serverUrl: "https://swamp-club.com",
      collectiveToken: false,
      username: "keeb",
      email: "test@example.com",
      plan: "team",
      planName: "Team",
      entitlementsReported: true,
      // The entitlements whoami mapped, exactly — not the raw server payload.
      collectives: entitlementsOf(ownerFixture)!,
      billingUrl: "https://swamp-club.com/billing",
    },
  });
});

Deno.test("subscriptionStatus: fields whoami does not map never reach the view", async () => {
  const counted = {
    ...ownerFixture.collectiveEntitlements![0],
    serveInstanceCount: 3,
  };
  const response = { ...ownerFixture, collectiveEntitlements: [counted] };

  const status = await statusOf(makeDeps({ response }));

  assertEquals("serveInstanceCount" in status.collectives[0], false);
});

Deno.test("subscriptionStatus: no entitlements from the server is not reported", async () => {
  const { collectiveEntitlements: _, ...older } = ownerFixture;

  const status = await statusOf(makeDeps({ response: older }));

  assertEquals(status.entitlementsReported, false);
  assertEquals(status.collectives, []);
});

Deno.test("subscriptionStatus: an empty entitlement list is not reported either", async () => {
  const status = await statusOf(
    makeDeps({ response: { ...ownerFixture, collectiveEntitlements: [] } }),
  );

  assertEquals(status.entitlementsReported, false);
  assertEquals(status.collectives, []);
});

Deno.test("subscriptionStatus: a collective token names its collective, not a user", async () => {
  const status = await statusOf(makeDeps({
    response: {
      authenticated: true,
      collectiveToken: true,
      collectiveSlug: "acme",
      scopes: ["extensions:push"],
      plan: "team",
      collectiveEntitlements: [{
        slug: "acme",
        plan: "team",
        planName: "Team",
      }],
    },
  }));

  assertEquals(status.collectiveToken, true);
  assertEquals(status.collectiveSlug, "acme");
  assertEquals("username" in status, false);
  assertEquals("email" in status, false);
  assertEquals(status.planName, "Team");
});

Deno.test("subscriptionStatus: a Personal License rolls up to its license name", async () => {
  const status = await statusOf(makeDeps({
    response: {
      ...ownerFixture,
      plan: "personal",
      collectiveEntitlements: [{
        slug: "keeb",
        plan: "personal",
        planName: "Personal License",
        subscriptionStatus: null,
        trial: null,
      }],
    },
  }));

  assertEquals(status.plan, "personal");
  assertEquals(status.planName, "Personal License");
});

Deno.test("subscriptionStatus: Admin standing rolls up to Admin", async () => {
  const status = await statusOf(makeDeps({
    response: {
      ...ownerFixture,
      plan: "admin",
      collectiveEntitlements: [
        { slug: "acme", plan: "team", planName: "Team" },
        { slug: "swamp", plan: "admin", planName: "Admin" },
      ],
    },
  }));

  assertEquals(status.plan, "admin");
  assertEquals(status.planName, "Admin");
});

Deno.test("subscriptionStatus: a free strongest plan has no plan name", async () => {
  const status = await statusOf(makeDeps({
    response: {
      ...ownerFixture,
      plan: "free",
      collectiveEntitlements: [{
        slug: "keeb",
        plan: "free",
        planName: "Free",
      }],
    },
  }));

  assertEquals(status.plan, "free");
  assertStrictEquals(status.planName, null);
});

Deno.test("subscriptionStatus: no plan from the server is null, not absent", async () => {
  const { plan: _, ...noPlan } = ownerFixture;

  const status = await statusOf(makeDeps({ response: noPlan }));

  assertStrictEquals(status.plan, null);
  assertStrictEquals(status.planName, null);
});

Deno.test("subscriptionStatus: no credential passes notAuthenticated through", async () => {
  assertEquals(
    await errorCodeOf(makeDeps({ credentials: null })),
    "not_authenticated",
  );
});

Deno.test("subscriptionStatus: a revoked key passes invalidApiKey through", async () => {
  assertEquals(
    await errorCodeOf(makeDeps({ response: { authenticated: false } })),
    "invalid_api_key",
  );
});

Deno.test("subscriptionStatus: an aborted call passes cancelled through", async () => {
  const controller = new AbortController();
  controller.abort();

  assertEquals(
    await errorCodeOf(
      makeDeps({
        fetchWhoami: (_serverUrl, _apiKey, signal) => {
          signal.throwIfAborted();
          return Promise.resolve(ownerFixture);
        },
      }),
      controller.signal,
    ),
    "cancelled",
  );
});

Deno.test("subscriptionStatus: the whoami call carries the context's signal", async () => {
  const controller = new AbortController();
  let received: AbortSignal | undefined;

  await collect<SubscriptionStatusEvent>(subscriptionStatus(
    createLibSwampContext({ signal: controller.signal }),
    makeDeps({
      fetchWhoami: (_serverUrl, _apiKey, signal) => {
        received = signal;
        return Promise.resolve(ownerFixture);
      },
    }),
  ));

  assertStrictEquals(received, controller.signal);
});

Deno.test("subscriptionStatus: serverUrlOverride wins over the stored credential", async () => {
  let calledWith: string | undefined;

  const status = await statusOf(makeDeps({
    serverUrlOverride: "https://club.example.com/",
    fetchWhoami: (serverUrl) => {
      calledWith = serverUrl;
      return Promise.resolve(ownerFixture);
    },
  }));

  assertEquals(calledWith, "https://club.example.com/");
  assertEquals(status.serverUrl, "https://club.example.com/");
  assertEquals(status.billingUrl, "https://club.example.com/billing");
});

Deno.test("billingUrl: appends /billing without a doubled slash", () => {
  assertEquals(
    billingUrl("https://swamp-club.com"),
    "https://swamp-club.com/billing",
  );
  assertEquals(
    billingUrl("https://swamp-club.com/"),
    "https://swamp-club.com/billing",
  );
  assertEquals(
    billingUrl("https://swamp-club.com//"),
    "https://swamp-club.com/billing",
  );
});

Deno.test("billingUrl: a collective opens its own billing page, slug encoded", () => {
  assertEquals(
    billingUrl("https://swamp-club.com", "acme"),
    "https://swamp-club.com/o/acme/billing",
  );
  assertEquals(
    billingUrl("https://swamp-club.com/", "acme"),
    "https://swamp-club.com/o/acme/billing",
  );
  assertEquals(
    billingUrl("https://swamp-club.com", "a b&c"),
    "https://swamp-club.com/o/a%20b%26c/billing",
  );
});
