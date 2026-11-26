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
  const outcome = await t.hub.join(plaintext, sampleFingerprint());
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
  const outcome = await t.hub.join(plaintext, sampleFingerprint());
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
      await t.hub.join(token, sampleFingerprint()),
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
  assertEquals(await t.hub.join(plaintext, sampleFingerprint()), {
    kind: "name-taken",
    memberName: "edge-1",
  });
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
  assertEquals(await t.hub.join(minted.plaintext, sampleFingerprint()), {
    kind: "name-taken",
    memberName: "central",
  });
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
    { at: t.clock.now },
  );
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
