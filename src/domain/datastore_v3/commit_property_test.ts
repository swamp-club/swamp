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
import { Commit } from "./commit.ts";
import { leaseOp, type Op, tombstoneOp } from "./op.ts";
import {
  dataKey,
  modelCommit,
  modelIntent,
  savePut,
  versionOp,
} from "./v3_test_helpers.ts";

/** A recipe for one op, built asynchronously because puts hash content. */
const arbOpRecipe = fc.oneof(
  fc.record({
    kind: fc.constant("put" as const),
    version: fc.integer({ min: 1, max: 50 }),
    text: fc.string({ maxLength: 40 }),
  }),
  fc.record({
    kind: fc.constant("tombstone" as const),
    version: fc.integer({ min: 1, max: 50 }),
  }),
  fc.record({
    kind: fc.constant("data-version" as const),
    version: fc.integer({ min: 1, max: 50 }),
  }),
  fc.record({
    kind: fc.constant("lease" as const),
    fence: fc.nat({ max: 1000 }),
  }),
);

type OpRecipe = typeof arbOpRecipe extends fc.Arbitrary<infer T> ? T : never;

async function build(recipe: OpRecipe): Promise<Op> {
  switch (recipe.kind) {
    case "put":
      return await savePut("vpc", recipe.version, recipe.text);
    case "tombstone":
      return tombstoneOp({
        intent: modelIntent({
          kind: "data.delete",
          name: "vpc",
          version: recipe.version,
        }),
        key: dataKey("vpc", recipe.version),
      });
    case "data-version":
      return versionOp("vpc", recipe.version);
    case "lease":
      return leaseOp({ holder: "serve-1", fence: recipe.fence });
  }
}

const arbCommitRecipe = fc.record({
  seq: fc.integer({ min: 1, max: 1_000_000 }),
  txnId: fc.string({ minLength: 1, maxLength: 30 }),
  fence: fc.option(fc.nat({ max: 1000 }), { nil: undefined }),
  principal: fc.option(fc.string({ minLength: 1, maxLength: 20 }), {
    nil: undefined,
  }),
  ops: fc.array(arbOpRecipe, { minLength: 1, maxLength: 6 }),
});

type CommitRecipe = typeof arbCommitRecipe extends fc.Arbitrary<infer T> ? T
  : never;

async function buildCommit(recipe: CommitRecipe): Promise<Commit> {
  const ops: Op[] = [];
  for (const op of recipe.ops) ops.push(await build(op));
  return modelCommit(recipe.seq, ops, {
    txnId: recipe.txnId,
    fence: recipe.fence,
    principal: recipe.principal,
  });
}

Deno.test("Commit.fromJSON: round-trips random commits", async () => {
  await fc.assert(
    fc.asyncProperty(arbCommitRecipe, async (recipe) => {
      const commit = await buildCommit(recipe);
      const parsed = await Commit.fromJSON(JSON.parse(JSON.stringify(commit)));
      assert(parsed.equals(commit));
      assertEquals(parsed.toJSON(), commit.toJSON());
    }),
    { numRuns: 150 },
  );
});

Deno.test("Commit.equals: is symmetric and matches serialized equality", async () => {
  await fc.assert(
    fc.asyncProperty(arbCommitRecipe, arbCommitRecipe, async (ra, rb) => {
      const a = await buildCommit(ra);
      const b = await buildCommit(rb);
      assertEquals(a.equals(b), b.equals(a));
      assertEquals(
        a.equals(b),
        JSON.stringify(a.toJSON()) === JSON.stringify(b.toJSON()),
      );
    }),
    { numRuns: 100 },
  );
});

Deno.test("Commit.create: rejects any seq that is not a positive integer", async () => {
  const op = await savePut("vpc", 1);
  fc.assert(
    fc.property(
      fc.oneof(
        fc.integer({ max: 0 }),
        fc.double().filter((n) => !Number.isSafeInteger(n) || n < 1),
      ),
      (seq) => {
        try {
          modelCommit(seq, [op]);
          return false;
        } catch {
          return true;
        }
      },
    ),
    { numRuns: 300 },
  );
});
