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
import fc from "fast-check";
import {
  type ServerToken,
  serverTokenSecretFingerprint,
  validateServerToken,
  verifyServerTokenSecret,
} from "./server_token_model.ts";

/**
 * A mint writes its secret and its record to two separate stores. This models
 * each mint as those two writes and lets concurrent mints of one name
 * interleave freely, which is what happens when nothing serialises them
 * (swamp-club#2482).
 */
const NAME = "shared-name";

interface Mint {
  principalId: string;
  secret: string;
}

interface Stores {
  secret: string | undefined;
  record: ServerToken | undefined;
}

async function recordFor(
  mint: Mint,
  withFingerprint: boolean,
): Promise<ServerToken> {
  return {
    name: NAME,
    state: "active",
    principalId: mint.principalId,
    principalEmail: mint.principalId,
    collectives: [],
    groups: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2999-01-01T00:00:00.000Z",
    vaultName: "_token-secrets",
    secretKey: `server-token-${NAME}`,
    ...(withFingerprint
      ? { secretFingerprint: await serverTokenSecretFingerprint(mint.secret) }
      : {}),
  };
}

/**
 * Applies the mints' writes in `order`: each entry names a mint, whose first
 * appearance is its vault put and whose second is its record write.
 */
async function runInterleaving(
  mints: Mint[],
  order: number[],
  withFingerprint: boolean,
): Promise<Stores> {
  const stores: Stores = { secret: undefined, record: undefined };
  const putDone = new Set<number>();
  for (const index of order) {
    if (!putDone.has(index)) {
      stores.secret = mints[index].secret;
      putDone.add(index);
    } else {
      stores.record = await recordFor(mints[index], withFingerprint);
    }
  }
  return stores;
}

/** The principal a credential authenticates as, or null when rejected. */
async function authenticate(
  stores: Stores,
  secret: string,
): Promise<string | null> {
  if (stores.record === undefined || stores.secret === undefined) return null;
  try {
    const presented = `${NAME}.${secret}`;
    validateServerToken(stores.record, NAME, presented, 0, stores.secret);
    await verifyServerTokenSecret(stores.record, stores.secret);
    return stores.record.principalId;
  } catch {
    return null;
  }
}

/** Between two and four mints, and an order of their two writes each. */
const arbRace = fc.integer({ min: 2, max: 4 }).chain((count) =>
  fc.tuple(
    fc.constant(
      Array.from({ length: count }, (_, i): Mint => ({
        principalId: `user:minter-${i}`,
        secret: `secret-${i}`.padEnd(64, "0"),
      })),
    ),
    fc.shuffledSubarray(
      Array.from({ length: count * 2 }, (_, i) => i % count),
      { minLength: count * 2 },
    ),
  )
);

Deno.test("server token pairing: a credential never authenticates as another mint's principal", async () => {
  await fc.assert(
    fc.asyncProperty(arbRace, async ([mints, order]) => {
      const stores = await runInterleaving(mints, order, true);
      for (const mint of mints) {
        const principal = await authenticate(stores, mint.secret);
        assert(
          principal === null || principal === mint.principalId,
          `${mint.principalId} authenticated as ${principal}`,
        );
      }
    }),
    { numRuns: 300 },
  );
});

Deno.test("server token pairing: mints that do not interleave leave the last one usable", async () => {
  await fc.assert(
    fc.asyncProperty(arbRace, async ([mints]) => {
      const order = mints.flatMap((_, i) => [i, i]);
      const stores = await runInterleaving(mints, order, true);
      const last = mints[mints.length - 1];
      assertEquals(await authenticate(stores, last.secret), last.principalId);
    }),
    { numRuns: 50 },
  );
});

Deno.test("server token pairing: without a fingerprint the interleaving authenticates as the wrong principal", async () => {
  const mints: Mint[] = [
    { principalId: "user:a", secret: "a".repeat(64) },
    { principalId: "user:b", secret: "b".repeat(64) },
  ];
  // secret A, secret B, record B, record A — the order from the issue.
  const order = [0, 1, 1, 0];

  const legacy = await runInterleaving(mints, order, false);
  assertEquals(await authenticate(legacy, mints[1].secret), "user:a");

  const fingerprinted = await runInterleaving(mints, order, true);
  assertEquals(await authenticate(fingerprinted, mints[1].secret), null);
  assertEquals(await authenticate(fingerprinted, mints[0].secret), null);
});
