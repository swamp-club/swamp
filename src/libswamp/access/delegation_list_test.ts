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
import type { DataRecord } from "../../domain/data/data_record.ts";
import type { DelegationRecord } from "../../domain/models/access/delegation_model.ts";
import type { LibSwampContext } from "../context.ts";
import {
  delegationList,
  type DelegationListData,
  type DelegationListInput,
  delegationView,
} from "./delegation_list.ts";

const HASH = (c: string) => `sha256:${c.repeat(64)}`;

function record(overrides: Partial<DelegationRecord> = {}): DelegationRecord {
  return {
    id: crypto.randomUUID(),
    integrationId: "slack-bot",
    external: {
      platform: "slack",
      teamId: "T1",
      userId: "U1",
      display: "Adam",
      workspace: "Acme",
      email: "adam@example.com",
    },
    ceiling: { version: 1, ceiling: [] },
    ceilingDigest: "sha256:digest",
    phase: "issued",
    createdAt: new Date(1_000).toISOString(),
    updatedAt: new Date(1_000).toISOString(),
    redeemHash: HASH("a"),
    club: {
      requestId: "req-1",
      digest: "club-digest",
      consentExpiresAt: new Date(2_000).toISOString(),
      pollIntervalSeconds: 5,
      linkId: "link-1",
      endState: "none",
      endAttempts: 0,
    },
    person: {
      sub: "sub-1",
      username: "adam",
      email: "adam@example.com",
      collectives: ["acme"],
      groups: ["ops"],
    },
    consentedAt: new Date(1_500).toISOString(),
    expiresAt: new Date(10_000).toISOString(),
    tokens: {
      accessHash: HASH("b"),
      accessExpiresAt: new Date(5_000).toISOString(),
      previousAccessHash: HASH("c"),
      previousAccessExpiresAt: new Date(4_000).toISOString(),
      refreshHash: HASH("d"),
      generation: 2,
    },
    ...overrides,
  };
}

const HASHES = [HASH("a"), HASH("b"), HASH("c"), HASH("d")];

function stored(attributes: unknown): DataRecord {
  return { attributes } as unknown as DataRecord;
}

async function list(
  records: DataRecord[],
  input: DelegationListInput = {},
): Promise<DelegationListData> {
  for await (
    const event of delegationList({} as LibSwampContext, {
      query: () => Promise.resolve(records),
    }, input)
  ) {
    if (event.kind === "completed") return event.data;
    if (event.kind === "error") throw new Error(event.error.message);
  }
  throw new Error("no result");
}

Deno.test("delegationView: never holds a token hash, the redeem hash or the person's groups", () => {
  const view = delegationView(record());
  const text = JSON.stringify(view);
  for (const hash of HASHES) assert(!text.includes(hash), text);
  for (const key of ["Hash", 'ceiling"', "sub", "collectives", "groups"]) {
    assert(!text.includes(key), `${key} in ${text}`);
  }
  assertEquals(view.person, { username: "adam", email: "adam@example.com" });
  assertEquals(view.tokenGeneration, 2);
  assertEquals(view.accessTokenExpiresAt, new Date(5_000).toISOString());
  assertEquals(view.club, {
    linkId: "link-1",
    endState: "none",
    endAttempts: 0,
  });
});

Deno.test("delegationView: an ended record shows when and why, and a refused one its reason", () => {
  const ended = delegationView(record({
    phase: "ended",
    tokens: undefined,
    ended: { cause: "operator", at: new Date(3_000).toISOString() },
    club: {
      ...record().club,
      endState: "pending",
      endAttempts: 2,
      lastEndError: "swamp-club answered 503",
      nextEndAttemptAt: new Date(4_000).toISOString(),
    },
  }));
  assertEquals(ended.endCause, "operator");
  assertEquals(ended.endedAt, new Date(3_000).toISOString());
  assertEquals(ended.tokenGeneration, undefined);
  assertEquals(ended.club.lastEndError, "swamp-club answered 503");

  const refused = delegationView(record({
    phase: "refused",
    refusal: { reason: "consent_denied", at: new Date(3_000).toISOString() },
  }));
  assertEquals(refused.refusalReason, "consent_denied");
});

Deno.test("delegationList: newest first, filtered by integration and state, with no hash", async () => {
  const older = record({ createdAt: new Date(1_000).toISOString() });
  const newer = record({ createdAt: new Date(2_000).toISOString() });
  const other = record({
    integrationId: "teams-bot",
    phase: "ended",
    tokens: undefined,
    createdAt: new Date(3_000).toISOString(),
  });
  const all = await list([older, newer, other].map(stored));
  assertEquals(all.delegations.map((v) => v.id), [
    other.id,
    newer.id,
    older.id,
  ]);
  const text = JSON.stringify(all);
  for (const hash of HASHES) assert(!text.includes(hash), text);

  const bySlack = await list([older, newer, other].map(stored), {
    integrationId: "slack-bot",
  });
  assertEquals(bySlack.count, 2);
  const ended = await list([older, newer, other].map(stored), {
    state: "ended",
  });
  assertEquals(ended.delegations.map((v) => v.id), [other.id]);
});

Deno.test("delegationList: a record this build can't read shows as unreadable without its hashes, and one with no id is dropped", async () => {
  const bad = { ...record(), phase: "future-phase" };
  const data = await list([stored(bad), stored({ phase: "issued" })]);
  assertEquals(data.delegations.map((v) => [v.id, v.state]), [
    [bad.id, "unreadable"],
  ]);
  const text = JSON.stringify(data);
  for (const hash of HASHES) assert(!text.includes(hash), text);
  assertEquals(data.delegations[0].external.userId, "U1");
});

Deno.test("delegationList: a failed query is an error event", async () => {
  for await (
    const event of delegationList({} as LibSwampContext, {
      query: () => Promise.reject(new Error("boom")),
    })
  ) {
    if (event.kind === "error") {
      assertEquals(event.error.code, "delegation_list_failed");
      return;
    }
  }
  throw new Error("no error event");
});
