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
 * Follower mode (swamp-club#3985): a follower commit store and read model fed
 * random gapped seqs, as serve's changes feed delivers them with the commits
 * the caller may not read left out, end holding exactly what was delivered.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import fc from "fast-check";
import { ChunkStore } from "../../domain/datastore_v3/chunk_store.ts";
import { CommitRejectedError } from "../../domain/datastore_v3/partition.ts";
import {
  dataKey,
  MemoryStorage,
  modelCommit,
  modelPartition,
  savePut,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import { readModelStateDir } from "./record_path_guard.ts";
import { SqliteCommitStore } from "./sqlite_commit_store.ts";
import { SqliteReadModel } from "./sqlite_read_model.ts";
import { v3CacheRoot } from "./v3_datastore.ts";

/** Strictly increasing seqs from 1, with holes of up to four. */
const arbGappedSeqs = fc
  .array(fc.nat({ max: 4 }), { minLength: 1, maxLength: 25 })
  .map((gaps) => {
    const seqs: number[] = [];
    let seq = 0;
    for (const gap of gaps) {
      seq += 1 + gap;
      seqs.push(seq);
    }
    return seqs;
  });

async function removeDir(dir: string): Promise<void> {
  if (Deno.build.os === "windows") {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  } else {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("SqliteCommitStore + SqliteReadModel follower: over random gapped seqs the live records are exactly the delivered commits' keys", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbGappedSeqs,
      fc.array(fc.boolean(), { minLength: 25, maxLength: 25 }),
      fc.integer({ min: 1, max: 5 }),
      async (seqs, catchUpAfter, snapshotInterval) => {
        const dir = await Deno.makeTempDir({ prefix: "swamp-follower-prop-" });
        try {
          const path = join(dir, "commits.db");
          const repoDir = join(dir, "repo");
          const options = { follower: true, snapshotInterval };
          const commitFor = async (seq: number) =>
            modelCommit(seq, [await savePut("a", seq)], { fence: 1 });
          const store = SqliteCommitStore.open(path, options);
          const readModel = SqliteReadModel.open({
            commitStore: store,
            chunkStore: new ChunkStore(new MemoryStorage()),
            cacheRoot: (ns) => v3CacheRoot(repoDir, ns),
            stateDir: readModelStateDir(repoDir),
            follower: true,
          });
          try {
            for (const [index, seq] of seqs.entries()) {
              assertEquals(await store.append(await commitFor(seq)), {
                kind: "appended",
                seq,
              });
              if (catchUpAfter[index]) {
                await readModel.catchUp(AbortSignal.timeout(30_000));
              }
            }
            await readModel.catchUp(AbortSignal.timeout(30_000));
            const live = (await readModel.liveRecords("", modelPartition()))
              .map((record) => record.key.toString()).sort();
            assertEquals(
              live,
              seqs.map((seq) => dataKey("a", seq).toString()).sort(),
            );
            const last = seqs[seqs.length - 1];
            assertEquals((await store.head("", modelPartition())).seq, last);
          } finally {
            await readModel.close();
            await store.close();
          }

          // A reopened follower rebuilds past every gap: each delivered
          // commit is a duplicate and the next gapped seq appends.
          const reopened = SqliteCommitStore.open(path, options);
          try {
            const last = seqs[seqs.length - 1];
            for (const seq of seqs) {
              assertEquals(await reopened.append(await commitFor(seq)), {
                kind: "duplicate",
                seq,
              });
            }
            assertEquals(await reopened.append(await commitFor(last + 3)), {
              kind: "appended",
              seq: last + 3,
            });
          } finally {
            await reopened.close();
          }
        } finally {
          await removeDir(dir);
        }
      },
    ),
    { numRuns: 40 },
  );
});

Deno.test("SqliteCommitStore: a solo store refuses the first gap of any gapped seqs", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbGappedSeqs.filter((seqs) => seqs.some((seq, i) => seq !== i + 1)),
      async (seqs) => {
        const dir = await Deno.makeTempDir({ prefix: "swamp-solo-prop-" });
        try {
          const store = SqliteCommitStore.open(join(dir, "commits.db"));
          try {
            const firstGap = seqs.findIndex((seq, i) => seq !== i + 1);
            for (const seq of seqs.slice(0, firstGap)) {
              await store.append(
                modelCommit(seq, [await savePut("a", seq)], { fence: 1 }),
              );
            }
            const gapped = modelCommit(
              seqs[firstGap],
              [await savePut("a", seqs[firstGap])],
              { fence: 1 },
            );
            let reason: string | undefined;
            try {
              await store.append(gapped);
            } catch (error) {
              if (!(error instanceof CommitRejectedError)) throw error;
              reason = error.reason;
            }
            assertEquals(reason, "seq-gap");
            assertEquals(
              (await store.head("", modelPartition())).seq,
              firstGap,
            );
          } finally {
            await store.close();
          }
        } finally {
          await removeDir(dir);
        }
      },
    ),
    { numRuns: 40 },
  );
});
