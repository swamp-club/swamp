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

import { assert, assertEquals } from "@std/assert";
import {
  foldConsent,
  holdDelegation,
  issueDelegationTokens,
  recordApproval,
  recordReported,
} from "../domain/access/delegation.ts";
import {
  PERSON,
  startedRecord,
  T0,
} from "../domain/access/delegation_test_helpers.ts";
import type {
  DelegationRecord,
  DelegationSyncRecord,
} from "../domain/models/access/delegation_model.ts";
import type { DelegationAuditEvent } from "./delegation_link_service.ts";
import type { TransitionResult } from "./delegation_store.ts";
import {
  CLIENT_REFUSAL_END_MS,
  DelegationSyncService,
  FEED_INTERVAL_MS,
  PEOPLE_INTERVAL_MS,
} from "./delegation_sync_service.ts";
import {
  type LinkChanges,
  type LinkPersonView,
  type ServeLinkClient,
  ServeLinkError,
} from "./serve_link_client.ts";

class MemoryStore {
  records = new Map<string, DelegationRecord>();
  sync: DelegationSyncRecord | null = null;
  writes = 0;

  all(): DelegationRecord[] {
    return [...this.records.values()];
  }

  async transition<T>(
    id: string,
    change: (current: DelegationRecord | null) => Promise<TransitionResult<T>>,
  ): Promise<T> {
    const result = await change(this.records.get(id) ?? null);
    if (result.write !== null) {
      this.writes++;
      this.records.set(id, result.write);
    }
    return result.value;
  }

  readSync(): Promise<DelegationSyncRecord | null> {
    return Promise.resolve(this.sync);
  }

  syncTransition<T>(
    change: (
      current: DelegationSyncRecord | null,
    ) => { write: DelegationSyncRecord | null; value: T },
  ): Promise<T> {
    const result = change(this.sync);
    if (result.write !== null) this.sync = result.write;
    return Promise.resolve(result.value);
  }
}

type Answer<T> = T | ServeLinkError;

class FakeClub {
  pages = new Map<string, Answer<LinkChanges | "invalid_cursor">>();
  people = new Map<string, LinkPersonView>();
  peopleError: ServeLinkError | undefined;
  feedError: ServeLinkError | undefined;
  feedCalls: (string | undefined)[] = [];
  peopleCalls: string[][] = [];

  client(): ServeLinkClient {
    return {
      changes: (since: string | undefined) => {
        this.feedCalls.push(since);
        if (this.feedError) return Promise.reject(this.feedError);
        const page = this.pages.get(since ?? "") ??
          { ended: [], cursor: since ?? "c0", more: false };
        return page instanceof ServeLinkError
          ? Promise.reject(page)
          : Promise.resolve(page);
      },
      people: (ids: readonly string[]) => {
        this.peopleCalls.push([...ids]);
        if (this.peopleError) return Promise.reject(this.peopleError);
        return Promise.resolve(
          ids.flatMap((id) => {
            const view = this.people.get(id);
            return view ? [view] : [];
          }),
        );
      },
    } as unknown as ServeLinkClient;
  }
}

async function linked(linkId: string, userId = linkId): Promise<
  DelegationRecord
> {
  const record = recordReported(
    recordApproval(startedRecord({ userId }), PERSON, T0),
    linkId,
    T0,
  );
  return (await issueDelegationTokens(record, T0)).record;
}

function active(linkId: string, collectives = ["skunk-ape"]): LinkPersonView {
  return {
    linkId,
    state: "active",
    identity: {
      sub: PERSON.sub,
      email: PERSON.email,
      username: PERSON.username,
      collectives,
      groups: [],
    },
  };
}

function rig(options: { leader?: () => boolean } = {}) {
  const store = new MemoryStore();
  const club = new FakeClub();
  const audit: DelegationAuditEvent[] = [];
  const clock = { now: T0 + 1000 };
  const service = new DelegationSyncService({
    store,
    directory: store,
    client: () => club.client(),
    isLeader: options.leader ?? (() => true),
    audit: (event) => audit.push(event),
    now: () => clock.now,
  });
  const add = (record: DelegationRecord) =>
    store.records.set(record.id, record);
  const advance = async (ms: number) => {
    clock.now += ms;
    await service.tick();
  };
  return { store, club, audit, clock, service, add, advance };
}

Deno.test("DelegationSyncService: a feed end ends the delegation with swamp-club's cause, once", async () => {
  const { store, club, audit, service, add } = rig();
  const disowned = await linked("l1");
  const other = await linked("l2");
  add(disowned);
  add(other);
  club.pages.set("", {
    ended: ["l1", "l2", "unknown"],
    cursor: "c1",
    more: false,
  });
  club.people.set("l1", {
    linkId: "l1",
    state: "ended",
    endedReason: "disowned",
  });
  club.people.set("l2", { linkId: "l2", state: "ended", endedReason: "other" });
  await service.tick();
  assertEquals(store.records.get(disowned.id)?.ended?.cause, "disowned");
  assertEquals(store.records.get(other.id)?.ended?.cause, "club_ended");
  assertEquals(store.records.get(disowned.id)?.club.endState, "none");
  assertEquals(store.sync?.cursor, "c1");
  assertEquals(club.peopleCalls[0], ["l1", "l2"]);
  assertEquals(
    audit.filter((e) => e.action === "ended").map((e) => e.outcome).sort(),
    ["club_ended", "disowned"],
  );
});

Deno.test("DelegationSyncService: a cause it can't read still ends the link, as club_ended", async () => {
  const { store, club, service, add } = rig();
  const record = await linked("l1");
  add(record);
  club.pages.set("", { ended: ["l1"], cursor: "c1", more: false });
  club.peopleError = new ServeLinkError("unavailable", "down");
  await service.tick();
  assertEquals(store.records.get(record.id)?.ended?.cause, "club_ended");
});

Deno.test("DelegationSyncService: a repeated end writes and audits nothing", async () => {
  const { store, club, audit, service, add, advance } = rig();
  const record = await linked("l1");
  add(record);
  club.pages.set("", { ended: ["l1"], cursor: "c1", more: false });
  club.pages.set("c1", { ended: ["l1"], cursor: "c1", more: false });
  await service.tick();
  const writes = store.writes;
  await advance(FEED_INTERVAL_MS);
  assertEquals(club.feedCalls, [undefined, "c1"]);
  assertEquals(store.writes, writes);
  assertEquals(audit.filter((e) => e.action === "ended").length, 1);
});

Deno.test("DelegationSyncService: reads pages until more is false, storing the cursor after each page's ends", async () => {
  const { store, club, service, add } = rig();
  const first = await linked("l1");
  const second = await linked("l2");
  add(first);
  add(second);
  club.pages.set("", { ended: ["l1"], cursor: "c1", more: true });
  club.pages.set("c1", { ended: ["l2"], cursor: "c2", more: false });
  await service.tick();
  assertEquals(club.feedCalls, [undefined, "c1"]);
  assertEquals(store.sync?.cursor, "c2");
  assertEquals(store.records.get(second.id)?.phase, "ended");
});

Deno.test("DelegationSyncService: a new leader carries on from the stored cursor, and a page whose cursor wasn't stored is applied once", async () => {
  const store = new MemoryStore();
  const club = new FakeClub();
  const audit: DelegationAuditEvent[] = [];
  const a = await linked("l1");
  const b = await linked("l2");
  store.records.set(a.id, a);
  store.records.set(b.id, b);
  club.pages.set("", { ended: ["l1"], cursor: "c1", more: true });
  club.pages.set("c1", { ended: ["l2"], cursor: "c2", more: false });
  let leader = "first";
  const make = (name: string) =>
    new DelegationSyncService({
      store,
      directory: store,
      client: () => club.client(),
      isLeader: () => leader === name,
      audit: (event) => audit.push(event),
      now: () => T0 + 1000,
    });
  const first = make("first");
  const second = make("second");
  const realSync = store.syncTransition.bind(store);
  store.syncTransition = (change) => {
    if (change(store.sync).write?.cursor === "c2") {
      return Promise.reject(new Error("lead lost"));
    }
    return realSync(change);
  };
  await first.tick();
  assertEquals(store.sync?.cursor, "c1");
  assertEquals(store.records.get(b.id)?.phase, "ended");
  store.syncTransition = realSync;
  leader = "second";
  await first.tick();
  await second.tick();
  assertEquals(club.feedCalls, [undefined, "c1", "c1"]);
  assertEquals(store.sync?.cursor, "c2");
  assertEquals(audit.filter((e) => e.action === "ended").length, 2);
});

Deno.test("DelegationSyncService: a cursor another leader moved is never moved back", async () => {
  const { store, club, service, add } = rig();
  add(await linked("l1"));
  store.sync = { cursor: "c1", updatedAt: new Date(T0).toISOString() };
  club.pages.set("c1", { ended: ["elsewhere"], cursor: "c2", more: true });
  const realSync = store.syncTransition.bind(store);
  let first = true;
  store.syncTransition = (change) => {
    if (first) {
      first = false;
      store.sync = { cursor: "c9", updatedAt: new Date(T0).toISOString() };
    }
    return realSync(change);
  };
  await service.tick();
  assertEquals(store.sync?.cursor, "c9");
  assertEquals(club.feedCalls, ["c1"]);
});

Deno.test("DelegationSyncService: an unreadable cursor reads the feed from its start", async () => {
  const { store, club, service, add } = rig();
  const record = await linked("l1");
  add(record);
  store.sync = { cursor: "stale", updatedAt: new Date(T0).toISOString() };
  club.pages.set("stale", "invalid_cursor");
  club.pages.set("", { ended: ["l1"], cursor: "c1", more: false });
  await service.tick();
  assertEquals(club.feedCalls, ["stale", undefined]);
  assertEquals(store.sync?.cursor, "c1");
  assertEquals(store.records.get(record.id)?.phase, "ended");
});

Deno.test("DelegationSyncService: makes no swamp-club call without linked delegations, or on a follower", async () => {
  const empty = rig();
  await empty.service.tick();
  assertEquals(empty.club.feedCalls, []);
  assertEquals(empty.club.peopleCalls, []);
  const follower = rig({ leader: () => false });
  follower.add(await linked("l1"));
  await follower.service.tick();
  assertEquals(follower.club.feedCalls, []);
  assertEquals(follower.club.peopleCalls, []);
});

Deno.test("DelegationSyncService: people suspends, lifts, updates the snapshot, and ends", async () => {
  const { store, club, audit, service, add, advance } = rig();
  const record = await linked("l1");
  const ended = await linked("l2");
  add(record);
  add(ended);
  club.people.set("l1", { linkId: "l1", state: "suspended" });
  club.people.set("l2", { linkId: "l2", state: "ended", endedReason: "other" });
  await service.tick();
  assertEquals(store.records.get(record.id)?.phase, "suspended");
  assertEquals(store.records.get(record.id)?.hold?.causes, [
    "person_suspended",
  ]);
  assertEquals(store.records.get(ended.id)?.ended?.cause, "club_ended");
  club.people.set("l1", active("l1", []));
  await advance(PEOPLE_INTERVAL_MS);
  assertEquals(store.records.get(record.id)?.phase, "issued");
  assertEquals(store.records.get(record.id)?.person?.collectives, []);
  assertEquals(
    audit.map((e) => `${e.action}:${e.outcome}`).filter((a) =>
      !a.startsWith("ended")
    ),
    [
      "suspended:person_suspended",
      "suspension_lifted:person_suspended",
      "identity_updated:outside_collective",
    ],
  );
});

Deno.test("DelegationSyncService: a link swamp-club leaves out is held until it is known again", async () => {
  const { store, club, service, add, advance } = rig();
  const record = await linked("l1");
  add(record);
  await service.tick();
  assertEquals(store.records.get(record.id)?.hold?.causes, ["club_unknown"]);
  club.people.set("l1", active("l1"));
  await advance(PEOPLE_INTERVAL_MS);
  assertEquals(store.records.get(record.id)?.phase, "issued");
});

Deno.test("DelegationSyncService: people reads at most 200 links a call", async () => {
  const { club, service, add } = rig();
  for (let i = 0; i < 450; i++) {
    const record = await linked(`l${i}`);
    add(record);
    club.people.set(`l${i}`, active(`l${i}`));
  }
  await service.tick();
  // the feed's empty page needs no people read
  assertEquals(club.peopleCalls.map((c) => c.length), [200, 200, 50]);
});

Deno.test("DelegationSyncService: a refused client holds every link, stays refused through a rate limit, and ends them after the deadline", async () => {
  const { store, club, audit, service, add, advance } = rig();
  const record = await linked("l1");
  add(record);
  club.feedError = new ServeLinkError(
    "unauthorized",
    "refused",
    "invalid_client",
  );
  club.peopleError = club.feedError;
  await service.tick();
  assertEquals(store.records.get(record.id)?.hold?.causes, [
    "club_client_refused",
  ]);
  assertEquals(store.sync?.clientRefusal?.code, "invalid_client");
  club.feedError = new ServeLinkError("rate_limited", "slow down");
  club.peopleError = club.feedError;
  await advance(FEED_INTERVAL_MS);
  assertEquals(store.records.get(record.id)?.phase, "suspended");
  assert(store.sync?.clientRefusal !== undefined);
  await advance(CLIENT_REFUSAL_END_MS);
  assertEquals(
    store.records.get(record.id)?.ended?.cause,
    "club_client_refused",
  );
  assertEquals(store.records.get(record.id)?.club.endState, "none");
  assert(
    audit.some((e) =>
      e.action === "suspended" && e.outcome === "club_client_refused"
    ),
  );
});

Deno.test("DelegationSyncService: an accepted client lifts the hold before the deadline", async () => {
  const { store, club, service, add, advance } = rig();
  const record = await linked("l1");
  add(record);
  club.people.set("l1", active("l1"));
  club.feedError = new ServeLinkError(
    "unauthorized",
    "refused",
    "client_not_collective",
  );
  club.peopleError = club.feedError;
  await service.tick();
  assertEquals(store.records.get(record.id)?.phase, "suspended");
  club.feedError = undefined;
  club.peopleError = undefined;
  await advance(PEOPLE_INTERVAL_MS);
  assertEquals(store.records.get(record.id)?.phase, "issued");
  assertEquals(store.sync?.clientRefusal, undefined);
  await advance(CLIENT_REFUSAL_END_MS);
  assertEquals(store.records.get(record.id)?.phase, "issued");
});

Deno.test("DelegationSyncService: swamp-club down changes nothing and backs off", async () => {
  const { store, club, service, add, advance } = rig();
  const record = await linked("l1");
  add(record);
  club.feedError = new ServeLinkError("unavailable", "down");
  club.peopleError = club.feedError;
  await service.tick();
  assertEquals(store.records.get(record.id), record);
  assertEquals(club.feedCalls.length, 1);
  await advance(FEED_INTERVAL_MS);
  assertEquals(club.feedCalls.length, 1);
  await advance(FEED_INTERVAL_MS);
  assertEquals(club.feedCalls.length, 2);
  assertEquals(store.records.get(record.id), record);
});

Deno.test("DelegationSyncService: a disowned retired link ends the delegation, any other end of one is ignored", async () => {
  const { store, club, service, add, advance } = rig();
  const target = await linked("l1");
  const pending = recordApproval(
    startedRecord({ id: crypto.randomUUID(), userId: "l1" }),
    PERSON,
    T0,
  );
  const folded = foldConsent(target, pending, "l2", PERSON, T0);
  add(folded);
  club.people.set("l2", active("l2"));
  club.pages.set("", { ended: ["l1"], cursor: "c1", more: false });
  club.people.set("l1", { linkId: "l1", state: "ended", endedReason: "other" });
  await service.tick();
  assertEquals(store.records.get(folded.id)?.phase, "issued");
  club.pages.set("c1", { ended: ["l1"], cursor: "c2", more: false });
  club.people.set("l1", {
    linkId: "l1",
    state: "ended",
    endedReason: "disowned",
  });
  await advance(FEED_INTERVAL_MS);
  assertEquals(store.records.get(folded.id)?.ended?.cause, "disowned");
});

Deno.test("DelegationSyncService: an empty page leaves the stored cursor alone, so the feed never drifts back or writes on every poll", async () => {
  const { store, club, service, add, advance } = rig();
  add(await linked("l1"));
  store.sync = { cursor: "c1", updatedAt: new Date(T0).toISOString() };
  club.pages.set("c1", { ended: [], cursor: "c0-overlap", more: false });
  await service.tick();
  await advance(FEED_INTERVAL_MS);
  assertEquals(store.sync?.cursor, "c1");
  assertEquals(club.feedCalls, ["c1", "c1"]);
});

Deno.test("DelegationSyncService: a 401 or 403 without swamp-club's refusal code is an outage, not a refused client", async () => {
  for (const code of [undefined, "forbidden", "unauthorized"]) {
    const { store, club, service, add } = rig();
    const record = await linked("l1");
    add(record);
    club.feedError = new ServeLinkError("unauthorized", "edge said no", code);
    club.peopleError = club.feedError;
    await service.tick();
    assertEquals(store.records.get(record.id), record);
    assertEquals(store.sync, null);
  }
});

Deno.test("DelegationSyncService: a refused client also holds an already suspended delegation, so the deadline ends it", async () => {
  const { store, club, service, add, advance } = rig();
  const record = holdDelegation(await linked("l1"), "person_suspended", T0);
  add(record);
  club.feedError = new ServeLinkError(
    "unauthorized",
    "refused",
    "invalid_client",
  );
  club.peopleError = club.feedError;
  await service.tick();
  assertEquals(store.records.get(record.id)?.hold?.causes, [
    "person_suspended",
    "club_client_refused",
  ]);
  await advance(CLIENT_REFUSAL_END_MS);
  assertEquals(
    store.records.get(record.id)?.ended?.cause,
    "club_client_refused",
  );
});

Deno.test("DelegationSyncService: a failed read of the stored cursor backs off instead of reading the feed from its start", async () => {
  const { store, club, service, add } = rig();
  add(await linked("l1"));
  store.sync = { cursor: "c5", updatedAt: new Date(T0).toISOString() };
  store.readSync = () => Promise.reject(new Error("datastore unreachable"));
  await service.tick();
  assertEquals(club.feedCalls, []);
  assertEquals(store.sync?.cursor, "c5");
});

Deno.test("DelegationSyncService: an ended answer for a link a relink already replaced leaves the delegation alone unless it was disowned", async () => {
  const store = new MemoryStore();
  const club = new FakeClub();
  const target = await linked("l1");
  const pending = recordApproval(
    startedRecord({ id: crypto.randomUUID(), userId: "l1" }),
    PERSON,
    T0,
  );
  store.records.set(target.id, target);
  // the people read was sent for l1; the fold lands before swamp-club answers
  club.people.set("l1", { linkId: "l1", state: "ended", endedReason: "other" });
  const realPeople = club.client().people;
  const client = club.client();
  (client as { people: unknown }).people = async (ids: readonly string[]) => {
    const views = await realPeople(ids);
    store.records.set(
      target.id,
      foldConsent(target, pending, "l2", PERSON, T0),
    );
    return views;
  };
  const swapped = new DelegationSyncService({
    store,
    directory: store,
    client: () => client,
    isLeader: () => true,
    now: () => T0 + 1000,
  });
  await swapped.tick();
  assertEquals(store.records.get(target.id)?.phase, "issued");
  assertEquals(store.records.get(target.id)?.club.linkId, "l2");
});
