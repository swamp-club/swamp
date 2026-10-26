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

import { assertEquals, assertThrows } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import type {
  WhoamiCollectiveEntitlement,
  WhoamiIdentity,
} from "../../libswamp/auth/whoami.ts";
import type { SubscriptionStatusView } from "../../libswamp/subscription/status.ts";
import { UserError } from "../../domain/errors.ts";
import type { OutputMode } from "../output/output.ts";
import { createAuthWhoamiRenderer } from "./auth_whoami.ts";
import {
  callToActionLabel,
  createSubscriptionStatusRenderer,
} from "./subscription_status.ts";

const team: WhoamiCollectiveEntitlement = {
  slug: "swamp-club",
  plan: "team",
  planName: "Team",
  subscriptionStatus: "active",
  trial: {
    state: "expired",
    startedAt: "2026-06-01T00:00:00Z",
    endsAt: "2026-07-01T00:00:00Z",
    daysRemaining: 0,
  },
};

const trialing: WhoamiCollectiveEntitlement = {
  slug: "stack72",
  plan: "free",
  planName: "Free",
  trial: {
    state: "active",
    startedAt: "2026-10-04T00:00:00Z",
    endsAt: "2026-11-03T00:00:00Z",
    daysRemaining: 9,
  },
};

function makeStatus(
  overrides: Partial<SubscriptionStatusView> = {},
): SubscriptionStatusView {
  return {
    serverUrl: "https://swamp-club.com",
    collectiveToken: false,
    username: "stack72",
    email: "stack72@example.com",
    plan: "team",
    planName: "Team",
    entitlementsReported: true,
    collectives: [trialing, team],
    billingUrl: "https://swamp-club.com/billing",
    ...overrides,
  };
}

function makeTokenStatus(
  overrides: Partial<SubscriptionStatusView> = {},
): SubscriptionStatusView {
  const { username: _u, email: _e, ...rest } = makeStatus(overrides);
  return { ...rest, collectiveToken: true, collectiveSlug: "swamp-club" };
}

function capture(
  status: SubscriptionStatusView,
  mode: OutputMode,
): string {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    createSubscriptionStatusRenderer(mode).handlers().completed({
      kind: "completed",
      status,
    });
  } finally {
    console.log = originalLog;
  }
  return stripAnsiCode(logs.join("\n"));
}

function captureWhoamiFirstLine(identity: WhoamiIdentity): string {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    createAuthWhoamiRenderer("log").handlers().completed({
      kind: "completed",
      identity,
    });
  } finally {
    console.log = originalLog;
  }
  return stripAnsiCode(logs[0]);
}

Deno.test("LogSubscriptionStatusRenderer: prints identity, plan, aligned collectives and the billing link", () => {
  assertEquals(
    capture(makeStatus(), "log"),
    [
      "stack72 (stack72@example.com) on https://swamp-club.com",
      "Plan: Team",
      "Collectives:",
      "  stack72     trial: 9 days left (ends 2026-11-03)\n" +
      "  swamp-club  Team  active",
      "",
      "To manage billing:  https://swamp-club.com/billing",
    ].join("\n"),
  );
});

Deno.test("LogSubscriptionStatusRenderer: the identity line is worded as auth whoami words it", () => {
  const status = makeStatus();
  assertEquals(
    capture(status, "log").split("\n")[0],
    captureWhoamiFirstLine({
      serverUrl: status.serverUrl,
      id: "user-1",
      username: status.username!,
      email: status.email!,
      name: "Stack",
    }),
  );

  const token = makeTokenStatus();
  assertEquals(
    capture(token, "log").split("\n")[0],
    captureWhoamiFirstLine({
      serverUrl: token.serverUrl,
      id: "",
      username: "",
      email: "",
      name: "",
      collectiveToken: true,
      collectiveSlug: token.collectiveSlug,
    }),
  );
  assertEquals(
    capture(token, "log").split("\n")[0],
    "Collective token: swamp-club on https://swamp-club.com",
  );
});

Deno.test("LogSubscriptionStatusRenderer: no Plan line when there is no plan name", () => {
  const output = capture(
    makeStatus({ plan: "free", planName: null, collectives: [trialing] }),
    "log",
  );

  assertEquals(output.includes("Plan:"), false);
  assertEquals(
    output.endsWith("To upgrade:  https://swamp-club.com/billing"),
    true,
  );
});

Deno.test("LogSubscriptionStatusRenderer: Admin standing has no call to action", () => {
  const output = capture(
    makeStatus({ plan: "admin", planName: "Admin" }),
    "log",
  );

  assertEquals(output.includes("billing"), false);
  assertEquals(output.includes("To upgrade"), false);
  assertEquals(output.split("\n").at(-1), "  swamp-club  Team  active");
});

Deno.test("LogSubscriptionStatusRenderer: a server without entitlement says so, with no call to action", () => {
  assertEquals(
    capture(
      makeStatus({
        plan: null,
        planName: null,
        entitlementsReported: false,
        collectives: [],
      }),
      "log",
    ),
    "stack72 (stack72@example.com) on https://swamp-club.com\n" +
      "This Swamp Club server does not report subscriptions.",
  );
});

Deno.test("LogSubscriptionStatusRenderer: an error throws UserError", () => {
  assertThrows(
    () =>
      createSubscriptionStatusRenderer("log").handlers().error({
        kind: "error",
        error: { code: "not_authenticated", message: "Not authenticated" },
      }),
    UserError,
    "Not authenticated",
  );
});

Deno.test("callToActionLabel: upgrade for no plan, free and a Personal License", () => {
  assertEquals(callToActionLabel(null), "To upgrade:");
  assertEquals(callToActionLabel("free"), "To upgrade:");
  assertEquals(callToActionLabel("personal"), "To upgrade:");
});

Deno.test("callToActionLabel: manage billing for paid plans and unknown ones", () => {
  for (const plan of ["team", "business", "enterprise", "galactic"]) {
    assertEquals(callToActionLabel(plan), "To manage billing:", plan);
  }
});

Deno.test("callToActionLabel: none for Admin standing", () => {
  assertEquals(callToActionLabel("admin"), undefined);
});

Deno.test("JsonSubscriptionStatusRenderer: prints exactly the documented keys, in order", () => {
  const doc = JSON.parse(capture(makeStatus(), "json"));

  assertEquals(Object.keys(doc), [
    "serverUrl",
    "username",
    "plan",
    "planName",
    "entitlementsReported",
    "collectives",
    "billingUrl",
  ]);
  assertEquals(doc, {
    serverUrl: "https://swamp-club.com",
    username: "stack72",
    plan: "team",
    planName: "Team",
    entitlementsReported: true,
    collectives: [trialing, team],
    billingUrl: "https://swamp-club.com/billing",
  });
});

Deno.test("JsonSubscriptionStatusRenderer: a paid collective keeps its trial", () => {
  const doc = JSON.parse(capture(makeStatus(), "json"));

  assertEquals(doc.collectives[1].trial, team.trial);
});

Deno.test("JsonSubscriptionStatusRenderer: a collective token replaces username with collectiveSlug", () => {
  const doc = JSON.parse(capture(makeTokenStatus(), "json"));

  assertEquals(Object.keys(doc), [
    "serverUrl",
    "collectiveSlug",
    "plan",
    "planName",
    "entitlementsReported",
    "collectives",
    "billingUrl",
  ]);
  assertEquals(doc.collectiveSlug, "swamp-club");
});

Deno.test("JsonSubscriptionStatusRenderer: absent plan fields are null and no entitlement is an empty list", () => {
  const doc = JSON.parse(capture(
    makeStatus({
      plan: null,
      planName: null,
      entitlementsReported: false,
      collectives: [],
    }),
    "json",
  ));

  assertEquals(doc.plan, null);
  assertEquals(doc.planName, null);
  assertEquals(doc.entitlementsReported, false);
  assertEquals(doc.collectives, []);
});

Deno.test("JsonSubscriptionStatusRenderer: intermediate events print nothing", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    const handlers = createSubscriptionStatusRenderer("json").handlers();
    handlers.loading_credentials({ kind: "loading_credentials" });
    handlers.contacting_server({
      kind: "contacting_server",
      serverUrl: "https://swamp-club.com",
    });
  } finally {
    console.log = originalLog;
  }
  assertEquals(logs, []);
});
