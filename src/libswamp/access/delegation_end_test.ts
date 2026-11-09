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
import type { DelegationRecord } from "../../domain/models/access/delegation_model.ts";
import { createLibSwampContext } from "../context.ts";
import {
  delegationEnd,
  type DelegationEndData,
  type DelegationEndDeps,
} from "./delegation_end.ts";

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

const NOW = 3_000;

async function end(
  current: DelegationRecord | null | Error,
): Promise<
  { data?: DelegationEndData; code?: string; written: DelegationRecord[] }
> {
  const written: DelegationRecord[] = [];
  const deps: DelegationEndDeps = {
    read: () =>
      current instanceof Error
        ? Promise.reject(current)
        : Promise.resolve(current),
    write: (record) => {
      written.push(record);
      return Promise.resolve();
    },
  };
  for await (
    const event of delegationEnd(createLibSwampContext(), deps, {
      id: "id-1",
      nowMs: NOW,
    })
  ) {
    if (event.kind === "completed") return { data: event.data, written };
    if (event.kind === "error") return { code: event.error.code, written };
  }
  throw new Error("no result");
}

Deno.test("delegationEnd: ends an issued delegation as the operator, drops its tokens and leaves swamp-club to be told", async () => {
  const { data, written } = await end(record());
  assertEquals(written.length, 1);
  assertEquals(written[0].phase, "ended");
  assertEquals(written[0].ended, {
    cause: "operator",
    at: new Date(NOW).toISOString(),
  });
  assertEquals(written[0].tokens, undefined);
  assertEquals(data!.alreadyEnded, false);
  assertEquals(data!.delegation.club.endState, "pending");
  const text = JSON.stringify(data);
  for (const hash of HASHES) assert(!text.includes(hash), text);
});

Deno.test("delegationEnd: refuses a link still awaiting consent, as serve's own end does", async () => {
  const { data, written } = await end(record({
    phase: "awaiting_consent",
    person: undefined,
    consentedAt: undefined,
    expiresAt: undefined,
    tokens: undefined,
    club: { ...record().club, linkId: undefined },
  }));
  assertEquals(written[0].phase, "refused");
  assertEquals(data!.delegation.refusalReason, "operator");
});

Deno.test("delegationEnd: an ended or refused delegation is left as it is", async () => {
  for (const phase of ["ended", "refused"] as const) {
    const { data, written } = await end(
      record({ phase, tokens: undefined }),
    );
    assertEquals(written, []);
    assertEquals(data!.alreadyEnded, true);
  }
});

Deno.test("delegationEnd: an unknown or unreadable delegation is an error, with nothing written", async () => {
  const missing = await end(null);
  assertEquals(missing.code, "delegation_not_found");
  assertEquals(missing.written, []);
  const unreadable = await end(new Error("bad record"));
  assertEquals(unreadable.code, "delegation_unreadable");
  assertEquals(unreadable.written, []);
});
