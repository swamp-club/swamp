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
  type CollectiveTrial,
  evaluateCollectiveMembership,
  evaluatePrivateEntitlement,
  evaluateVersionExists,
  explainPrivatePublishRefusal,
  placeExistingVersion,
  registryCheckNotRun,
  type RegistryCheckResult,
  registryChecksVerdict,
  signedInCheck,
  yankedVersionPromoteRefusal,
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

Deno.test("evaluateCollectiveMembership: no collectives and no username leaves membership unchecked", () => {
  const result = evaluateCollectiveMembership({
    extensionName: "@acme/tool",
    collectives: undefined,
    username: "",
  });
  assertEquals(result.reserved.status, "passed");
  assertEquals(result.membership, {
    name: "collective-membership",
    status: "not-run",
    message:
      "Could not check that @acme is one of your collectives: the registry " +
      "did not report your collectives, and this credential has no username " +
      "to check against.",
    cause: "registry-unavailable",
  });
  // A dry run stays red: the push would refuse.
  assertEquals(registryChecksVerdict([result.membership]).ok, false);
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

Deno.test("evaluateVersionExists: a duplicate on the requested channel keeps the push's exact message", () => {
  const result = evaluateVersionExists({
    extensionName: "@acme/tool",
    version: "2026.10.06.1",
    published: { version: "2026.10.06.1", channel: "beta" },
    requestedChannel: "beta",
  });
  assertEquals(result.status, "failed");
  assertEquals(
    result.message,
    "Version 2026.10.06.1 already exists for @acme/tool.",
  );
  assertEquals(result.existingChannel, "beta");
  assertEquals(result.requestedChannel, "beta");
});

Deno.test("evaluateVersionExists: an omitted channel is stable", () => {
  const result = evaluateVersionExists({
    extensionName: "@acme/tool",
    version: "2026.10.06.1",
    published: { version: "2026.10.06.1", channel: "stable" },
  });
  assertEquals(
    result.message,
    "Version 2026.10.06.1 already exists for @acme/tool.",
  );
  assertEquals(result.requestedChannel, "stable");
});

Deno.test("evaluateVersionExists: a lower channel names it and gives the promote command", () => {
  const result = evaluateVersionExists({
    extensionName: "@acme/tool",
    version: "2026.10.06.1",
    published: { version: "2026.10.06.1", channel: "beta" },
    requestedChannel: "stable",
  });
  assertEquals(result.status, "failed");
  assertEquals(
    result.message,
    "Version 2026.10.06.1 already exists for @acme/tool on channel 'beta'. " +
      "To move it to 'stable' without re-publishing, run: " +
      "swamp extension promote @acme/tool 2026.10.06.1 --channel stable",
  );
  assertEquals(result.existingChannel, "beta");
  assertEquals(result.requestedChannel, "stable");
});

Deno.test("evaluateVersionExists: a higher channel says a version cannot move down", () => {
  const result = evaluateVersionExists({
    extensionName: "@acme/tool",
    version: "2026.10.06.1",
    published: { version: "2026.10.06.1", channel: "stable" },
    requestedChannel: "rc",
  });
  assertEquals(result.status, "failed");
  assertEquals(
    result.message,
    "Version 2026.10.06.1 already exists for @acme/tool on channel 'stable', " +
      "above 'rc'. A version cannot move down a channel; publish a new version instead.",
  );
});

Deno.test("placeExistingVersion: orders beta below rc below stable", () => {
  assertEquals(placeExistingVersion("beta", "rc"), "lower-channel");
  assertEquals(placeExistingVersion("beta", "stable"), "lower-channel");
  assertEquals(placeExistingVersion("rc", "stable"), "lower-channel");
  assertEquals(placeExistingVersion("rc", "rc"), "same-channel");
  assertEquals(placeExistingVersion("stable", "beta"), "higher-channel");
  assertEquals(placeExistingVersion("rc", "beta"), "higher-channel");
});

Deno.test("placeExistingVersion: an unknown channel never offers a promotion", () => {
  assertEquals(placeExistingVersion("nightly", "stable"), "same-channel");
  assertEquals(placeExistingVersion("beta", "nightly"), "same-channel");
});

Deno.test("evaluateVersionExists: no published match passes", () => {
  const result = evaluateVersionExists({
    extensionName: "@acme/tool",
    version: "2026.10.06.1",
    published: null,
    requestedChannel: "stable",
  });
  assertEquals(result.status, "passed");
  assertEquals(result.existingChannel, undefined);
  assertEquals(result.requestedChannel, undefined);
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
const BILLING = "https://swamp-club.com/o/acme/billing";
const REFUSAL =
  "Private publication requires a paid plan or an eligible collective trial";

function acme(
  overrides: Partial<CollectiveEntitlement>,
): CollectiveEntitlement {
  return { slug: "acme", plan: "free", planName: "Free", ...overrides };
}

function check(entitlement: CollectiveEntitlement): RegistryCheckResult {
  return evaluatePrivateEntitlement({
    extensionName: `@${entitlement.slug}/tool`,
    entitlements: [entitlement],
    serverUrl: SERVER,
  });
}

const EXPIRED: CollectiveTrial = {
  state: "expired",
  endsAt: "2026-08-19T00:00:00.000Z",
  daysRemaining: 0,
  totalDays: 30,
};

Deno.test("collectiveBillingUrl: joins the registry origin and the collective's billing path", () => {
  assertEquals(collectiveBillingUrl(SERVER, "acme"), BILLING);
  assertEquals(
    collectiveBillingUrl("https://swamp-club.com/", "acme"),
    BILLING,
  );
});

Deno.test("evaluatePrivateEntitlement: allowed on a paid plan passes and names the plan as the registry labels it", () => {
  assertEquals(
    check(
      acme({ plan: "team", planName: "Team", privateExtensions: "allowed" }),
    ),
    {
      name: "private-entitlement",
      status: "passed",
      message:
        'Collective "@acme" is on the Team plan, which allows private extensions.',
    },
  );
});

Deno.test("evaluatePrivateEntitlement: allowed in a free trial passes and names the trial", () => {
  const result = check(acme({
    trial: {
      state: "active",
      endsAt: "2026-08-19T00:00:00.000Z",
      daysRemaining: 13,
    },
    privateExtensions: "allowed",
  }));
  assertEquals(result.status, "passed");
  assertEquals(
    result.message,
    'Collective "@acme" is in its free trial (13 days left, ends 2026-08-19), which allows private extensions.',
  );
  const lastDay = check(acme({
    trial: { state: "active", endsAt: null, daysRemaining: 1 },
    privateExtensions: "allowed",
  }));
  assertEquals(
    lastDay.message,
    'Collective "@acme" is in its free trial (1 day left), which allows private extensions.',
  );
});

Deno.test("evaluatePrivateEntitlement: a personal namespace the registry allows through another collective passes (swamp-club#3311)", () => {
  // The issue's repro: the owner's personal trial expired (or a team's plan
  // superseded it), but a paid collective the owner belongs to covers the
  // personal namespace, so the registry allows it.
  for (const trial of [EXPIRED, null]) {
    const result = check({
      slug: "alice",
      plan: "free",
      planName: "Free",
      trial,
      privateExtensions: "allowed",
    });
    assertEquals(result, {
      name: "private-entitlement",
      status: "passed",
      message:
        'Collective "@alice" is covered by a paid plan or active trial on another collective you belong to, which allows private extensions.',
    });
  }
});

Deno.test("evaluatePrivateEntitlement: allowed with admin standing says so, never calling it a plan", () => {
  assertEquals(
    check(
      acme({ plan: "admin", planName: "Admin", privateExtensions: "allowed" }),
    )
      .message,
    'Collective "@acme" has admin standing, which allows private extensions.',
  );
});

Deno.test("evaluatePrivateEntitlement: trial-ended fails with the trial's length and the upgrade page", () => {
  assertEquals(
    check(acme({ trial: EXPIRED, privateExtensions: "trial-ended" })),
    {
      name: "private-entitlement",
      status: "failed",
      message: `Collective "@acme"'s 30-day free trial has ended. ` +
        `Private extensions need a paid plan; upgrade at ${BILLING}.`,
    },
  );
  // No length reported, or no trial at all: no length invented.
  for (
    const trial of [
      { ...EXPIRED, totalDays: undefined },
      { ...EXPIRED, totalDays: "30" as unknown as number },
      { ...EXPIRED, totalDays: 0 },
      null,
    ]
  ) {
    assertEquals(
      check(acme({ trial, privateExtensions: "trial-ended" })).message,
      `Collective "@acme"'s free trial has ended. ` +
        `Private extensions need a paid plan; upgrade at ${BILLING}.`,
    );
  }
});

Deno.test("evaluatePrivateEntitlement: paywalled fails with the paid-plan wording and claims nothing about a trial", () => {
  // A former customer, a superseded trial and no trial at all read the same.
  for (const trial of [EXPIRED, null, undefined]) {
    assertEquals(check(acme({ trial, privateExtensions: "paywalled" })), {
      name: "private-entitlement",
      status: "failed",
      message:
        `Private extensions in "@acme" need a paid plan; upgrade at ${BILLING}.`,
    });
  }
});

Deno.test("evaluatePrivateEntitlement: paywalled with a Personal License names the license", () => {
  assertEquals(
    check(acme({
      plan: "personal",
      planName: "Personal License",
      trial: null,
      privateExtensions: "paywalled",
    })).message,
    'Collective "@acme" has a Personal License, which does not include private extensions. ' +
      `Private extensions need a paid plan; upgrade at ${BILLING}.`,
  );
});

Deno.test("evaluatePrivateEntitlement: the verdict decides over the plan and trial", () => {
  assertEquals(
    check(
      acme({ plan: "team", planName: "Team", privateExtensions: "paywalled" }),
    )
      .status,
    "failed",
  );
  assertEquals(
    check(acme({
      trial: { state: "active", endsAt: null, daysRemaining: 3 },
      privateExtensions: "trial-ended",
    })).status,
    "failed",
  );
  assertEquals(
    check(acme({ trial: EXPIRED, privateExtensions: "allowed" })).status,
    "passed",
  );
});

Deno.test("evaluatePrivateEntitlement: a verdict this client does not know is undecided, never refused", () => {
  assertEquals(
    check(acme({ trial: EXPIRED, privateExtensions: "waitlisted" })),
    {
      name: "private-entitlement",
      status: "not-run",
      cause: "entitlement-undecided",
      message:
        'the registry reported a private-extensions verdict for "@acme" that this client does not know; private publication is decided at publish',
    },
  );
});

Deno.test("evaluatePrivateEntitlement: without a verdict, a paid plan or an active trial passes", () => {
  assertEquals(
    check(acme({ plan: "team", planName: "Team" })).message,
    'Collective "@acme" is on the Team plan, which allows private extensions.',
  );
  assertEquals(
    check(acme({ trial: { state: "active", endsAt: null, daysRemaining: 3 } }))
      .message,
    'Collective "@acme" is in its free trial (3 days left), which allows private extensions.',
  );
  assertEquals(
    check(acme({ plan: "admin", planName: "Admin" })).status,
    "passed",
  );
});

Deno.test("evaluatePrivateEntitlement: without a verdict, an ended trial or none fails, since no trial starts at publish", () => {
  assertEquals(check(acme({ trial: EXPIRED })), {
    name: "private-entitlement",
    status: "failed",
    message: `Collective "@acme"'s 30-day free trial has ended. ` +
      `Private extensions need a paid plan; upgrade at ${BILLING}.`,
  });
  for (
    const trial of [
      undefined,
      null,
      { state: "none", endsAt: null, daysRemaining: 0 },
    ] as const
  ) {
    assertEquals(check(acme({ trial })), {
      name: "private-entitlement",
      status: "failed",
      message:
        `Private extensions in "@acme" need a paid plan; upgrade at ${BILLING}.`,
    });
  }
});

Deno.test("evaluatePrivateEntitlement: without a verdict, a Personal License is left to the registry", () => {
  assertEquals(
    check(acme({ plan: "personal", planName: "Personal License" })),
    {
      name: "private-entitlement",
      status: "not-run",
      cause: "entitlement-undecided",
      message:
        'the registry did not say whether the Personal License on "@acme" includes private extensions; private publication is decided at publish',
    },
  );
});

Deno.test("evaluatePrivateEntitlement: without a verdict, a trial state this client does not know is undecided", () => {
  assertEquals(
    check(acme({
      trial: {
        state: "returned",
        endsAt: null,
        daysRemaining: 0,
      } as unknown as CollectiveTrial,
    })),
    {
      name: "private-entitlement",
      status: "not-run",
      cause: "entitlement-undecided",
      message:
        'the registry reported a trial state for "@acme" that this client does not know; private publication is decided at publish',
    },
  );
});

Deno.test("evaluatePrivateEntitlement: no entitlement reported is undecided and says so, never naming a plan", () => {
  const expected: RegistryCheckResult = {
    name: "private-entitlement",
    status: "not-run",
    cause: "entitlement-undecided",
    message:
      'the registry did not report entitlement for "@acme"; private publication is decided at publish',
  };
  for (
    const entitlements of [undefined, [acme({ slug: "other" })], [{
      slug: "acme",
    }]]
  ) {
    assertEquals(
      evaluatePrivateEntitlement({
        extensionName: "@acme/tool",
        entitlements,
        serverUrl: SERVER,
      }),
      expected,
    );
  }
});

Deno.test("evaluatePrivateEntitlement: reads the entry for the extension's own collective only", () => {
  // A paid team the caller belongs to does not entitle a different, free
  // collective: only a personal namespace is covered, and the registry says
  // so on that namespace's own entry.
  const result = evaluatePrivateEntitlement({
    extensionName: "@acme/tool",
    entitlements: [
      {
        slug: "team",
        plan: "team",
        planName: "Team",
        privateExtensions: "allowed",
      },
      acme({ trial: EXPIRED, privateExtensions: "trial-ended" }),
    ],
    serverUrl: SERVER,
  });
  assertEquals(result.status, "failed");
});

Deno.test("evaluatePrivateEntitlement: a plan without a label falls back to its id", () => {
  assertEquals(
    check({ slug: "acme", plan: "business" }).message,
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

function explain(
  entitlement: CollectiveEntitlement | undefined,
  serverMessage = REFUSAL,
): string {
  return explainPrivatePublishRefusal(serverMessage, {
    extensionName: "@acme/tool",
    entitlement,
    serverUrl: SERVER,
  });
}

Deno.test("explainPrivatePublishRefusal: the registry's sentence comes first, then what it reported at sign-in", () => {
  assertEquals(
    explain(acme({ trial: EXPIRED, privateExtensions: "trial-ended" })),
    `${REFUSAL}. At sign-in the registry reported that collective "@acme"'s 30-day free trial has ended. ` +
      `Private extensions need a paid plan; upgrade at ${BILLING}.`,
  );
  assertEquals(
    explain(acme({ privateExtensions: "paywalled" }), `${REFUSAL}.`),
    `${REFUSAL}. At sign-in the registry reported that private extensions in "@acme" need a paid plan; upgrade at ${BILLING}.`,
  );
  assertEquals(
    explain(acme({ plan: "personal", privateExtensions: "paywalled" })),
    `${REFUSAL}. At sign-in the registry reported that collective "@acme" has a Personal License, which does not include private extensions. ` +
      `Private extensions need a paid plan; upgrade at ${BILLING}.`,
  );
});

Deno.test("explainPrivatePublishRefusal: what was allowed at sign-in is reported without an upgrade pointer", () => {
  assertEquals(
    explain(
      acme({ plan: "team", planName: "Team", privateExtensions: "allowed" }),
    ),
    `${REFUSAL}. At sign-in the registry reported that collective "@acme" is on the Team plan, which allows private extensions.`,
  );
  assertEquals(
    explain(acme({
      trial: { state: "active", endsAt: null, daysRemaining: 3 },
    })),
    `${REFUSAL}. At sign-in the registry reported that collective "@acme" is in its free trial (3 days left), which allows private extensions.`,
  );
  assertEquals(
    explain({
      slug: "acme",
      plan: "free",
      trial: EXPIRED,
      privateExtensions: "allowed",
    }),
    `${REFUSAL}. At sign-in the registry reported that collective "@acme" is covered by a paid plan or active trial on another collective you belong to, which allows private extensions.`,
  );
});

Deno.test("explainPrivatePublishRefusal: an undecided report says what the registry left open, and nothing about a plan", () => {
  for (const entitlement of [undefined, { slug: "acme" }]) {
    assertEquals(
      explain(entitlement),
      `${REFUSAL}. At sign-in the registry did not report entitlement for "@acme".`,
    );
  }
  assertEquals(
    explain(acme({ privateExtensions: "waitlisted" })),
    `${REFUSAL}. At sign-in the registry reported a private-extensions verdict for "@acme" that this client does not know.`,
  );
});

Deno.test("signedInCheck: a personal key names the username", () => {
  assertEquals(
    signedInCheck({ username: "seth", fingerprint: "9c1e4b7a2f60d835" }),
    {
      name: "authentication",
      status: "passed",
      message: "Signed in as seth.",
      credential: { username: "seth", fingerprint: "9c1e4b7a2f60d835" },
    },
  );
});

Deno.test("signedInCheck: an API token names its collective and fingerprint", () => {
  assertEquals(
    signedInCheck({
      username: "",
      collectiveToken: true,
      collectiveSlug: "swamp-uat",
      fingerprint: "9c1e4b7a2f60d835",
    }),
    {
      name: "authentication",
      status: "passed",
      message:
        "Signed in with an API token for @swamp-uat (fingerprint 9c1e4b7a2f60d835).",
      credential: {
        collectiveToken: true,
        collectiveSlug: "swamp-uat",
        fingerprint: "9c1e4b7a2f60d835",
      },
    },
  );
});

Deno.test("signedInCheck: an API token is named as one even with a cached username", () => {
  const check = signedInCheck({
    username: "seth",
    collectiveToken: true,
    collectiveSlug: "acme",
    fingerprint: "9c1e4b7a2f60d835",
  });
  assertEquals(
    check.message,
    "Signed in with an API token for @acme (fingerprint 9c1e4b7a2f60d835).",
  );
});

Deno.test("signedInCheck: without a username or collective, the fingerprint alone names the key", () => {
  for (
    const identity of [
      { username: "", collectiveToken: true, fingerprint: "9c1e4b7a2f60d835" },
      { username: "", fingerprint: "9c1e4b7a2f60d835" },
    ]
  ) {
    const check = signedInCheck(identity);
    assertEquals(
      check.message,
      "Signed in with an API token (fingerprint 9c1e4b7a2f60d835).",
    );
    assertEquals(check.credential?.fingerprint, "9c1e4b7a2f60d835");
    assertEquals(check.credential?.username, undefined);
  }
});

Deno.test("evaluateVersionExists: a yanked version on a lower channel names the yank and not the promote command", () => {
  const result = evaluateVersionExists({
    extensionName: "@acme/tool",
    version: "2026.10.06.1",
    published: {
      version: "2026.10.06.1",
      channel: "beta",
      yank: { reason: "broken build" },
    },
    requestedChannel: "rc",
  });
  assertEquals(result, {
    name: "version-exists",
    status: "failed",
    message:
      "Version 2026.10.06.1 already exists for @acme/tool on channel 'beta' " +
      "and has been yanked (broken build). " +
      "A yanked version stays taken and cannot be promoted; publish a new version instead.",
    existingChannel: "beta",
    requestedChannel: "rc",
    existingYanked: true,
    existingYankReason: "broken build",
  });
});

Deno.test("evaluateVersionExists: a yanked version fails on the same and on a higher channel too", () => {
  for (
    const [channel, requestedChannel] of [["rc", "rc"], ["stable", "beta"]]
  ) {
    const result = evaluateVersionExists({
      extensionName: "@acme/tool",
      version: "2026.10.06.1",
      published: {
        version: "2026.10.06.1",
        channel,
        yank: { reason: "broken build" },
      },
      requestedChannel,
    });
    assertEquals(result.status, "failed");
    assertEquals(result.existingYanked, true);
    assertEquals(
      result.message,
      `Version 2026.10.06.1 already exists for @acme/tool on channel '${channel}' ` +
        "and has been yanked (broken build). " +
        "A yanked version stays taken and cannot be promoted; publish a new version instead.",
    );
  }
});

Deno.test("evaluateVersionExists: a yank without a reason leaves the reason out", () => {
  const result = evaluateVersionExists({
    extensionName: "@acme/tool",
    version: "2026.10.06.1",
    published: {
      version: "2026.10.06.1",
      channel: "beta",
      yank: { reason: null },
    },
    requestedChannel: "rc",
  });
  assertEquals(
    result.message,
    "Version 2026.10.06.1 already exists for @acme/tool on channel 'beta' " +
      "and has been yanked. " +
      "A yanked version stays taken and cannot be promoted; publish a new version instead.",
  );
  assertEquals(result.existingYanked, true);
  assertEquals("existingYankReason" in result, false);
});

Deno.test("yankedVersionPromoteRefusal: matches the registry's wording, with and without a reason", () => {
  assertEquals(
    yankedVersionPromoteRefusal("@acme/tool", "2026.10.06.1", "broken build"),
    "Version 2026.10.06.1 of @acme/tool has been yanked (broken build) and cannot be promoted",
  );
  assertEquals(
    yankedVersionPromoteRefusal("@acme/tool", "2026.10.06.1", null),
    "Version 2026.10.06.1 of @acme/tool has been yanked and cannot be promoted",
  );
});
