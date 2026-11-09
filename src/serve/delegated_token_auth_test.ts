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
  delegationStanding,
  endDelegation,
  issueDelegationTokens,
  refreshDelegation,
} from "../domain/access/delegation.ts";
import type { DelegationLookup } from "../domain/access/delegation_directory.ts";
import { issueDelegatedSecret } from "../domain/access/delegated_token.ts";
import type { DelegationRecord } from "../domain/models/access/delegation_model.ts";
import {
  consentedRecord,
  T0,
} from "../domain/access/delegation_test_helpers.ts";
import {
  authenticateDelegatedToken,
  delegationOfSessionName,
  delegationSessionName,
} from "./delegated_token_auth.ts";
import { authenticateServerToken } from "./token_auth.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";

function lookupOf(record: DelegationRecord): DelegationLookup {
  return {
    standingOf: (id, nowMs) =>
      delegationStanding(
        id === record.id ? record : undefined,
        nowMs ?? T0,
        undefined,
      ),
    recordOf: (id) => (id === record.id ? record : undefined),
  };
}

Deno.test("authenticateDelegatedToken: an access token acts as the linked person through the integration", async () => {
  const { record, tokens } = await issueDelegationTokens(consentedRecord(), T0);
  const result = await authenticateDelegatedToken(
    tokens.access.value,
    lookupOf(record),
    T0 + 1000,
  );
  assert(result.ok);
  assertEquals(result.principalId, "user:sub-1");
  assertEquals(result.client, "integration:slack-bot");
  assertEquals(result.delegation, record.id);
  assertEquals(result.tokenName, delegationSessionName(record.id));
  assertEquals(result.tokenCreatedAt, record.consentedAt);
  assertEquals(result.accessExpiresAt, tokens.accessExpiresAt);
  assertEquals(result.collectives, ["skunk-ape"]);
});

Deno.test("authenticateDelegatedToken: refresh and redeem secrets never authenticate a request", async () => {
  const { record, tokens } = await issueDelegationTokens(consentedRecord(), T0);
  const redeem = await issueDelegatedSecret("redeem", record.id);
  for (const presented of [tokens.refresh.value, redeem.value]) {
    const result = await authenticateDelegatedToken(
      presented,
      lookupOf(record),
      T0,
    );
    assertEquals(result.ok, false);
  }
});

Deno.test("authenticateDelegatedToken: an ended, expired or unknown delegation and a wrong secret are refused", async () => {
  const { record, tokens } = await issueDelegationTokens(consentedRecord(), T0);
  const other = await issueDelegatedSecret("access", record.id);
  const cases: [string, DelegationLookup | undefined, number][] = [
    [tokens.access.value, lookupOf(endDelegation(record, "operator", T0)), T0],
    [tokens.access.value, lookupOf(record), T0 + 2 * 60 * 60 * 1000],
    [tokens.access.value, undefined, T0],
    [other.value, lookupOf(record), T0],
    ["swda1.garbage", lookupOf(record), T0],
  ];
  for (const [presented, lookup, now] of cases) {
    const result = await authenticateDelegatedToken(presented, lookup, now);
    assertEquals(result.ok, false, presented);
  }
});

Deno.test("authenticateDelegatedToken: after a refresh both access tokens work until the old one expires", async () => {
  const issued = await issueDelegationTokens(consentedRecord(), T0);
  const rotated = await refreshDelegation(
    issued.record,
    issued.tokens.refresh.value,
    T0 + 1000,
    delegationStanding(issued.record, T0, undefined),
  );
  assert(rotated.kind === "rotated");
  const lookup = lookupOf(rotated.record);
  assert(
    (await authenticateDelegatedToken(
      issued.tokens.access.value,
      lookup,
      T0 + 2000,
    ))
      .ok,
  );
  assert(
    (await authenticateDelegatedToken(
      rotated.tokens.access.value,
      lookup,
      T0 + 2000,
    ))
      .ok,
  );
});

Deno.test("authenticateServerToken: a delegated token never reaches a server-token lookup", async () => {
  const { record, tokens } = await issueDelegationTokens(consentedRecord(), T0);
  let reads = 0;
  const deps = {
    readToken: () => {
      reads++;
      return Promise.reject(new Error("no server token"));
    },
    readSecret: () => Promise.reject(new Error("no secret")),
    now: () => T0 + 1000,
    delegations: lookupOf(record),
  };
  const ok = await authenticateServerToken(
    tokens.access.value,
    "/nonexistent",
    {} as RepositoryContext,
    undefined,
    deps,
  );
  assert(ok.ok);
  assertEquals(ok.delegation, record.id);
  assertEquals(ok.sessionExpiresAt, tokens.accessExpiresAt);
  const refused = await authenticateServerToken(
    tokens.refresh.value,
    "/nonexistent",
    {} as RepositoryContext,
    undefined,
    deps,
  );
  assertEquals(refused.ok, false);
  assertEquals(reads, 0);
});

Deno.test("delegationSessionName: round-trips, and a server token name is not a delegation", () => {
  const id = crypto.randomUUID();
  assertEquals(delegationOfSessionName(delegationSessionName(id)), id);
  assertEquals(delegationOfSessionName("oauth-12345678"), undefined);
});
