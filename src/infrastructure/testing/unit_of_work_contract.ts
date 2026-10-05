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

/**
 * The behaviour every {@link UnitOfWork} adapter must have, as one reusable
 * suite. The legacy adapter runs it today; the datastore rework's Phase 3
 * commit-log adapter runs the same suite.
 *
 * Test-only: production code must never import this module.
 *
 * @module
 */

import {
  assertEquals,
  AssertionError,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import type {
  StagedChange,
  UnitOfWork,
} from "../../domain/datastore/unit_of_work.ts";

/** A fresh unit of work and a view of what it sent downstream. */
export interface UnitOfWorkProbe {
  unit: UnitOfWork;
  /**
   * The target of each change the unit forwarded downstream, in order: the
   * path for `write` and `remove`, `undefined` for `bulk`.
   *
   * The legacy adapter forwards at `stage`. An adapter that defers sending
   * until `commit` (a Phase 3 commit-log adapter may) must report here the
   * changes it has accepted for commit, in order.
   */
  forwarded(): readonly (string | undefined)[];
  /** Makes the next downstream forward reject with `error`. */
  failNext(error: Error): void;
  /**
   * Holds the next downstream forward open until the returned function is
   * called.
   */
  holdNext(): () => void;
  /** How many forwards downstream have started but not yet completed. */
  pendingForwards(): number;
  /**
   * Runs `listener` each time the unit makes its changes durable downstream.
   * A listener that rejects makes that commit reject with the same error.
   */
  onCommit(listener: () => Promise<void>): void;
  /**
   * Runs `listener` each time the unit finishes abandoning downstream: the
   * legacy adapter's flush, or a commit-log adapter's discard. A listener
   * that rejects makes that abandon reject with the same error.
   */
  onAbandon(listener: () => Promise<void>): void;
}

/** Builds a fresh probe for each contract case. */
export type UnitOfWorkFactory = () =>
  | UnitOfWorkProbe
  | Promise<UnitOfWorkProbe>;

interface ContractCase {
  name: string;
  run: (probe: UnitOfWorkProbe) => Promise<void>;
}

const WRITE_A: StagedChange = { kind: "write", path: "/cache/data/a" };
const REMOVE_B: StagedChange = { kind: "remove", path: "/cache/data/b" };
const BULK: StagedChange = { kind: "bulk", reason: "contract bulk" };

async function assertSpent(
  unit: UnitOfWork,
  ended: "committed" | "abandoned",
): Promise<void> {
  const message = `unit of work already ${ended}`;
  await assertRejects(() => unit.stage(REMOVE_B), Error, message);
  await assertRejects(() => unit.commit(), Error, message);
  await assertRejects(() => unit.abandon(), Error, message);
}

const CASES: readonly ContractCase[] = [
  {
    // Reads forwarded() once stage resolves: legacy forward-at-stage timing,
    // or "accepted for commit" for an adapter that defers (see forwarded).
    name: "stage order is preserved",
    run: async ({ unit, forwarded }) => {
      const changes = [WRITE_A, BULK, REMOVE_B, WRITE_A];
      for (const change of changes) await unit.stage(change);
      assertEquals(forwarded(), [
        "/cache/data/a",
        undefined,
        "/cache/data/b",
        "/cache/data/a",
      ]);
      assertEquals(unit.staged(), changes);
    },
  },
  {
    name: "staged() reflects stage calls",
    run: async ({ unit }) => {
      assertEquals(unit.staged(), []);
      await unit.stage(WRITE_A);
      const snapshot = unit.staged();
      await unit.stage(REMOVE_B);
      assertEquals(snapshot, [WRITE_A]);
      assertEquals(unit.staged(), [WRITE_A, REMOVE_B]);
    },
  },
  {
    name: "staged() is not changed through the caller's objects",
    run: async ({ unit }) => {
      const change = { kind: "write" as const, path: "/cache/data/a" };
      await unit.stage(change);
      change.path = "/cache/data/changed";
      assertEquals(unit.staged(), [WRITE_A]);
    },
  },
  {
    name: "commit happens once",
    run: async ({ unit, onCommit }) => {
      let commits = 0;
      onCommit(() => {
        commits++;
        return Promise.resolve();
      });
      await unit.stage(WRITE_A);
      await unit.commit();
      await assertSpent(unit, "committed");
      assertEquals(commits, 1);
      assertEquals(unit.staged(), [WRITE_A]);
    },
  },
  {
    name: "a failed commit spends the unit",
    run: async ({ unit, onCommit }) => {
      const error = new Error("commit failed");
      onCommit(() => Promise.reject(error));
      await unit.stage(WRITE_A);
      const rejected = await assertRejects(() => unit.commit());
      assertStrictEquals(rejected, error);
      await assertSpent(unit, "committed");
    },
  },
  {
    name: "abandon happens once and spends the unit",
    run: async ({ unit, onAbandon, onCommit }) => {
      let abandons = 0;
      let commits = 0;
      onAbandon(() => {
        abandons++;
        return Promise.resolve();
      });
      onCommit(() => {
        commits++;
        return Promise.resolve();
      });
      await unit.stage(WRITE_A);
      await unit.abandon();
      await assertSpent(unit, "abandoned");
      assertEquals(abandons, 1);
      assertEquals(commits, 0);
      assertEquals(unit.staged(), [WRITE_A]);
    },
  },
  {
    name: "a failed abandon spends the unit",
    run: async ({ unit, onAbandon }) => {
      const error = new Error("abandon failed");
      onAbandon(() => Promise.reject(error));
      await unit.stage(WRITE_A);
      const rejected = await assertRejects(() => unit.abandon());
      assertStrictEquals(rejected, error);
      await assertSpent(unit, "abandoned");
    },
  },
  {
    name: "abandon waits for a stage in flight",
    run: async ({ unit, holdNext, pendingForwards, onAbandon }) => {
      const release = holdNext();
      const stage = unit.stage(WRITE_A);
      let pendingAtAbandon: number | undefined;
      onAbandon(() => {
        pendingAtAbandon = pendingForwards();
        return Promise.resolve();
      });
      const abandon = unit.abandon();
      release();
      await stage;
      await abandon;
      assertEquals(pendingAtAbandon, 0);
    },
  },
  {
    name: "commit waits for a stage in flight",
    run: async ({ unit, holdNext, pendingForwards, onCommit }) => {
      const release = holdNext();
      const stage = unit.stage(WRITE_A);
      let pendingAtCommit: number | undefined;
      onCommit(() => {
        pendingAtCommit = pendingForwards();
        return Promise.resolve();
      });
      const commit = unit.commit();
      release();
      await stage;
      await commit;
      assertEquals(pendingAtCommit, 0);
    },
  },
  {
    // Assumes a downstream rejection surfaces at stage, as the legacy adapter
    // forwards there. An adapter that defers sending must surface it where its
    // design does, and adapt this case when it joins the suite.
    name: "a downstream error propagates",
    run: async ({ unit, forwarded, failNext }) => {
      const error = new Error("downstream failed");
      failNext(error);
      const rejected = await assertRejects(() => unit.stage(WRITE_A));
      assertStrictEquals(rejected, error);
      assertEquals(unit.staged(), [WRITE_A]);
      await unit.stage(REMOVE_B);
      assertEquals(forwarded().at(-1), "/cache/data/b");
    },
  },
];

/**
 * Runs every contract case against a fresh unit of work from `factory`,
 * throwing on the first failure with the case name. Call it inside a
 * `Deno.test`.
 */
export async function assertUnitOfWorkContract(
  factory: UnitOfWorkFactory,
): Promise<void> {
  for (const testCase of CASES) {
    const probe = await factory();
    try {
      await testCase.run(probe);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AssertionError(
        `unit of work contract "${testCase.name}" failed: ${message}`,
        { cause: error },
      );
    }
  }
}
