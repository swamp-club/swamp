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
import {
  classifyApiCallService,
  collectiveBillingUrl,
  type CollectiveEntitlement,
  collectiveOf,
  evaluateCollectiveMembership,
  evaluatePrivateEntitlement,
  evaluateVersionExists,
  explainPrivatePublishRefusal,
  registryCheckNotRun,
  type RegistryCheckResult,
  registryChecksVerdict,
} from "./extension_publish_checks.ts";

Deno.test("collectiveOf: returns the namespace between @ and /", () => {
  assertEquals(collectiveOf("@acme/tool"), "acme");
  assertEquals(collectiveOf("@swamp/ssh"), "swamp");
});

Deno.test("evaluateCollectiveMembership: member of a plain collective passes both checks", () => {
  const result = evaluateCollectiveMembership({
    extensionName: "@acme/tool",
    collectives: ["acme", "other"],
    username: "someone",
  });
  assertEquals(result.reserved.status, "passed");
  assertEquals(result.reserved.message, 'Collective "@acme" is not reserved.');
  assertEquals(result.membership.status, "passed");
});

Deno.test("evaluateCollectiveMembership: non-member fails with the push's exact message", () => {
  const result = evaluateCollectiveMembership({
    extensionName: "@acme/tool",
    collectives: ["mine", "ours"],
    username: "someone",
  });
  assertEquals(result.membership.status, "failed");
  assertEquals(
    result.membership.message,
    'Extension collective "@acme" is not one of your collectives (@mine, @ours). ' +
      "Use one of: @mine, @ours",
  );
});

Deno.test("evaluateCollectiveMembership: unknown collectives fall back to the username", () => {
  const ok = evaluateCollectiveMembership({
    extensionName: "@seth/tool",
    collectives: undefined,
    username: "seth",
  });
  assertEquals(ok.membership.status, "passed");

  const notOk = evaluateCollectiveMembership({
    extensionName: "@acme/tool",
    collectives: undefined,
    username: "seth",
  });
  assertEquals(notOk.membership.status, "failed");
  assertEquals(
    notOk.membership.message,
    'Extension collective "@acme" is not one of your collectives (@seth). ' +
      "Use one of: @seth",
  );
});

Deno.test("evaluateCollectiveMembership: reserved collective needs the registry's membership list", () => {
  const unverified = evaluateCollectiveMembership({
    extensionName: "@swamp/ssh",
    collectives: undefined,
    username: "swamp",
  });
  assertEquals(unverified.reserved.status, "failed");
  assertEquals(
    unverified.reserved.message,
    'Extension uses reserved collective "@swamp". ' +
      "Could not verify membership — please check your network connection and try again.",
  );
  assertEquals(unverified.membership.status, "not-run");
  assertEquals(unverified.membership.cause, "membership-unverified");

  const verified = evaluateCollectiveMembership({
    extensionName: "@swamp/ssh",
    collectives: ["swamp"],
    username: "seth",
  });
  assertEquals(verified.reserved.status, "passed");
  assertEquals(verified.membership.status, "passed");

  const outsider = evaluateCollectiveMembership({
    extensionName: "@swamp/ssh",
    collectives: ["acme"],
    username: "seth",
  });
  assertEquals(outsider.reserved.status, "passed");
  assertEquals(outsider.membership.status, "failed");
});

Deno.test("evaluateVersionExists: a match on any channel fails with the push's exact message", () => {
  const result = evaluateVersionExists({
    extensionName: "@acme/tool",
    version: "2026.10.06.1",
    published: { version: "2026.10.06.1", channel: "beta" },
  });
  assertEquals(result.status, "failed");
  assertEquals(
    result.message,
    "Version 2026.10.06.1 already exists for @acme/tool.",
  );
});

Deno.test("evaluateVersionExists: no published match passes", () => {
  const result = evaluateVersionExists({
    extensionName: "@acme/tool",
    version: "2026.10.06.1",
    published: null,
  });
  assertEquals(result.status, "passed");
  assertEquals(
    result.message,
    "Version 2026.10.06.1 is not published for @acme/tool.",
  );
});

Deno.test("registryCheckNotRun: carries the cause and the reason", () => {
  assertEquals(
    registryCheckNotRun("version-exists", "no-credentials", "no credentials"),
    {
      name: "version-exists",
      status: "not-run",
      message: "no credentials",
      cause: "no-credentials",
    },
  );
});

Deno.test("registryChecksVerdict: a failed check ends the run with its own message", () => {
  assertEquals(
    registryChecksVerdict([
      { name: "authentication", status: "passed", message: "ok" },
      registryCheckNotRun("version-exists", "registry-unavailable", "down"),
      {
        name: "collective-membership",
        status: "failed",
        message: "not yours",
      },
    ]),
    { ok: false, message: "not yours" },
  );
});

Deno.test("registryChecksVerdict: a check the registry did not answer ends the run; one never asked does not", () => {
  assertEquals(
    registryChecksVerdict([
      registryCheckNotRun(
        "version-exists",
        "registry-unavailable",
        "registry lookup failed: down",
      ),
    ]),
    {
      ok: false,
      message:
        'Registry check "version exists" could not run: registry lookup failed: down',
    },
  );
  assertEquals(
    registryChecksVerdict([
      registryCheckNotRun("authentication", "no-credentials", "no credentials"),
      registryCheckNotRun("version-exists", "no-credentials", "no credentials"),
    ]),
    { ok: true },
  );
  assertEquals(registryChecksVerdict([]), { ok: true });
});

Deno.test("classifyApiCallService: groups by host", () => {
  const registry = "https://swamp-club.com";
  assertEquals(
    classifyApiCallService("https://swamp-club.com/api/whoami", registry),
    "registry",
  );
  assertEquals(
    classifyApiCallService("https://api.osv.dev/v1/query", registry),
    "osv",
  );
  assertEquals(
    classifyApiCallService("https://registry.npmjs.org/zod", registry),
    "npm",
  );
  assertEquals(
    classifyApiCallService(
      "https://api.npmjs.org/downloads/point/last-week/zod",
      registry,
    ),
    "npm",
  );
  assertEquals(
    classifyApiCallService("https://example.com/x", registry),
    "other",
  );
  assertEquals(classifyApiCallService("not a url", registry), "other");
});

// ── Private entitlement ───────────────────────────────────────────────

const SERVER = "https://swamp-club.com";
const REFUSAL =
  "Private publication requires a paid plan or an eligible collective trial";

function acme(
  overrides: Partial<CollectiveEntitlement>,
): CollectiveEntitlement {
  return { slug: "acme", plan: "free", planName: "Free", ...overrides };
}

Deno.test("collectiveBillingUrl: joins the registry origin and the collective's billing path", () => {
  assertEquals(
    collectiveBillingUrl(SERVER, "acme"),
    "https://swamp-club.com/o/acme/billing",
  );
  assertEquals(
    collectiveBillingUrl("https://swamp-club.com/", "acme"),
    "https://swamp-club.com/o/acme/billing",
  );
});

Deno.test("evaluatePrivateEntitlement: a paid plan passes and is named as the registry labels it", () => {
  const result = evaluatePrivateEntitlement({
    extensionName: "@acme/tool",
    entitlements: [acme({ plan: "team", planName: "Team" })],
    serverUrl: SERVER,
  });
  assertEquals(result, {
    name: "private-entitlement",
    status: "passed",
    message:
      'Collective "@acme" is on the Team plan, which allows private extensions.',
  });
});

Deno.test("evaluatePrivateEntitlement: a free plan with an active trial passes and names the trial", () => {
  const result = evaluatePrivateEntitlement({
    extensionName: "@acme/tool",
    entitlements: [acme({
      trial: {
        state: "active",
        endsAt: "2026-08-19T00:00:00.000Z",
        daysRemaining: 13,
      },
    })],
    serverUrl: SERVER,
  });
  assertEquals(result.status, "passed");
  assertEquals(
    result.message,
    'Collective "@acme" is on the Free plan with an active trial (13 days left, ends 2026-08-19), which allows private extensions.',
  );
  const lastDay = evaluatePrivateEntitlement({
    extensionName: "@acme/tool",
    entitlements: [acme({
      trial: { state: "active", endsAt: null, daysRemaining: 1 },
    })],
    serverUrl: SERVER,
  });
  assertEquals(
    lastDay.message,
    'Collective "@acme" is on the Free plan with an active trial (1 day left), which allows private extensions.',
  );
});

Deno.test("evaluatePrivateEntitlement: a free plan whose trial ended fails with the push's exact message", () => {
  const result = evaluatePrivateEntitlement({
    extensionName: "@acme/tool",
    entitlements: [acme({
      trial: {
        state: "expired",
        endsAt: "2026-08-19T00:00:00.000Z",
        daysRemaining: 0,
      },
    })],
    serverUrl: SERVER,
  });
  assertEquals(result, {
    name: "private-entitlement",
    status: "failed",
    message:
      'Collective "@acme" is on the Free plan and its trial ended on 2026-08-19. ' +
      "Private publication requires a paid plan; upgrade at https://swamp-club.com/o/acme/billing.",
  });
});

Deno.test("evaluatePrivateEntitlement: an ended trial without a date is still a failure, with no date invented", () => {
  const result = evaluatePrivateEntitlement({
    extensionName: "@acme/tool",
    entitlements: [acme({
      trial: { state: "expired", endsAt: null, daysRemaining: 0 },
    })],
    serverUrl: SERVER,
  });
  assertEquals(result.status, "failed");
  assertEquals(
    result.message,
    'Collective "@acme" is on the Free plan and its trial has ended. ' +
      "Private publication requires a paid plan; upgrade at https://swamp-club.com/o/acme/billing.",
  );
});

Deno.test("evaluatePrivateEntitlement: a free plan with no trial is undecided, since the registry may start one", () => {
  for (const trial of [undefined, null] as const) {
    const result = evaluatePrivateEntitlement({
      extensionName: "@acme/tool",
      entitlements: [acme({ trial })],
      serverUrl: SERVER,
    });
    assertEquals(result, {
      name: "private-entitlement",
      status: "not-run",
      cause: "entitlement-undecided",
      message:
        'Collective "@acme" is on the Free plan with no trial reported; the registry decides private publication at publish.',
    });
  }
});

Deno.test("evaluatePrivateEntitlement: no entitlement reported is undecided and says so, never naming a plan", () => {
  const expected: RegistryCheckResult = {
    name: "private-entitlement",
    status: "not-run",
    cause: "entitlement-undecided",
    message:
      'the registry did not report entitlement for "@acme"; private publication is decided at publish',
  };
  assertEquals(
    evaluatePrivateEntitlement({
      extensionName: "@acme/tool",
      entitlements: undefined,
      serverUrl: SERVER,
    }),
    expected,
  );
  assertEquals(
    evaluatePrivateEntitlement({
      extensionName: "@acme/tool",
      entitlements: [acme({ slug: "other" })],
      serverUrl: SERVER,
    }),
    expected,
  );
  assertEquals(
    evaluatePrivateEntitlement({
      extensionName: "@acme/tool",
      entitlements: [{ slug: "acme" }],
      serverUrl: SERVER,
    }),
    expected,
  );
});

Deno.test("evaluatePrivateEntitlement: a plan without a label falls back to its id", () => {
  const result = evaluatePrivateEntitlement({
    extensionName: "@acme/tool",
    entitlements: [{ slug: "acme", plan: "business" }],
    serverUrl: SERVER,
  });
  assertEquals(
    result.message,
    'Collective "@acme" is on the business plan, which allows private extensions.',
  );
});

Deno.test("registryChecksVerdict: an undecided entitlement leaves the run green", () => {
  assertEquals(
    registryChecksVerdict([
      registryCheckNotRun(
        "private-entitlement",
        "entitlement-undecided",
        "the registry did not report entitlement",
      ),
    ]),
    { ok: true },
  );
});

Deno.test("explainPrivatePublishRefusal: the registry's sentence comes first, then what it reported at sign-in", () => {
  const free = explainPrivatePublishRefusal(REFUSAL, {
    extensionName: "@acme/tool",
    entitlement: acme({
      trial: {
        state: "expired",
        endsAt: "2026-08-19T00:00:00.000Z",
        daysRemaining: 0,
      },
    }),
    serverUrl: SERVER,
  });
  assertEquals(
    free,
    `${REFUSAL}. At sign-in the registry reported "@acme" on the Free plan; its trial ended on 2026-08-19. ` +
      "Private publication requires a paid plan; upgrade at https://swamp-club.com/o/acme/billing.",
  );
  const noTrial = explainPrivatePublishRefusal(`${REFUSAL}.`, {
    extensionName: "@acme/tool",
    entitlement: acme({}),
    serverUrl: SERVER,
  });
  assertEquals(
    noTrial,
    `${REFUSAL}. At sign-in the registry reported "@acme" on the Free plan with no trial reported. ` +
      "Private publication requires a paid plan; upgrade at https://swamp-club.com/o/acme/billing.",
  );
});

Deno.test("explainPrivatePublishRefusal: a paid plan or an active trial is reported without an upgrade pointer", () => {
  const paid = explainPrivatePublishRefusal(REFUSAL, {
    extensionName: "@acme/tool",
    entitlement: acme({ plan: "team", planName: "Team" }),
    serverUrl: SERVER,
  });
  assertEquals(
    paid,
    `${REFUSAL}. At sign-in the registry reported "@acme" on the Team plan.`,
  );
  const trial = explainPrivatePublishRefusal(REFUSAL, {
    extensionName: "@acme/tool",
    entitlement: acme({
      trial: { state: "active", endsAt: null, daysRemaining: 3 },
    }),
    serverUrl: SERVER,
  });
  assertEquals(
    trial,
    `${REFUSAL}. At sign-in the registry reported "@acme" on the Free plan with an active trial (3 days left).`,
  );
});

Deno.test("explainPrivatePublishRefusal: no entitlement reported adds the note and nothing about a plan", () => {
  for (const entitlement of [undefined, { slug: "acme" }]) {
    assertEquals(
      explainPrivatePublishRefusal(REFUSAL, {
        extensionName: "@acme/tool",
        entitlement,
        serverUrl: SERVER,
      }),
      `${REFUSAL}. At sign-in the registry did not report entitlement for "@acme".`,
    );
  }
});
