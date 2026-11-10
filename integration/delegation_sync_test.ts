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
import { assert, assertEquals } from "@std/assert";
import { Ceiling } from "../src/domain/access/ceiling.ts";
import { holdDelegation } from "../src/domain/access/delegation.ts";
import { DelegationDirectory } from "../src/domain/access/delegation_directory.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { authenticateDelegatedToken } from "../src/serve/delegated_token_auth.ts";
import { DelegationSyncService } from "../src/serve/delegation_sync_service.ts";
import { ServeLinkClient } from "../src/serve/serve_link_client.ts";
import {
  CEILING,
  IDENTITY,
  type Rig,
  START_BODY,
  startAndConsent,
  withRig,
} from "./delegation_link_harness.ts";

await initializeLogging({});

const WIDER = Ceiling.parse({
  version: 1,
  ceiling: [{
    actions: ["approve", "read", "run"],
    resource: "workflow:deploy",
  }],
});

const NARROWER = Ceiling.parse({
  version: 1,
  ceiling: [{ actions: ["read"], resource: "workflow:deploy" }],
});

function startBody(userId: string, ceiling: Ceiling = CEILING) {
  return {
    ...START_BODY,
    external: { ...START_BODY.external, user_id: userId },
    ceiling: ceiling.toDocument(),
  };
}

async function link(
  rig: Rig,
  userId: string,
  ceiling: Ceiling = CEILING,
): Promise<{ pendingId: string; redeemSecret: string }> {
  const started = await rig.post("links", startBody(userId, ceiling));
  assertEquals(started.status, 201, JSON.stringify(started.body));
  rig.club.status = "approved";
  await rig.pass();
  return {
    pendingId: started.body.pendingId as string,
    redeemSecret: started.body.redeemSecret as string,
  };
}

async function redeem(
  rig: Rig,
  pending: { pendingId: string; redeemSecret: string },
): Promise<Record<string, unknown>> {
  const redeemed = await rig.post("redeem", pending);
  assertEquals(redeemed.status, 200, JSON.stringify(redeemed.body));
  return redeemed.body;
}

function syncFor(rig: Rig, clock: { now: number }): DelegationSyncService {
  return new DelegationSyncService({
    store: rig.store,
    directory: rig.directory,
    client: () =>
      new ServeLinkClient({
        baseUrl: rig.club.url,
        clientId: "serve-client",
        clientSecret: "serve-secret",
      }),
    isLeader: () => true,
    audit: (event) => rig.audit.push(event),
    now: () => clock.now,
  });
}

async function follower(rig: Rig): Promise<DelegationDirectory> {
  const directory = new DelegationDirectory(
    rig.repo.repoContext.unifiedDataRepo,
  );
  await directory.reload();
  return directory;
}

Deno.test("integration revoke: ends a delegation in every non-final phase, including one awaiting consent", async () => {
  await withRig(async (rig) => {
    const issued = await redeem(rig, await link(rig, "U1"));
    const suspendedLink = await link(rig, "U2");
    await redeem(rig, suspendedLink);
    await rig.store.transition(
      suspendedLink.pendingId,
      (current) =>
        Promise.resolve({
          write: holdDelegation(current!, "person_suspended", Date.now()),
          value: undefined,
        }),
    );
    const consented = await link(rig, "U3");
    rig.club.status = "pending";
    const awaiting = await rig.post("links", startBody("U4"));
    await rig.service.tick();
    const awaitingId = awaiting.body.pendingId as string;
    assertEquals((await rig.store.read(awaitingId))?.phase, "awaiting_consent");
    assertEquals(
      (await rig.store.read(consented.pendingId))?.phase,
      "consented",
    );

    rig.integrationState.revoked = true;
    await rig.pass();

    const ids = [
      issued.delegationId as string,
      suspendedLink.pendingId,
      consented.pendingId,
    ];
    for (const id of ids) {
      const record = await rig.store.read(id);
      assertEquals(record?.phase, "ended", id);
      assertEquals(record?.ended?.cause, "integration_revoked");
    }
    const refused = await rig.store.read(awaitingId);
    assertEquals(refused?.phase, "refused");
    assertEquals(refused?.refusal?.reason, "integration_revoked");
  });
});

Deno.test("relink: the same person's new consent replaces the ceiling, keeps the delegation ID and ends the old link", async () => {
  await withRig(async (rig) => {
    const first = await redeem(rig, await link(rig, "U1"));
    const id = first.delegationId as string;
    const oldRefresh = first.refreshToken as string;
    rig.integrationState.ceiling = WIDER;

    const relink = await link(rig, "U1", WIDER);
    const pending = await rig.store.read(relink.pendingId);
    assertEquals(pending?.phase, "ended");
    assertEquals(pending?.mergedInto, id);
    const folded = await rig.store.read(id);
    assertEquals(folded?.phase, "issued");
    assertEquals(folded?.club.linkId, "link-2");
    assertEquals(folded?.ceiling, WIDER.toDocument());
    assertEquals(rig.directory.supersededBy(id), undefined);
    assert(
      (await authenticateDelegatedToken(
        first.accessToken as string,
        rig.directory,
      )).ok,
    );

    await rig.pass();
    assert(rig.club.ends.includes("/link-1/end"));
    assertEquals(
      (await rig.store.read(id))?.club.retiredLinks?.[0].endState,
      "done",
    );

    const second = await redeem(rig, relink);
    assertEquals(second.delegationId, id);
    assert(
      (await authenticateDelegatedToken(
        second.accessToken as string,
        rig.directory,
      )).ok,
    );
    const stale = await rig.post("refresh", { refreshToken: oldRefresh });
    assertEquals(stale.status, 401);
    assertEquals(stale.body.reason, "mismatch");
    const again = await rig.post("redeem", relink);
    assertEquals(again.status, 409);
    assert(rig.audit.some((e) => e.action === "relinked"));
  });
});

Deno.test("relink: a narrower consent narrows the delegation", async () => {
  await withRig(async (rig) => {
    const first = await redeem(rig, await link(rig, "U1"));
    const id = first.delegationId as string;
    await link(rig, "U1", NARROWER);
    assertEquals((await rig.store.read(id))?.ceiling, NARROWER.toDocument());
  });
});

Deno.test("relink: another person's consent for the same chat identity supersedes instead of folding", async () => {
  await withRig(async (rig) => {
    const first = await redeem(rig, await link(rig, "U1"));
    const id = first.delegationId as string;
    rig.club.identity = { ...IDENTITY, sub: "person-2" };
    const relink = await link(rig, "U1");
    const pending = await rig.store.read(relink.pendingId);
    assertEquals(pending?.phase, "consented");
    assertEquals(pending?.mergedInto, undefined);
    await rig.pass();
    assertEquals((await rig.store.read(id))?.ended?.cause, "superseded");
  });
});

Deno.test("relink: a folded link waits while the delegation is suspended, then redeems once the hold lifts", async () => {
  await withRig(async (rig) => {
    const first = await redeem(rig, await link(rig, "U1"));
    const id = first.delegationId as string;
    await rig.store.transition(id, (current) =>
      Promise.resolve({
        write: holdDelegation(current!, "person_suspended", Date.now()),
        value: undefined,
      }));
    const relink = await link(rig, "U1");
    const held = await rig.post("redeem", relink);
    assertEquals(held.status, 401);
    assertEquals(held.body.reason, "suspended");
    await rig.store.transition(id, (current) =>
      Promise.resolve({
        write: { ...current!, phase: "issued", hold: undefined },
        value: undefined,
      }));
    assertEquals((await redeem(rig, relink)).delegationId, id);
  });
});

Deno.test("sync: a link ended on swamp-club ends on serve and reaches a follower; a replay changes nothing", async () => {
  await withRig(async (rig) => {
    const issued = await redeem(rig, await startAndConsent(rig));
    const id = issued.delegationId as string;
    const clock = { now: Date.now() };
    const sync = syncFor(rig, clock);
    rig.club.people.set("link-1", { state: "active", identity: IDENTITY });
    await sync.tick();
    assertEquals((await rig.store.read(id))?.phase, "issued");

    rig.club.endedFeed.push("link-1");
    rig.club.people.set("link-1", { state: "ended", endedReason: "disowned" });
    clock.now += 30_000;
    await sync.tick();
    assertEquals((await rig.store.read(id))?.ended?.cause, "disowned");
    assert(
      !(await authenticateDelegatedToken(
        issued.accessToken as string,
        rig.directory,
      )).ok,
    );
    const followerDirectory = await follower(rig);
    assertEquals(followerDirectory.standingOf(id).kind, "ended");
    await followerDirectory.dispose();
    assertEquals(rig.club.ends, []);

    const ends = rig.audit.filter((e) => e.action === "ended").length;
    const replay = syncFor(rig, clock);
    clock.now += 30_000;
    await replay.tick();
    assertEquals(rig.audit.filter((e) => e.action === "ended").length, ends);
  });
});

Deno.test("sync: a suspended person is refused on requests and refresh, then works again once lifted", async () => {
  await withRig(async (rig) => {
    const issued = await redeem(rig, await startAndConsent(rig));
    const id = issued.delegationId as string;
    const refresh = issued.refreshToken as string;
    const clock = { now: Date.now() };
    const sync = syncFor(rig, clock);
    rig.club.people.set("link-1", { state: "suspended" });
    await sync.tick();
    const followerDirectory = await follower(rig);
    assertEquals(followerDirectory.standingOf(id).kind, "suspended");
    await followerDirectory.dispose();
    assert(
      !(await authenticateDelegatedToken(
        issued.accessToken as string,
        rig.directory,
      )).ok,
    );
    const refused = await rig.post("refresh", { refreshToken: refresh });
    assertEquals(refused.status, 401);
    assertEquals(refused.body.reason, "suspended");

    rig.club.people.set("link-1", { state: "active", identity: IDENTITY });
    clock.now += 5 * 60_000;
    await sync.tick();
    assertEquals((await rig.store.read(id))?.phase, "issued");
    const refreshed = await rig.post("refresh", { refreshToken: refresh });
    assertEquals(refreshed.status, 200, JSON.stringify(refreshed.body));
  });
});

Deno.test("sync: a refused client refuses every link and ends them after an hour; swamp-club down leaves them working", async () => {
  await withRig(async (rig) => {
    const issued = await redeem(rig, await startAndConsent(rig));
    const id = issued.delegationId as string;
    const clock = { now: Date.now() };
    const sync = syncFor(rig, clock);

    rig.club.down = true;
    await sync.tick();
    assertEquals((await rig.store.read(id))?.phase, "issued");
    const refused = await rig.post("links", startBody("U9"));
    assertEquals(refused.status >= 500, true, JSON.stringify(refused.body));
    rig.club.down = false;

    rig.club.refuseClient = { status: 401, error: "invalid_client" };
    clock.now += 10 * 60_000;
    await sync.tick();
    assertEquals((await rig.store.read(id))?.hold?.causes, [
      "club_client_refused",
    ]);
    const refresh = await rig.post("refresh", {
      refreshToken: issued.refreshToken,
    });
    assertEquals(refresh.body.reason, "links_unavailable");
    assertEquals(
      (await rig.store.readSync())?.clientRefusal?.code,
      "invalid_client",
    );

    clock.now += 61 * 60_000;
    await sync.tick();
    assertEquals(
      (await rig.store.read(id))?.ended?.cause,
      "club_client_refused",
    );
  });
});

Deno.test("relink: a consent for a delegation already superseded starts its own delegation instead of folding into it", async () => {
  await withRig(async (rig) => {
    const first = await redeem(rig, await link(rig, "U1"));
    const id = first.delegationId as string;
    rig.club.identity = { ...IDENTITY, sub: "person-2" };
    await link(rig, "U1");
    assert(rig.directory.supersededBy(id) !== undefined);
    rig.club.identity = IDENTITY;
    const again = await link(rig, "U1");
    const pending = await rig.store.read(again.pendingId);
    assertEquals(pending?.mergedInto, undefined);
    assertEquals(pending?.phase, "consented");
  });
});

Deno.test("relink: a folded link not redeemed within the hour answers ended, and the app's tokens stay as they were", async () => {
  await withRig(async (rig) => {
    const first = await redeem(rig, await link(rig, "U1"));
    const id = first.delegationId as string;
    const relink = await link(rig, "U1");
    rig.serveClock.offsetMs = 2 * 60 * 60_000;
    const late = await rig.post("redeem", relink);
    assertEquals(late.status, 200);
    assertEquals(late.body, { status: "ended", cause: "not_redeemed" });
    assertEquals(
      (await rig.store.read(id))?.tokens?.refreshHash !== undefined,
      true,
    );
    // the link service's clock moves two minutes a pass
    for (let i = 0; i < 32; i++) await rig.pass();
    assertEquals((await rig.store.read(id))?.pendingRedeem, undefined);
  });
});
