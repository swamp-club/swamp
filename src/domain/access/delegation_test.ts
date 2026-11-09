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

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  accessTokenExpiry,
  accessTokenMatches,
  canonicalExternalKey,
  DELEGATED_ACCESS_LIFE_MS,
  DELEGATION_MAX_LIFE_MS,
  delegationStanding,
  DelegationTransitionError,
  endDelegation,
  issueDelegationTokens,
  recordApproval,
  recordClubEnd,
  refreshDelegation,
  refuseDelegation,
  supersessionOf,
} from "./delegation.ts";
import { DelegationSchema } from "../models/access/delegation_model.ts";
import {
  consentedRecord,
  PERSON,
  startedRecord,
  T0,
} from "./delegation_test_helpers.ts";

Deno.test("startDelegation: writes a valid record awaiting consent with trimmed ids", () => {
  const record = startedRecord();
  DelegationSchema.parse(record);
  assertEquals(record.phase, "awaiting_consent");
  assertEquals(record.external.platform, "slack");
  assertEquals(record.external.teamId, "T1");
  assertEquals(record.tokens, undefined);
});

Deno.test("recordReported: fixes the life at thirty days from consent", () => {
  const record = consentedRecord();
  assertEquals(record.phase, "consented");
  assertEquals(record.club.linkId, "link-1");
  assertEquals(
    Date.parse(record.expiresAt!) - Date.parse(record.consentedAt!),
    DELEGATION_MAX_LIFE_MS,
  );
});

Deno.test("issueDelegationTokens: issues once, storing only hashes", async () => {
  const { record, tokens } = await issueDelegationTokens(consentedRecord(), T0);
  DelegationSchema.parse(record);
  assertEquals(record.phase, "issued");
  assert(tokens.access.value.startsWith("swda1."));
  assert(tokens.refresh.value.startsWith("swdr1."));
  assertEquals(record.tokens?.accessHash, tokens.access.hash);
  assert(!JSON.stringify(record).includes(tokens.access.value));
  assert(!JSON.stringify(record).includes(tokens.refresh.value));
  await assertRejects(
    () => issueDelegationTokens(record, T0),
    DelegationTransitionError,
  );
});

Deno.test("issueDelegationTokens: refuses before the link is reported", async () => {
  await assertRejects(
    () => issueDelegationTokens(startedRecord(), T0),
    DelegationTransitionError,
  );
  await assertRejects(
    () =>
      issueDelegationTokens(recordApproval(startedRecord(), PERSON, T0), T0),
    DelegationTransitionError,
  );
});

Deno.test("refreshDelegation: keeps the refresh token and mints an access token, keeping the older one until it expires", async () => {
  const issued = await issueDelegationTokens(consentedRecord(), T0);
  const standing = delegationStanding(issued.record, T0, undefined);
  const outcome = await refreshDelegation(
    issued.record,
    issued.tokens.refresh.value,
    T0 + 1000,
    standing,
  );
  assert(outcome.kind === "refreshed");
  assertEquals(outcome.record.tokens?.generation, 2);
  assertEquals(
    outcome.record.tokens?.refreshHash,
    issued.record.tokens?.refreshHash,
  );
  assert(
    await accessTokenMatches(outcome.record, outcome.access.value, T0 + 2000),
  );
  assert(
    await accessTokenMatches(
      outcome.record,
      issued.tokens.access.value,
      T0 + 2000,
    ),
  );
  assert(
    !await accessTokenMatches(
      outcome.record,
      issued.tokens.access.value,
      T0 + DELEGATED_ACCESS_LIFE_MS + 1,
    ),
  );
});

Deno.test("refreshDelegation: racing refreshes with the same token all succeed and leave the link standing", async () => {
  const issued = await issueDelegationTokens(consentedRecord(), T0);
  let record = issued.record;
  for (let i = 1; i <= 3; i++) {
    const out = await refreshDelegation(
      record,
      issued.tokens.refresh.value,
      T0 + i,
      delegationStanding(record, T0 + i, undefined),
    );
    assert(out.kind === "refreshed");
    record = out.record;
  }
  assertEquals(record.phase, "issued");
  assertEquals(delegationStanding(record, T0 + 10, undefined).kind, "standing");
});

Deno.test("refreshDelegation: the current access token and the two before it work; a fourth pushes out the oldest", async () => {
  const issued = await issueDelegationTokens(consentedRecord(), T0);
  const access = [issued.tokens.access.value];
  let record = issued.record;
  for (let i = 1; i <= 3; i++) {
    const out = await refreshDelegation(
      record,
      issued.tokens.refresh.value,
      T0 + i,
      delegationStanding(record, T0 + i, undefined),
    );
    assert(out.kind === "refreshed");
    access.push(out.access.value);
    record = out.record;
  }
  const at = T0 + 10;
  assert(!await accessTokenMatches(record, access[0], at));
  for (const token of access.slice(1)) {
    assert(await accessTokenMatches(record, token, at));
    assertEquals(
      await accessTokenExpiry(record, token),
      new Date(
        T0 + access.indexOf(token) + DELEGATED_ACCESS_LIFE_MS,
      ).toISOString(),
    );
  }
  assertEquals(record.tokens?.olderAccess?.length, 1);
});

Deno.test("refreshDelegation: an expired earlier access token is not carried into olderAccess", async () => {
  const issued = await issueDelegationTokens(consentedRecord(), T0);
  const first = await refreshDelegation(
    issued.record,
    issued.tokens.refresh.value,
    T0 + 1,
    delegationStanding(issued.record, T0 + 1, undefined),
  );
  assert(first.kind === "refreshed");
  const late = T0 + DELEGATED_ACCESS_LIFE_MS + 10;
  const second = await refreshDelegation(
    first.record,
    issued.tokens.refresh.value,
    late,
    delegationStanding(first.record, late, undefined),
  );
  assert(second.kind === "refreshed");
  assertEquals(second.record.tokens?.olderAccess, undefined);
});

Deno.test("refreshDelegation: a wrong refresh token is refused and ends nothing", async () => {
  const issued = await issueDelegationTokens(consentedRecord(), T0);
  const other = await issueDelegationTokens(consentedRecord(), T0);
  const outcome = await refreshDelegation(
    issued.record,
    other.tokens.refresh.value,
    T0 + 1000,
    delegationStanding(issued.record, T0, undefined),
  );
  assertEquals(outcome, { kind: "refused", reason: "mismatch" });
});

Deno.test("accessTokenMatches: a record written by a previous build, without olderAccess, still authenticates its two tokens", async () => {
  const issued = await issueDelegationTokens(consentedRecord(), T0);
  const out = await refreshDelegation(
    issued.record,
    issued.tokens.refresh.value,
    T0 + 1,
    delegationStanding(issued.record, T0 + 1, undefined),
  );
  assert(out.kind === "refreshed");
  const { olderAccess: _dropped, ...legacy } = out.record.tokens!;
  const record = { ...out.record, tokens: legacy };
  assert(await accessTokenMatches(record, out.access.value, T0 + 2));
  assert(await accessTokenMatches(record, issued.tokens.access.value, T0 + 2));
});

Deno.test("refreshDelegation: a delegation without standing is refused without rotating or ending", async () => {
  const issued = await issueDelegationTokens(consentedRecord(), T0);
  const outcome = await refreshDelegation(
    issued.record,
    issued.tokens.refresh.value,
    T0,
    { kind: "superseded" },
  );
  assertEquals(outcome, { kind: "refused", reason: "superseded" });
});

Deno.test("delegationStanding: issued and inside its life stands; expiry, end and supersession do not", async () => {
  const { record } = await issueDelegationTokens(consentedRecord(), T0);
  assertEquals(delegationStanding(record, T0, undefined).kind, "standing");
  assertEquals(
    delegationStanding(record, T0 + DELEGATION_MAX_LIFE_MS, undefined).kind,
    "expired",
  );
  assertEquals(delegationStanding(record, T0, "other").kind, "superseded");
  assertEquals(
    delegationStanding(endDelegation(record, "operator", T0), T0, undefined)
      .kind,
    "ended",
  );
  assertEquals(
    delegationStanding(consentedRecord(), T0, undefined).kind,
    "not_issued",
  );
  assertEquals(delegationStanding(undefined, T0, undefined).kind, "unknown");
  assertEquals(
    delegationStanding({ ...record, ceiling: { version: 9 } }, T0, undefined)
      .kind,
    "unreadable",
  );
});

Deno.test("accessTokenMatches: the access token stops at the delegation's own expiry", async () => {
  const consented = consentedRecord();
  const late = T0 + DELEGATION_MAX_LIFE_MS - 60_000;
  const { record, tokens } = await issueDelegationTokens(consented, late);
  assertEquals(record.tokens?.accessExpiresAt, consented.expiresAt);
  assert(!await accessTokenMatches(record, tokens.access.value, late + 61_000));
});

Deno.test("endDelegation: tells swamp-club only about a reported link it didn't end itself", () => {
  const reported = consentedRecord();
  assertEquals(
    endDelegation(reported, "operator", T0).club.endState,
    "pending",
  );
  assertEquals(
    endDelegation(reported, "club_ended", T0).club.endState,
    "none",
  );
  const refused = refuseDelegation(startedRecord(), "no", T0);
  assertEquals(endDelegation(refused, "operator", T0), refused);
});

Deno.test("recordClubEnd: retries keep their count and the last error, and success clears them", () => {
  const ended = endDelegation(consentedRecord(), "operator", T0);
  const failed = recordClubEnd(ended, {
    ok: false,
    error: "503",
    retryAtMs: T0 + 5000,
  }, T0);
  assertEquals(failed.club.endState, "pending");
  assertEquals(failed.club.endAttempts, 1);
  assertEquals(failed.club.lastEndError, "503");
  const done = recordClubEnd(failed, { ok: true }, T0 + 6000);
  assertEquals(done.club.endState, "done");
  assertEquals(done.club.lastEndError, undefined);
  assertEquals(done.club.nextEndAttemptAt, undefined);
});

Deno.test("refuseDelegation: only before the link is recorded", () => {
  assertThrows(
    () => refuseDelegation(consentedRecord(), "late", T0),
    DelegationTransitionError,
  );
});

Deno.test("supersessionOf: the newest consent per person wins, keyed case-insensitively", () => {
  const older = consentedRecord({ userId: "U1", atMs: T0 });
  const newer = consentedRecord({ userId: "u1", atMs: T0 + 1000 });
  const otherPerson = consentedRecord({ userId: "U2", atMs: T0 });
  const pending = startedRecord({ userId: "U1" });
  const superseded = supersessionOf([older, newer, otherPerson, pending]);
  assertEquals(superseded.get(older.id), newer.id);
  assertEquals(superseded.has(newer.id), false);
  assertEquals(superseded.has(otherPerson.id), false);
  assertEquals(superseded.has(pending.id), false);
  assertEquals(
    canonicalExternalKey("a", { platform: "Slack", teamId: "T", userId: "U" }),
    canonicalExternalKey("a", {
      platform: "slack ",
      teamId: "t",
      userId: " u",
    }),
  );
});

Deno.test("supersessionOf: an ended newest consent still supersedes the older one", () => {
  const older = consentedRecord({ atMs: T0 });
  const newer = endDelegation(
    consentedRecord({ atMs: T0 + 1000 }),
    "operator",
    T0 + 2000,
  );
  assertEquals(supersessionOf([older, newer]).get(older.id), newer.id);
});
