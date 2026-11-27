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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { sampleFingerprint } from "../../domain/serve/federation_test_helpers.ts";
import { InstanceId } from "../../domain/serve/instance_id.ts";
import { JoinToken } from "../../domain/serve/join_token.ts";
import { MemberCredential } from "../../domain/serve/member_credential.ts";
import { MemberName } from "../../domain/serve/member_name.ts";
import { MAX_INSTANCES } from "../../domain/serve/serve_member.ts";
import {
  federationHubEnabled,
  FederationHubError,
  federationMemberEnabled,
} from "./federation_hub.ts";
import { createTestHub, type TestHub } from "./federation_hub_test_helpers.ts";

const HOUR = 60 * 60 * 1000;

async function joined(t: TestHub, name = "edge-1") {
  const { plaintext } = await t.hub.createToken(name);
  const outcome = await t.hub.join(
    plaintext,
    crypto.randomUUID(),
    sampleFingerprint(),
  );
  if (outcome.kind !== "joined") throw new Error(outcome.kind);
  return { ...outcome, plaintext };
}

function storedText(t: TestHub): string {
  return [...t.store.entries.values()]
    .map((bytes) => new TextDecoder().decode(bytes))
    .join("\n");
}

Deno.test("federationHubEnabled: only with the gate on and role hub", () => {
  const on = (name: string) =>
    name === "SWAMP_EXPERIMENTAL_FEDERATION" ? "1" : undefined;
  const off = () => undefined;
  assertEquals(federationHubEnabled(on, { role: "hub" }), true);
  assertEquals(federationHubEnabled(off, { role: "hub" }), false);
  assertEquals(federationHubEnabled(on, undefined), false);
  assertEquals(
    federationHubEnabled(on, { hub: "https://hub.example" }),
    false,
  );
});

Deno.test("federationMemberEnabled: only with the gate on and a hub URL", () => {
  const on = (name: string) =>
    name === "SWAMP_EXPERIMENTAL_FEDERATION" ? "1" : undefined;
  const off = () => undefined;
  const member = { hub: "https://hub.example" };
  assertEquals(federationMemberEnabled(on, member), true);
  assertEquals(federationMemberEnabled(off, member), false);
  assertEquals(federationMemberEnabled(on, undefined), false);
  assertEquals(federationMemberEnabled(on, { role: "hub" }), false);
});

Deno.test("FederationHub.createToken: stores the hash only, under the member's name", async () => {
  const t = createTestHub();
  const { plaintext, token } = await t.hub.createToken("edge-1");
  assert(plaintext.startsWith("edge-1."));
  assertEquals(token.state, "unused");
  assertEquals("secretHash" in token, false);
  const stored = t.store.json("federation/tokens/edge-1") as Record<
    string,
    unknown
  >;
  assertEquals(stored.state, "unused");
  assertEquals(typeof stored.secretHash, "string");
  assert(!storedText(t).includes(plaintext.split(".")[1]));
});

Deno.test("FederationHub.createToken: refuses the hub's name, an invalid name and too long a duration", async () => {
  const t = createTestHub({ hubName: "central" });
  const hubName = await assertRejects(
    () => t.hub.createToken("central"),
    FederationHubError,
  );
  assertEquals(hubName.code, "hub_name");
  const bad = await assertRejects(
    () => t.hub.createToken("../etc"),
    FederationHubError,
  );
  assertEquals(bad.code, "invalid_name");
  const long = await assertRejects(
    () => t.hub.createToken("edge-1", 31 * 24 * HOUR),
    FederationHubError,
  );
  assertEquals(long.code, "invalid_duration");
  assertEquals(t.store.entries.size, 0);
});

Deno.test("FederationHub.join: spends the token, then writes the credential hash, then the record", async () => {
  const t = createTestHub();
  const { plaintext } = await t.hub.createToken("edge-1");
  t.store.puts.length = 0;
  const outcome = await t.hub.join(
    plaintext,
    crypto.randomUUID(),
    sampleFingerprint(),
  );
  assertEquals(outcome.kind, "joined");
  if (outcome.kind !== "joined") return;
  assertEquals(t.store.puts, [
    "federation/tokens/edge-1",
    `federation/credentials/${outcome.memberId}`,
  ]);
  assertEquals(t.members.calls.map((c) => c.call.method), ["join"]);
  const token = t.store.json("federation/tokens/edge-1") as Record<
    string,
    unknown
  >;
  assertEquals(token.state, "used");
  assertEquals(token.memberId, outcome.memberId);
  const credential = MemberCredential.parse(outcome.credential);
  assertEquals(credential.memberId, outcome.memberId);
  const stored = t.store.json(
    `federation/credentials/${outcome.memberId}`,
  ) as Record<string, unknown>;
  assertEquals(stored, { hash: credential.hash(), memberName: "edge-1" });
  assert(!storedText(t).includes(outcome.credential));
  const record = t.members.raw("edge-1")!;
  assertEquals(record.memberId, outcome.memberId);
  assertEquals(record.role, "member");
  assertEquals("credentialHash" in record, false);
  assert(!JSON.stringify(record).includes(credential.hash()));
});

Deno.test("FederationHub.join: a used, wrong, expired, revoked, missing or malformed token is one refusal", async () => {
  const t = createTestHub();
  const used = await joined(t, "used");
  const { plaintext: wrong } = await t.hub.createToken("wrong");
  const { plaintext: expired } = await t.hub.createToken("expired", 1000);
  const { plaintext: revoked } = await t.hub.createToken("revoked");
  await t.hub.revokeToken("revoked");
  t.clock.now += 2000;
  const presented = [
    used.plaintext,
    `wrong.${"A".repeat(43)}`,
    expired,
    revoked,
    `missing.${wrong.split(".")[1]}`,
    "not-a-token",
    42,
  ];
  for (const token of presented) {
    assertEquals(
      await t.hub.join(token, crypto.randomUUID(), sampleFingerprint()),
      { kind: "invalid-token" },
      String(token),
    );
  }
  assertEquals(
    t.members.calls.filter((c) => c.call.method === "join").length,
    1,
  );
});

Deno.test("FederationHub.join: a live member's name is taken and the token stays unused", async () => {
  const t = createTestHub();
  await joined(t, "edge-1");
  const { plaintext } = await t.hub.createToken("edge-1");
  assertEquals(
    await t.hub.join(plaintext, crypto.randomUUID(), sampleFingerprint()),
    {
      kind: "name-taken",
      memberName: "edge-1",
    },
  );
  const token = t.store.json("federation/tokens/edge-1") as Record<
    string,
    unknown
  >;
  assertEquals(token.state, "unused");
});

Deno.test("FederationHub.join: the hub's own name is refused even with a token for it", async () => {
  const t = createTestHub({ hubName: "central" });
  const minted = JoinToken.mint(
    MemberName.create("central"),
    HOUR,
    t.clock.now,
  );
  await t.store.put(
    "federation/tokens/central",
    new TextEncoder().encode(JSON.stringify(minted.token.toJSON())),
  );
  assertEquals(
    await t.hub.join(
      minted.plaintext,
      crypto.randomUUID(),
      sampleFingerprint(),
    ),
    {
      kind: "name-taken",
      memberName: "central",
    },
  );
});

Deno.test("FederationHub.join: a replay with the same joinId re-credentials the same member", async () => {
  const t = createTestHub();
  const { plaintext } = await t.hub.createToken("edge-1");
  const joinId = crypto.randomUUID();
  const first = await t.hub.join(plaintext, joinId, sampleFingerprint());
  if (first.kind !== "joined") throw new Error(first.kind);
  assertEquals(first.replayed, false);
  t.store.puts.length = 0;
  const replay = await t.hub.join(plaintext, joinId, sampleFingerprint());
  if (replay.kind !== "joined") throw new Error(replay.kind);
  assertEquals(replay.replayed, true);
  assertEquals(replay.memberId, first.memberId);
  assertEquals(replay.memberName, "edge-1");
  assert(replay.credential !== first.credential);
  assertEquals(t.store.puts, [`federation/credentials/${first.memberId}`]);
  assertEquals(
    t.members.calls.filter((c) => c.call.method === "join").length,
    1,
  );
  const instance = InstanceId.create(crypto.randomUUID());
  assertEquals(
    await t.hub.checkIn(
      MemberCredential.parse(first.credential),
      instance,
      sampleFingerprint(),
    ),
    { kind: "unauthorized" },
  );
  assertEquals(
    (await t.hub.checkIn(
      MemberCredential.parse(replay.credential),
      instance,
      sampleFingerprint(),
    )).kind,
    "checked-in",
  );
  assert(!storedText(t).includes(joinId));
});

Deno.test("FederationHub.join: a replay with another joinId, after expiry or after removal is refused", async () => {
  const t = createTestHub();
  const { plaintext } = await t.hub.createToken("edge-1", 1000);
  const joinId = crypto.randomUUID();
  const first = await t.hub.join(plaintext, joinId, sampleFingerprint());
  assertEquals(first.kind, "joined");
  assertEquals(
    await t.hub.join(plaintext, crypto.randomUUID(), sampleFingerprint()),
    { kind: "invalid-token" },
  );
  await t.hub.removeMember("edge-1");
  assertEquals(
    await t.hub.join(plaintext, joinId, sampleFingerprint()),
    { kind: "invalid-token" },
  );

  const later = createTestHub();
  const minted = await later.hub.createToken("edge-2", 1000);
  await later.hub.join(minted.plaintext, joinId, sampleFingerprint());
  later.clock.now += 1000;
  assertEquals(
    await later.hub.join(minted.plaintext, joinId, sampleFingerprint()),
    { kind: "invalid-token" },
  );
});

Deno.test("FederationHub.join: a replay never re-credentials a member that joined under another id", async () => {
  const t = createTestHub();
  const { plaintext } = await t.hub.createToken("edge-1");
  const joinId = crypto.randomUUID();
  const first = await t.hub.join(plaintext, joinId, sampleFingerprint());
  if (first.kind !== "joined") throw new Error(first.kind);
  const token = t.store.json("federation/tokens/edge-1") as Record<
    string,
    unknown
  >;
  await t.store.put(
    "federation/tokens/edge-1",
    new TextEncoder().encode(
      JSON.stringify({ ...token, memberId: crypto.randomUUID() }),
    ),
  );
  assertEquals(
    await t.hub.join(plaintext, joinId, sampleFingerprint()),
    { kind: "invalid-token" },
  );
});

Deno.test("FederationHub.join: a replay finishes a join the hub stopped before recording", async () => {
  const t = createTestHub();
  const { plaintext } = await t.hub.createToken("edge-1");
  const joinId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const stored = JoinToken.fromJSON(t.store.json("federation/tokens/edge-1"));
  const spent = JoinToken.use(stored, plaintext, joinId, memberId, t.clock.now);
  if (spent.kind !== "first-use") throw new Error(spent.kind);
  await t.store.put(
    "federation/tokens/edge-1",
    new TextEncoder().encode(JSON.stringify(spent.token.toJSON())),
  );
  const replay = await t.hub.join(plaintext, joinId, sampleFingerprint());
  if (replay.kind !== "joined") throw new Error(replay.kind);
  assertEquals(replay.memberId, memberId);
  assertEquals(replay.replayed, true);
  assertEquals(t.members.raw("edge-1")?.memberId, memberId);
});

Deno.test("FederationHub.listTokens: never shows a hash", async () => {
  const t = createTestHub();
  const { plaintext } = await t.hub.createToken("edge-1");
  await t.hub.join(plaintext, crypto.randomUUID(), sampleFingerprint());
  const [view] = await t.hub.listTokens();
  assertEquals(view.state, "used");
  assertEquals("secretHash" in view, false);
  assertEquals("joinIdHash" in view, false);
});

Deno.test("FederationHub.checkIn: records the instance once, then writes only the seen time", async () => {
  const t = createTestHub();
  const { credential } = await joined(t);
  const parsed = MemberCredential.parse(credential);
  const instance = InstanceId.create(crypto.randomUUID());
  assertEquals(
    await t.hub.checkIn(parsed, instance, sampleFingerprint()),
    { kind: "checked-in", changed: true },
  );
  assertEquals(t.members.version("edge-1"), 2);
  t.clock.now += 30_000;
  assertEquals(
    await t.hub.checkIn(parsed, instance, sampleFingerprint()),
    { kind: "checked-in", changed: false },
  );
  assertEquals(t.members.version("edge-1"), 2);
  assertEquals(
    t.store.json(`federation/seen/${parsed.memberId}/${instance.value}`),
    { at: t.clock.now, runtime: { team: null, startedAt: null, ready: null } },
  );
});

const RUNNING = {
  team: { role: "leader" as const, nodes: 2 },
  startedAt: "2026-11-26T11:00:00.000Z",
  ready: true,
};

Deno.test("FederationHub.checkIn: runtime facts go to the seen record and never make a data version", async () => {
  const t = createTestHub();
  const { credential } = await joined(t);
  const parsed = MemberCredential.parse(credential);
  const instance = InstanceId.create(crypto.randomUUID());
  await t.hub.checkIn(parsed, instance, sampleFingerprint());
  const version = t.members.version("edge-1");
  for (let i = 0; i < 4; i++) {
    t.clock.now += 30_000;
    const outcome = await t.hub.checkIn(
      parsed,
      instance,
      sampleFingerprint({
        ...RUNNING,
        team: { role: "leader", nodes: i + 1 },
        ready: i % 2 === 0,
      }),
    );
    assertEquals(outcome, { kind: "checked-in", changed: false });
  }
  assertEquals(t.members.version("edge-1"), version);
  assertEquals(
    t.store.json(`federation/seen/${parsed.memberId}/${instance.value}`),
    {
      at: t.clock.now,
      runtime: { ...RUNNING, team: { role: "leader", nodes: 4 }, ready: false },
    },
  );
});

Deno.test("FederationHub.sightings: reads both seen shapes and a newer hub's, grouped by member, skipping one with no time", async () => {
  const t = createTestHub();
  const { credential, memberId } = await joined(t);
  const parsed = MemberCredential.parse(credential);
  const fresh = InstanceId.create(crypto.randomUUID());
  await t.hub.checkIn(parsed, fresh, sampleFingerprint(RUNNING));
  const old = InstanceId.create(crypto.randomUUID());
  await t.store.put(
    `federation/seen/${memberId}/${old.value}`,
    new TextEncoder().encode(JSON.stringify({ at: t.clock.now - 1000 })),
  );
  await t.store.put(
    `federation/seen/${memberId}/${crypto.randomUUID()}`,
    new TextEncoder().encode(JSON.stringify({ extra: true })),
  );
  const newer = InstanceId.create(crypto.randomUUID());
  await t.store.put(
    `federation/seen/${memberId}/${newer.value}`,
    new TextEncoder().encode(
      JSON.stringify({ at: 1, runtime: { ...RUNNING, later: 1 }, extra: true }),
    ),
  );
  const all = await t.hub.sightings();
  const sorted = [...all.get(memberId)!].sort((a, b) => b.at - a.at);
  assertEquals(sorted, [
    { instanceId: fresh.value, at: t.clock.now, runtime: RUNNING },
    { instanceId: old.value, at: t.clock.now - 1000, runtime: null },
    { instanceId: newer.value, at: 1, runtime: RUNNING },
  ]);
  assertEquals([...(await t.hub.sightings(memberId)).keys()], [memberId]);
  assertEquals(
    (await t.hub.sightings(crypto.randomUUID())).size,
    0,
  );
});

Deno.test("FederationHub.recordSelfSeen: writes nothing before the hub's record exists, then its own seen record", async () => {
  const t = createTestHub();
  const instance = InstanceId.create(crypto.randomUUID());
  assertEquals(await t.hub.recordSelfSeen(instance, RUNNING), false);
  assertEquals(await t.store.list("federation/seen/"), []);
  await t.hub.upsertSelf(sampleFingerprint({ federationRole: "hub" }));
  assertEquals(await t.hub.recordSelfSeen(instance, RUNNING), true);
  const hubId = t.members.raw("hub")!.memberId;
  assertEquals(
    t.store.json(`federation/seen/${hubId}/${instance.value}`),
    { at: t.clock.now, runtime: RUNNING },
  );
  assertEquals(t.members.version("hub"), 1);
});

Deno.test("FederationHub.sweep: keeps the hub's own seen record until the TTL, and leaves the hub's status alone", async () => {
  const t = createTestHub();
  await t.hub.upsertSelf(sampleFingerprint({ federationRole: "hub" }));
  const instance = InstanceId.create(crypto.randomUUID());
  await t.hub.recordSelfSeen(instance, RUNNING);
  const hubId = t.members.raw("hub")!.memberId;
  const key = `federation/seen/${hubId}/${instance.value}`;
  t.clock.now += 20 * 60 * 1000;
  assertEquals(await t.hub.sweep(), { membersWritten: 0, seenKeysDeleted: 0 });
  assert(t.store.entries.has(key));
  assertEquals(t.members.raw("hub")!.status, "online");
  t.clock.now += 24 * HOUR;
  assertEquals(await t.hub.sweep(), { membersWritten: 0, seenKeysDeleted: 1 });
  assertEquals(t.store.entries.has(key), false);
});

Deno.test("FederationHub.checkIn: a wrong secret, an orphan credential and a removed member are unauthorized", async () => {
  const t = createTestHub();
  const { credential, memberId } = await joined(t);
  const instance = InstanceId.create(crypto.randomUUID());
  const forged = MemberCredential.issue(memberId);
  assertEquals(
    await t.hub.checkIn(forged, instance, sampleFingerprint()),
    { kind: "unauthorized" },
  );
  const stranger = MemberCredential.issue(crypto.randomUUID());
  await t.store.put(
    `federation/credentials/${stranger.memberId}`,
    new TextEncoder().encode(
      JSON.stringify({ hash: stranger.hash(), memberName: "ghost" }),
    ),
  );
  assertEquals(
    await t.hub.checkIn(stranger, instance, sampleFingerprint()),
    { kind: "unauthorized" },
  );
  await t.hub.removeMember("edge-1");
  assertEquals(
    t.store.entries.has(`federation/credentials/${memberId}`),
    false,
  );
  assertEquals(
    await t.hub.checkIn(
      MemberCredential.parse(credential),
      instance,
      sampleFingerprint(),
    ),
    { kind: "unauthorized" },
  );
});

Deno.test("FederationHub.checkIn: a new instance past the limit is refused and writes no seen key", async () => {
  const t = createTestHub();
  const { credential, memberId } = await joined(t);
  const parsed = MemberCredential.parse(credential);
  for (let i = 0; i < MAX_INSTANCES; i++) {
    const outcome = await t.hub.checkIn(
      parsed,
      InstanceId.create(crypto.randomUUID()),
      sampleFingerprint(),
    );
    assertEquals(outcome.kind, "checked-in");
  }
  const extra = InstanceId.create(crypto.randomUUID());
  assertEquals(
    await t.hub.checkIn(parsed, extra, sampleFingerprint()),
    { kind: "instance-limit" },
  );
  assertEquals(
    t.store.entries.has(`federation/seen/${memberId}/${extra.value}`),
    false,
  );
});

Deno.test("FederationHub.removeMember: marks the member removed and refuses an unknown name or the hub", async () => {
  const t = createTestHub();
  await joined(t);
  await t.hub.upsertSelf(sampleFingerprint({ federationRole: "hub" }));
  const member = await t.hub.removeMember("edge-1");
  assertEquals(member.status, "removed");
  assertEquals(t.members.raw("edge-1")!.status, "removed");
  for (const name of ["nobody", "hub"]) {
    const error = await assertRejects(
      () => t.hub.removeMember(name),
      FederationHubError,
    );
    assertEquals(error.code, "not_found");
  }
});

Deno.test("FederationHub.revokeToken and listTokens: only an unused token is revoked; no hash is listed", async () => {
  const t = createTestHub();
  await t.hub.createToken("a");
  await t.hub.createToken("b", 1000);
  await joined(t, "c");
  assertEquals((await t.hub.revokeToken("a")).state, "revoked");
  const used = await assertRejects(
    () => t.hub.revokeToken("c"),
    FederationHubError,
  );
  assertEquals(used.code, "token_not_unused");
  const missing = await assertRejects(
    () => t.hub.revokeToken("zzz"),
    FederationHubError,
  );
  assertEquals(missing.code, "not_found");
  t.clock.now += 2000;
  const listed = await t.hub.listTokens();
  assertEquals(
    listed.map((token) => [token.memberName, token.state]),
    [["a", "revoked"], ["b", "expired"], ["c", "used"]],
  );
  for (const token of listed) assertEquals("secretHash" in token, false);
});

Deno.test("FederationHub.upsertSelf: writes the hub record once, and again only on configuration drift", async () => {
  const t = createTestHub();
  const fingerprint = sampleFingerprint({ federationRole: "hub" });
  assertEquals(await t.hub.upsertSelf(fingerprint), { changed: true });
  assertEquals(t.members.raw("hub")!.role, "hub");
  assertEquals(await t.hub.upsertSelf(fingerprint), { changed: false });
  assertEquals(
    await t.hub.upsertSelf(
      sampleFingerprint({ federationRole: "hub", startedAt: "later" }),
    ),
    { changed: false },
  );
  assertEquals(t.members.version("hub"), 1);
  assertEquals(
    await t.hub.upsertSelf(
      sampleFingerprint({
        federationRole: "hub",
        settingsHash: "1".repeat(64),
      }),
    ),
    { changed: true },
  );
  assertEquals(t.members.version("hub"), 2);
  assertEquals((await t.hub.listMembers()).map((m) => m.name), ["hub"]);
});

Deno.test("FederationHub: a newer hub's credential, token and seen records keep working, and the sweep deletes none of them", async () => {
  const t = createTestHub();
  const { credential, memberId } = await joined(t);
  const encode = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value));
  const decode = (key: string) =>
    JSON.parse(new TextDecoder().decode(t.store.entries.get(key)!));
  const credentialKey = `federation/credentials/${memberId}`;
  await t.store.put(
    credentialKey,
    encode({ ...decode(credentialKey), later: 1 }),
  );
  const instance = InstanceId.create(crypto.randomUUID());
  const checkedIn = await t.hub.checkIn(
    MemberCredential.parse(credential),
    instance,
    sampleFingerprint(),
  );
  assertEquals(checkedIn.kind, "checked-in");
  const seenKey = `federation/seen/${memberId}/${instance.value}`;
  await t.store.put(seenKey, encode({ ...decode(seenKey), later: 1 }));
  const report = await t.hub.sweep();
  assertEquals(report.seenKeysDeleted, 0);
  assertEquals(decode(seenKey).later, 1);

  await t.hub.createToken("edge-2");
  const tokenKey = "federation/tokens/edge-2";
  await t.store.put(tokenKey, encode({ ...decode(tokenKey), later: "x" }));
  await t.hub.revokeToken("edge-2");
  assertEquals(decode(tokenKey).later, "x");
  assertEquals(decode(tokenKey).state, "revoked");
  const [listed] = (await t.hub.listTokens()).filter((v) =>
    v.memberName === "edge-2"
  );
  assertEquals("later" in listed, false);
});

Deno.test("FederationHub.sweep: rewriting a newer hub's member record keeps its fields", async () => {
  const t = createTestHub();
  const { credential } = await joined(t);
  const instance = InstanceId.create(crypto.randomUUID());
  await t.hub.checkIn(
    MemberCredential.parse(credential),
    instance,
    sampleFingerprint(),
  );
  const raw = t.members.raw("edge-1")!;
  t.members.setRaw("edge-1", {
    ...raw,
    later: "x",
    fingerprint: { ...(raw.fingerprint as object), laterField: true },
  });
  t.clock.now += 5 * 60 * 1000;
  assertEquals((await t.hub.sweep()).membersWritten, 1);
  const after = t.members.raw("edge-1")!;
  assertEquals(after.status, "stale");
  assertEquals(after.later, "x");
  assertEquals((after.fingerprint as Record<string, unknown>).laterField, true);
});
