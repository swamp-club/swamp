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

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createTokenAdmissionChecker } from "../src/serve/token_admission.ts";
import { generateIntegrationCredential } from "../src/domain/access/integration_credential.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { authenticateDelegatedToken } from "../src/serve/delegated_token_auth.ts";
import { DelegationLinkService } from "../src/serve/delegation_link_service.ts";
import { ServeLinkClient } from "../src/serve/serve_link_client.ts";
import {
  CEILING,
  IDENTITY,
  type MockClub,
  START_BODY,
  startAndConsent,
  withRig,
} from "./delegation_link_harness.ts";

await initializeLogging({});

Deno.test("delegation links: start, consent, redeem once, act, refresh, reuse ends the link and swamp-club is told", async () => {
  await withRig(async (rig) => {
    const started = await rig.post("links", START_BODY);
    assertEquals(started.status, 201);
    const pendingId = started.body.pendingId as string;
    const redeemSecret = started.body.redeemSecret as string;
    assert(redeemSecret.startsWith("swdx1."));

    const waiting = await rig.post("redeem", { pendingId, redeemSecret });
    assertEquals(waiting.status, 202);

    await rig.service.tick();
    assertEquals((await rig.store.read(pendingId))?.phase, "awaiting_consent");

    rig.club.status = "approved";
    await rig.pass();
    const consented = await rig.store.read(pendingId);
    assertEquals(consented?.phase, "consented");
    assertEquals(consented?.club.linkId, "link-1");
    assertEquals(consented?.person?.sub, "person-1");

    const redeemed = await rig.post("redeem", { pendingId, redeemSecret });
    assertEquals(redeemed.status, 200, JSON.stringify(redeemed.body));
    const access = redeemed.body.accessToken as string;
    const refresh = redeemed.body.refreshToken as string;
    assert(access.startsWith("swda1.") && refresh.startsWith("swdr1."));

    const again = await rig.post("redeem", { pendingId, redeemSecret });
    assertEquals(again.status, 409);
    assertEquals(again.body.code, "already_redeemed");

    const authed = await authenticateDelegatedToken(access, rig.directory);
    assert(authed.ok);
    assertEquals(authed.principalId, "user:person-1");
    assertEquals(authed.client, "integration:slack-bot");

    const refreshed = await rig.post("refresh", { refreshToken: refresh });
    assertEquals(refreshed.status, 200, JSON.stringify(refreshed.body));
    const newRefresh = refreshed.body.refreshToken as string;
    assert(newRefresh !== refresh);

    const reused = await rig.post("refresh", { refreshToken: refresh });
    assertEquals(reused.status, 401);
    const ended = await rig.store.read(pendingId);
    assertEquals(ended?.phase, "ended");
    assertEquals(ended?.ended?.cause, "refresh_reuse");
    assertEquals(ended?.club.endState, "pending");
    assertEquals(
      (await authenticateDelegatedToken(
        refreshed.body.accessToken as string,
        rig.directory,
      )).ok,
      false,
    );
    assertEquals(
      (await rig.post("refresh", { refreshToken: newRefresh })).status,
      401,
    );

    await rig.service.tick();
    assertEquals(rig.club.ends, ["/link-1/end"]);
    assertEquals((await rig.store.read(pendingId))?.club.endState, "done");
    assert(rig.audit.some((e) => e.action === "refresh_reuse"));
  });
});

Deno.test("delegation links: two redeems at once issue one set of tokens", async () => {
  await withRig(async (rig) => {
    const { pendingId, redeemSecret } = await startAndConsent(rig);
    const results = await Promise.all([
      rig.post("redeem", { pendingId, redeemSecret }),
      rig.post("redeem", { pendingId, redeemSecret }),
      rig.post("redeem", { pendingId, redeemSecret }),
    ]);
    assertEquals(results.filter((r) => r.status === 200).length, 1);
    assertEquals(results.filter((r) => r.status === 409).length, 2);
  });
});

Deno.test("delegation links: racing polls and a lost report acknowledgement record one link", async () => {
  await withRig(async (rig) => {
    const started = await rig.post("links", START_BODY);
    const pendingId = started.body.pendingId as string;
    rig.club.status = "approved";
    rig.club.failNextReportAfterRecording = true;
    const second = new DelegationLinkService({
      store: rig.store,
      directory: rig.directory,
      integrations: {
        standingOf: () => ({ kind: "active", ceiling: CEILING }),
      },
      client: () =>
        new ServeLinkClient({
          baseUrl: rig.club.url,
          clientId: "serve-client",
          clientSecret: "serve-secret",
        }),
      admission: { allowedCollectives: ["skunk-ape"], allowedUsers: [] },
      isLeader: () => true,
    });
    await Promise.all([rig.service.tick(), second.tick()]);
    // the lost ack leaves it reporting; the retry gets the same link back
    for (let i = 0; i < 3; i++) {
      if ((await rig.store.read(pendingId))?.phase === "consented") break;
      await rig.directory.reload();
      await Promise.all([
        new DelegationLinkService({
          store: rig.store,
          directory: rig.directory,
          integrations: {
            standingOf: () => ({ kind: "active", ceiling: CEILING }),
          },
          client: () =>
            new ServeLinkClient({
              baseUrl: rig.club.url,
              clientId: "serve-client",
              clientSecret: "serve-secret",
            }),
          admission: { allowedCollectives: ["skunk-ape"], allowedUsers: [] },
          isLeader: () => true,
        }).tick(),
      ]);
    }
    const record = await rig.store.read(pendingId);
    assertEquals(record?.phase, "consented");
    assertEquals(record?.club.linkId, "link-1");
    assertEquals([...rig.club.recordedLinks], ["link-1"]);
  });
});

Deno.test("delegation links: a person outside the serve's collectives is refused, reported, and never issued tokens", async () => {
  await withRig(async (rig) => {
    rig.club.identity = { ...IDENTITY, collectives: [] };
    const { pendingId, redeemSecret } = await startAndConsent(rig);
    const record = await rig.store.read(pendingId);
    assertEquals(record?.phase, "refused");
    assertEquals(record?.refusal?.reason, "not_admitted");
    assertEquals(record?.tokens, undefined);
    const redeemed = await rig.post("redeem", { pendingId, redeemSecret });
    assertEquals(redeemed.body.status, "refused");
    assertEquals(redeemed.body.accessToken, undefined);
  });
});

Deno.test("delegation links: a changed digest, a denial and an expired consent are refused without tokens", async () => {
  for (
    const setup of [
      (club: MockClub) => {
        club.status = "approved";
        club.digest = "other-digest";
      },
      (club: MockClub) => {
        club.status = "denied";
      },
      (club: MockClub) => {
        club.status = "expired";
      },
    ]
  ) {
    await withRig(async (rig) => {
      const started = await rig.post("links", START_BODY);
      const pendingId = started.body.pendingId as string;
      setup(rig.club);
      await rig.service.tick();
      const record = await rig.store.read(pendingId);
      assertEquals(record?.phase, "refused");
      assertEquals(record?.tokens, undefined);
    });
  }
});

Deno.test("delegation links: each refused start writes nothing", async () => {
  await withRig(async (rig) => {
    const other = await generateIntegrationCredential("slack-bot");
    const cases: [string, unknown, { credential?: string }, number, string][] =
      [
        [
          "links",
          START_BODY,
          { credential: other.credential },
          401,
          "invalid_client",
        ],
        [
          "links",
          {
            ...START_BODY,
            ceiling: {
              version: 1,
              ceiling: [{ actions: ["approve"], resource: "workflow:deploy" }],
            },
          },
          {},
          400,
          "ceiling_too_wide",
        ],
        [
          "links",
          {
            ...START_BODY,
            external: { ...START_BODY.external, platform: "Not Valid!" },
          },
          {},
          400,
          "invalid_request",
        ],
        [
          "links",
          { ...START_BODY, ceiling: { version: 9 } },
          {},
          400,
          "invalid_ceiling",
        ],
      ];
    for (const [route, body, opts, status, code] of cases) {
      const result = await rig.post(route, body, opts);
      assertEquals([result.status, result.body.code], [status, code], code);
    }
    rig.team.capability = { ok: false, instances: ["old-node (host)"] };
    const refused = await rig.post("links", START_BODY);
    assertEquals([refused.status, refused.body.code], [409, "team_not_ready"]);
    assertEquals(rig.directory.all(), []);
  });
});

Deno.test("delegation links: an integration that requires an email match refuses a start without one", async () => {
  await withRig(async (rig) => {
    const { email: _email, ...external } = START_BODY.external;
    const result = await rig.post("links", { ...START_BODY, external });
    assertEquals([result.status, result.body.code], [400, "email_required"]);
    assertEquals(rig.directory.all(), []);
  }, { requireEmailMatch: true });
});

Deno.test("delegation links: tokens are refused for another integration and refresh waits on an older node", async () => {
  await withRig(async (rig) => {
    const { pendingId, redeemSecret } = await startAndConsent(rig);
    const other = await generateIntegrationCredential("other-app");
    const wrongApp = await rig.post("redeem", { pendingId, redeemSecret }, {
      credential: other.credential,
    });
    assertEquals(wrongApp.status, 401);
    const redeemed = await rig.post("redeem", { pendingId, redeemSecret });
    const refresh = redeemed.body.refreshToken as string;
    rig.team.capability = { ok: false, instances: ["old"] };
    const waiting = await rig.post("refresh", { refreshToken: refresh });
    assertEquals([waiting.status, waiting.body.code], [503, "team_not_ready"]);
    rig.team.capability = { ok: true };
    const refreshed = await rig.post("refresh", { refreshToken: refresh });
    assertEquals(refreshed.status, 200);
  });
});

Deno.test("delegation links: a second start for the same person replaces the pending one", async () => {
  await withRig(async (rig) => {
    const first = await rig.post("links", START_BODY);
    const second = await rig.post("links", {
      ...START_BODY,
      external: { ...START_BODY.external, user_id: "u1" },
    });
    assertEquals(second.status, 201);
    assertEquals(
      (await rig.store.read(first.body.pendingId as string))?.phase,
      "refused",
    );
    assertEquals(
      (await rig.store.read(second.body.pendingId as string))?.phase,
      "awaiting_consent",
    );
  });
});

Deno.test("delegation links: a pending link is polled at swamp-club's interval, not on every pass", async () => {
  await withRig(async (rig) => {
    const started = await rig.post("links", START_BODY);
    assertEquals(started.status, 201);
    await rig.service.tick();
    await rig.service.tick();
    await rig.service.tick();
    assertEquals(rig.club.statusPolls, 1);
  });
});

Deno.test("delegation links: a person no longer admitted cannot refresh, and can again once re-admitted", async () => {
  let allowedUsers: string[] = [];
  const admission = createTokenAdmissionChecker({
    lists: () => ({ allowedCollectives: [], allowedUsers }),
    hasStoredLogin: () => Promise.resolve(false),
  });
  await withRig(async (rig) => {
    const { pendingId, redeemSecret } = await startAndConsent(rig);
    const redeemed = await rig.post("redeem", { pendingId, redeemSecret });
    assertEquals(redeemed.status, 200, JSON.stringify(redeemed.body));
    const refresh = redeemed.body.refreshToken as string;

    allowedUsers = ["someone-else"];
    const refused = await rig.post("refresh", { refreshToken: refresh });
    assertEquals(refused.status, 401);
    assertEquals(refused.body.code, "invalid_grant");
    assertStringIncludes(String(refused.body.message), "not_admitted");
    assertEquals((await rig.store.read(pendingId))?.phase, "issued");

    allowedUsers = ["person-1"];
    const refreshed = await rig.post("refresh", { refreshToken: refresh });
    assertEquals(refreshed.status, 200, JSON.stringify(refreshed.body));
  }, { admission });
});
