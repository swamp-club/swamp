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

import { assertEquals } from "@std/assert";
import fc from "fast-check";
import { PartitionLocks } from "../infrastructure/datastore_v3/partition_locks.ts";
import { ForwardedCommitGate } from "./forwarded_commit_gate.ts";

const PARTITIONS = ["p0", "p1", "p2", "p3"];

type Writer =
  /** a forwarded commit judged against its own partition and others */
  | { kind: "shared"; write: string; reads: string[]; pauses: number }
  /** a forwarded commit that changes what every other commit is judged against */
  | { kind: "exclusive"; write: string; pauses: number }
  /** serve's own unit of work appending to one partition */
  | { kind: "own"; write: string; pauses: number };

const partition = fc.constantFrom(...PARTITIONS);
const pauses = fc.integer({ min: 0, max: 4 });
const writer: fc.Arbitrary<Writer> = fc.oneof(
  fc.record({
    kind: fc.constant("shared" as const),
    write: partition,
    reads: fc.uniqueArray(partition, { maxLength: 2 }),
    pauses,
  }),
  fc.record({
    kind: fc.constant("exclusive" as const),
    write: partition,
    pauses,
  }),
  fc.record({ kind: fc.constant("own" as const), write: partition, pauses }),
);

async function yieldTimes(times: number): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/**
 * Each writer runs as serve runs it, and a shared one records what it judged
 * against. Isolated when nothing it judged against moved before it wrote:
 * then the run equals some serial order of the same writers.
 */
async function run(writers: readonly Writer[]): Promise<string[]> {
  const gate = new ForwardedCommitGate();
  const locks = new PartitionLocks();
  const versions = new Map(PARTITIONS.map((p) => [p, 0]));
  let authority = 0;
  const violations: string[] = [];
  const judgeAndWrite = async (w: Writer, reads: readonly string[]) => {
    const judged = [...reads, w.write].map((p) => versions.get(p));
    const judgedAuthority = authority;
    await yieldTimes(w.pauses);
    const now = [...reads, w.write].map((p) => versions.get(p));
    if (
      JSON.stringify(now) !== JSON.stringify(judged) ||
      (w.kind === "shared" && authority !== judgedAuthority)
    ) {
      violations.push(JSON.stringify(w));
    }
    versions.set(w.write, versions.get(w.write)! + 1);
    if (w.kind === "exclusive") authority++;
  };
  await Promise.all(writers.map((w) => {
    switch (w.kind) {
      case "shared":
        return gate.run(
          "shared",
          () =>
            locks.hold([w.write, ...w.reads], () => judgeAndWrite(w, w.reads)),
        );
      case "exclusive":
        return gate.run(
          "exclusive",
          () => locks.hold([w.write], () => judgeAndWrite(w, [])),
        );
      case "own":
        return locks.hold([w.write], () => judgeAndWrite(w, []));
    }
  }));
  assertEquals(
    [...versions.values()].reduce((a, b) => a + b, 0),
    writers.length,
    "every writer wrote once",
  );
  return violations;
}

Deno.test("ForwardedCommitGate with PartitionLocks: any interleaving of shared, exclusive and serve-own writers is isolated", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(writer, { minLength: 1, maxLength: 12 }),
      async (writers) => {
        assertEquals(await run(writers), []);
      },
    ),
    { numRuns: 300 },
  );
});
