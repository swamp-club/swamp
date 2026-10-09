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
import fc from "fast-check";
import {
  collectiveBillingUrl,
  type CollectiveEntitlement,
  type CollectiveTrial,
  evaluatePrivateEntitlement,
  evaluateVersionExists,
  explainPrivatePublishRefusal,
  promoteCommand,
} from "./extension_publish_checks.ts";

const SERVER = "https://registry.test";
const REFUSAL = "Private publication requires a paid plan";

/** The plans the registry knows, as id and label. */
const PLANS = [
  { plan: "free", planName: "Free" },
  { plan: "team", planName: "Team" },
  { plan: "business", planName: "Business" },
  { plan: "enterprise", planName: "Enterprise" },
] as const;

const trialArb = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.record({
    state: fc.constantFrom<CollectiveTrial["state"]>(
      "none",
      "active",
      "expired",
    ),
    endsAt: fc.oneof(
      fc.constant(null),
      fc.date({
        min: new Date("2020-01-01T00:00:00.000Z"),
        max: new Date("2030-12-31T00:00:00.000Z"),
        noInvalidDate: true,
      }).map((d) => d.toISOString()),
    ),
    daysRemaining: fc.nat({ max: 60 }),
  }),
);

/** An entitlement the registry reported, with or without a plan label. */
const reportedArb = fc.record({
  known: fc.constantFrom(...PLANS),
  labelled: fc.boolean(),
  trial: trialArb,
}).map(({ known, labelled, trial }): CollectiveEntitlement => ({
  slug: "acme",
  plan: known.plan,
  ...(labelled ? { planName: known.planName } : {}),
  ...(trial !== undefined ? { trial } : {}),
}));

/** The plan labels a message may not mention unless the registry sent them. */
function foreignLabels(entitlement: CollectiveEntitlement): string[] {
  const own = new Set(
    [entitlement.plan, entitlement.planName].filter((x): x is string =>
      x !== undefined
    ).map((x) => x.toLowerCase()),
  );
  return PLANS.map((p) => p.planName).filter((label) =>
    !own.has(label.toLowerCase())
  );
}

function assertNamesOnlyReportedPlans(
  message: string,
  entitlement: CollectiveEntitlement | undefined,
): void {
  const foreign = entitlement
    ? foreignLabels(entitlement)
    : PLANS.map((p) => p.planName);
  for (const label of foreign) {
    assert(
      !message.toLowerCase().includes(`${label.toLowerCase()} plan`),
      `message names a plan the registry did not report (${label}): ${message}`,
    );
  }
}

Deno.test("evaluatePrivateEntitlement: the verdict follows the reported plan and trial, and names no other plan", () => {
  fc.assert(
    fc.property(reportedArb, (entitlement) => {
      const result = evaluatePrivateEntitlement({
        extensionName: "@acme/tool",
        entitlements: [entitlement],
        serverUrl: SERVER,
      });
      assertEquals(result.name, "private-entitlement");
      assertNamesOnlyReportedPlans(result.message, entitlement);
      assertStringIncludes(result.message, '"@acme"');
      const trialState = entitlement.trial?.state ?? "none";
      if (entitlement.plan !== "free") {
        assertEquals(result.status, "passed");
      } else if (trialState === "active") {
        assertEquals(result.status, "passed");
      } else {
        // An ended trial and no trial alike: no trial starts at publish.
        assertEquals(result.status, "failed");
        assertStringIncludes(
          result.message,
          collectiveBillingUrl(SERVER, "acme"),
        );
      }
      // Dates are the registry's: only the date part of what it sent.
      const endsAt = entitlement.trial?.endsAt;
      if (endsAt && trialState !== "none" && entitlement.plan === "free") {
        assertStringIncludes(result.message, endsAt.slice(0, 10));
      }
    }),
  );
});

Deno.test("evaluatePrivateEntitlement: an absent plan is always undecided, whatever else was sent", () => {
  fc.assert(
    fc.property(
      fc.option(fc.array(reportedArb.map((e) => ({ ...e, slug: "other" }))), {
        nil: undefined,
      }),
      trialArb,
      (others, trial) => {
        const entitlements = others === undefined
          ? undefined
          : [...others, { slug: "acme", trial } as CollectiveEntitlement];
        const result = evaluatePrivateEntitlement({
          extensionName: "@acme/tool",
          entitlements,
          serverUrl: SERVER,
        });
        assertEquals(result.status, "not-run");
        assertEquals(result.cause, "entitlement-undecided");
        assertNamesOnlyReportedPlans(result.message, undefined);
      },
    ),
  );
});

Deno.test("explainPrivatePublishRefusal: starts with the registry's sentence and names only the reported plan", () => {
  fc.assert(
    fc.property(
      fc.option(reportedArb, { nil: undefined }),
      fc.constantFrom(REFUSAL, `${REFUSAL}.`, `${REFUSAL} `),
      (entitlement, serverMessage) => {
        const message = explainPrivatePublishRefusal(serverMessage, {
          extensionName: "@acme/tool",
          entitlement,
          serverUrl: SERVER,
        });
        assert(message.startsWith(`${REFUSAL}.`));
        assertStringIncludes(message, '"@acme"');
        assertNamesOnlyReportedPlans(message, entitlement);
        const pointer = collectiveBillingUrl(SERVER, "acme");
        const freeWithoutAccess = entitlement?.plan === "free" &&
          entitlement.trial?.state !== "active";
        assertEquals(message.includes(pointer), freeWithoutAccess === true);
      },
    ),
  );
});

Deno.test("evaluateVersionExists: a yanked version always fails and never gives the promote command", () => {
  const channelArb = fc.constantFrom("beta", "rc", "stable");
  fc.assert(
    fc.property(
      channelArb,
      channelArb,
      fc.oneof(fc.constant(null), fc.stringMatching(/^[a-z0-9 ]{1,30}$/)),
      (existingChannel, requestedChannel, reason) => {
        const result = evaluateVersionExists({
          extensionName: "@acme/tool",
          version: "2026.10.06.1",
          published: {
            version: "2026.10.06.1",
            channel: existingChannel,
            yank: { reason },
          },
          requestedChannel,
        });
        assertEquals(result.status, "failed");
        assertEquals(result.existingYanked, true);
        assertStringIncludes(result.message, "has been yanked");
        assert(
          !result.message.includes(
            promoteCommand("@acme/tool", "2026.10.06.1", requestedChannel),
          ),
        );
      },
    ),
  );
});
