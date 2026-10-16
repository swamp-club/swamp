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
 * The writer lease and the commit store together, over random interleavings
 * of two or three writers acquiring, renewing, pausing past expiry, crashing,
 * releasing, being force-released and committing (swamp-club#3359). Each
 * writer is its own process with its own lease handle and its own
 * connection to one real `commits.db`. Two properties hold throughout:
 *
 * - no two acquisitions ever take the same fence;
 * - a commit by a writer that is not the current holder never lands, on any
 *   partition, whatever the writer itself knows.
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import fc from "fast-check";
import { leaseOp } from "../../domain/datastore_v3/op.ts";
import { partitionOf } from "../../domain/datastore_v3/partition_key.ts";
import { CommitRejectedError } from "../../domain/datastore_v3/partition.ts";
import {
  MODEL_TYPE,
  modelCommit,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import {
  WRITER_LEASE_CLOCK_SKEW_MS,
  WriterFencedError,
  WriterLease,
  WriterLeaseBusyError,
  type WriterLeaseHold,
} from "../../domain/datastore_v3/writer_lease.ts";
import { FileSystemControlPlaneStore } from "../persistence/fs_control_plane_store.ts";
import { SqliteCommitStore } from "./sqlite_commit_store.ts";

const TTL = 30_000;

type Command =
  | { kind: "acquire"; writer: number }
  | { kind: "renew"; writer: number }
  | { kind: "advance"; ms: number }
  | { kind: "crash"; writer: number }
  | { kind: "release"; writer: number }
  | { kind: "forceRelease" }
  | { kind: "commit"; writer: number };

function arbCommand(writers: number): fc.Arbitrary<Command> {
  const writer = fc.integer({ min: 0, max: writers - 1 });
  return fc.oneof(
    {
      arbitrary: writer.map((w) => ({ kind: "acquire", writer: w })),
      weight: 4,
    },
    { arbitrary: writer.map((w) => ({ kind: "renew", writer: w })), weight: 3 },
    {
      arbitrary: fc.constantFrom(
        1_000,
        TTL / 3,
        TTL + WRITER_LEASE_CLOCK_SKEW_MS + 1,
      )
        .map((ms) => ({ kind: "advance", ms })),
      weight: 3,
    },
    { arbitrary: writer.map((w) => ({ kind: "crash", writer: w })), weight: 1 },
    {
      arbitrary: writer.map((w) => ({ kind: "release", writer: w })),
      weight: 1,
    },
    { arbitrary: fc.constant({ kind: "forceRelease" }), weight: 1 },
    {
      arbitrary: writer.map((w) => ({ kind: "commit", writer: w })),
      weight: 5,
    },
  ) as fc.Arbitrary<Command>;
}

/** How often each interesting outcome happened, over every run. */
const coverage = {
  takeovers: 0,
  zombieCommitsRefused: 0,
  commitsLanded: 0,
  fencedRenewals: 0,
  busyRefusals: 0,
};

interface Writer {
  readonly pid: number;
  readonly lease: WriterLease;
  readonly commits: SqliteCommitStore;
  hold?: WriterLeaseHold;
  crashed: boolean;
}

async function run(writerCount: number, commands: readonly Command[]) {
  const dir = await Deno.makeTempDir({ prefix: "swamp-writer-lease-prop-" });
  const writers: Writer[] = [];
  try {
    const control = new FileSystemControlPlaneStore(dir);
    const path = join(dir, "commits.db");
    let now = Date.parse("2026-10-13T12:00:00.000Z");
    const gone = new Set<number>();
    const fences: number[] = [];
    /** The fence of the last acquisition that raised commits.db. */
    let current: number | undefined;
    let txn = 0;
    for (let i = 0; i < writerCount; i++) {
      const pid = 100 + i;
      writers.push({
        pid,
        crashed: false,
        commits: SqliteCommitStore.open(path),
        lease: new WriterLease({
          store: control,
          holder: { holder: `w${i}@host`, hostname: "host", pid },
          ttlMs: TTL,
          now: () => now,
          delay: () => Promise.resolve(),
          processGone: (other) => gone.has(other),
          nonce: () => crypto.randomUUID(),
        }),
      });
    }

    for (const command of commands) {
      if (command.kind === "advance") {
        now += command.ms;
        continue;
      }
      if (command.kind === "forceRelease") {
        const inspection = await writers[0].lease.inspect();
        if (inspection?.record !== undefined) {
          await writers[0].lease.forceRelease(inspection.record.nonce);
        }
        continue;
      }
      const w = writers[command.writer];
      if (w.crashed) continue;
      switch (command.kind) {
        case "acquire": {
          if (w.hold !== undefined && w.hold.lost === undefined) break;
          const before = (await w.lease.inspect())?.state;
          let hold: WriterLeaseHold;
          try {
            hold = await w.lease.acquire({
              maxWaitMs: 0,
              floor: w.commits.writerFence(),
            });
          } catch (error) {
            if (!(error instanceof WriterLeaseBusyError)) throw error;
            coverage.busyRefusals++;
            break;
          }
          if (before === "held" || before === "expired") coverage.takeovers++;
          // Property: a fence is never taken twice.
          assert(!fences.includes(hold.fence), `fence ${hold.fence} reused`);
          fences.push(hold.fence);
          try {
            await w.commits.raiseWriterFence(hold.fence);
          } catch (error) {
            if (!(error instanceof WriterFencedError)) throw error;
            await hold.release();
            break;
          }
          current = hold.fence;
          w.hold = hold;
          break;
        }
        case "renew": {
          if (w.hold === undefined) break;
          const outcome = await w.hold.renew();
          if (outcome === "fenced") {
            coverage.fencedRenewals++;
          } else {
            // Property: only the newest acquisition can still renew.
            assertEquals(w.hold.fence, fences[fences.length - 1]);
          }
          break;
        }
        case "crash":
          gone.add(w.pid);
          w.crashed = true;
          w.hold = undefined;
          break;
        case "release":
          if (w.hold === undefined) break;
          await w.hold.release();
          w.hold = undefined;
          break;
        case "commit": {
          if (w.hold === undefined) break;
          // A paused writer commits without knowing it lost the lease: the
          // store must refuse it all the same. Each writer has its own
          // partition, so only the store-wide fence can stop it.
          const fence = w.hold.fence;
          const partition = partitionOf({
            kind: "model",
            type: MODEL_TYPE,
            id: `00000000-0000-4000-8000-00000000000${command.writer}`,
          });
          const head = await w.commits.head("", partition);
          const commit = modelCommit(
            head.seq + 1,
            [leaseOp({ holder: `w${command.writer}`, fence })],
            { partition, fence, txnId: `txn-${txn++}` },
          );
          let landed: boolean;
          try {
            await w.commits.append(commit);
            landed = true;
          } catch (error) {
            if (
              !(error instanceof WriterFencedError) &&
              !(error instanceof CommitRejectedError)
            ) {
              throw error;
            }
            landed = false;
          }
          // Property: only the current holder's commit lands.
          assertEquals(
            landed,
            fence === current,
            `fence ${fence} committing while ${current} is current`,
          );
          if (landed) {
            coverage.commitsLanded++;
          } else {
            coverage.zombieCommitsRefused++;
          }
          break;
        }
      }
    }
  } finally {
    for (const w of writers) await w.commits.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("WriterLease with SqliteCommitStore: fences are unique, and only the current holder's commits land", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 2, max: 3 }).chain((writers) =>
        fc.tuple(
          fc.constant(writers),
          fc.array(arbCommand(writers), { minLength: 1, maxLength: 40 }),
        )
      ),
      async ([writers, commands]) => {
        await run(writers, commands);
      },
    ),
    {
      numRuns: 400,
      // One interleaving that reaches every outcome below, so the coverage
      // check never rests on the random runs alone (swamp-club#3541).
      examples: [[[2, [
        { kind: "acquire", writer: 0 },
        { kind: "commit", writer: 0 },
        { kind: "acquire", writer: 1 },
        { kind: "advance", ms: TTL + WRITER_LEASE_CLOCK_SKEW_MS + 1 },
        { kind: "acquire", writer: 1 },
        { kind: "commit", writer: 0 },
        { kind: "renew", writer: 0 },
      ]]]],
    },
  );
  // The interleavings reached what the properties are about.
  for (const [outcome, count] of Object.entries(coverage)) {
    assert(count > 0, `no run produced any ${outcome}`);
  }
});
