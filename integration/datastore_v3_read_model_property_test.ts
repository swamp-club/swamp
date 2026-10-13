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
 * Model-based property test of the v3 read model (swamp-club#3239): random
 * command sequences from the partition reference model are appended to a
 * real `commits.db`, and after each catch-up (store-wide or of the
 * partition) the read model's files, live-record index and catalog must
 * match the reference model's present records and live versions. A second
 * read model replaying from cursor 0 must reach the same state.
 *
 * Pages hold one to three commits, and a catch-up can crash at its first
 * page's barrier (swamp-club#3337), losing a file that page wrote, as a power
 * loss would; the catch-up after it must repair the checkout. A step can
 * also reboot: one file written since the last reboot is lost or torn, and
 * the first catch-up in the new boot must repair it.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { ReadModelIncompleteError } from "../src/domain/datastore_v3/read_model.ts";
import { join } from "@std/path";
import fc from "fast-check";
import type { Op } from "../src/domain/datastore_v3/op.ts";
import { CommitRejectedError } from "../src/domain/datastore_v3/partition.ts";
import {
  arbCommand,
  buildOp,
  emptyModel,
  type Model,
  modelAppend,
  modelCommit,
  modelPartition,
  NAMES,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import type { SqliteReadModel } from "../src/infrastructure/datastore_v3/sqlite_read_model.ts";
import { READ_MODEL_STATE_FILE } from "../src/infrastructure/datastore_v3/sqlite_read_model.ts";
import { DurableWriteBatch } from "../src/infrastructure/datastore_v3/atomic_stream_write.ts";
import {
  catalogV3Path,
  readCatalog,
  readTree,
  type V3Env,
  withV3Env,
} from "./datastore_v3_read_model_helpers.ts";

const PARTITION = modelPartition();

/** How a step catches the read model up after its append. */
const arbCatchUp = fc.constantFrom(
  "none" as const,
  "store" as const,
  "partition" as const,
  "crash-truncate" as const,
  "crash-delete" as const,
  "reboot-truncate" as const,
  "reboot-delete" as const,
);

/**
 * A batch that records what it writes and, while `control.armed`, fails its
 * barrier once before syncing anything.
 */
class CrashingBatch extends DurableWriteBatch {
  constructor(
    readonly control: {
      armed: boolean;
      written: string[];
      sinceReboot: string[];
    },
  ) {
    // Unsynced, as the read model's own page batches are.
    super({ sync: false });
    control.written = [];
  }
  override async write(
    path: string,
    content: Uint8Array | ReadableStream<Uint8Array>,
    signal: AbortSignal,
    options?: { readonly absentDirectories?: readonly string[] },
  ): Promise<void> {
    await super.write(path, content, signal, options);
    this.control.written.push(path);
    this.control.sinceReboot.push(path);
  }
  override async barrier(): Promise<void> {
    if (this.control.armed) {
      this.control.armed = false;
      throw new Error("injected crash before the barrier");
    }
    await super.barrier();
  }
}

/** Loses one file the crashed page wrote: emptied or gone. */
async function loseWrite(
  written: readonly string[],
  how: "truncate" | "delete",
): Promise<void> {
  for (const path of written) {
    try {
      if (!(await Deno.stat(path)).isFile) continue;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
    if (how === "truncate") await Deno.truncate(path, 0);
    else await Deno.remove(path);
    return;
  }
}

async function assertMatchesModel(
  env: V3Env,
  readModel: SqliteReadModel,
  model: Model,
  complete: boolean,
): Promise<void> {
  const records = Object.fromEntries(
    Object.entries(model.records).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  // Every present record is a file holding its bytes, and nothing else is.
  assertEquals(Object.fromEntries(await readTree(env.cacheRoot(""))), records);
  // Until a catch-up has drained the feed, the index refuses to be read.
  if (!complete) {
    await assertRejects(
      () => readModel.liveRecords("", PARTITION),
      ReadModelIncompleteError,
    );
  } else {
    const index = await readModel.liveRecords("", PARTITION);
    assertEquals(
      Object.fromEntries(index.map((r) => [r.key.toString(), r.sha256])),
      records,
    );
  }
  // One row per live version, the greatest of each name latest.
  const expectedRows = NAMES.flatMap((name) => {
    const live = [...(model.live[name] ?? [])].sort((a, b) => a - b);
    return live.map((version) => [
      name,
      version,
      version === live.at(-1) ? 1 : 0,
    ]);
  });
  assertEquals(
    readCatalog(catalogV3Path(env)).rows.map((
      r,
    ) => [r.data_name, r.version, r.is_latest]),
    expectedRows,
  );
}

Deno.test("read model: matches the partition reference model after every catch-up and after a replay", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.tuple(arbCommand, arbCatchUp), {
        minLength: 1,
        maxLength: 15,
      }),
      fc.integer({ min: 1, max: 3 }),
      async (steps, pageSize) => {
        await withV3Env(async (env) => {
          let model = emptyModel();
          let txn = 0;
          let complete = false;
          const control = {
            armed: false,
            written: [] as string[],
            sinceReboot: [] as string[],
          };
          let boot = 0;
          const readModel = env.openReadModel({
            pageSize,
            writeBatch: () => new CrashingBatch(control),
            bootIdentity: () => Promise.resolve(`boot-id:${boot}`),
          });
          try {
            for (const [command, catchUp] of steps) {
              const ops: Op[] = [];
              for (const spec of command.ops) ops.push(await buildOp(spec));
              // Mostly the next seq and one fence, so most commits land;
              // refused ones are skipped, as the store skips them.
              const commit = modelCommit(model.seq + 1, ops, {
                txnId: `txn-${txn++}`,
                fence: 1,
              });
              try {
                await env.store.append(commit);
              } catch (error) {
                if (!(error instanceof CommitRejectedError)) throw error;
                continue;
              }
              const next = await modelAppend(model, commit, command.ops);
              assertEquals(next.result.kind, "appended");
              model = next.model;

              if (catchUp === "none") continue;
              const signal = AbortSignal.timeout(30_000);
              if (catchUp === "store") {
                await readModel.catchUp(signal);
                complete = true;
              } else if (catchUp.startsWith("reboot")) {
                await readModel.catchUp(signal);
                await loseWrite(
                  control.sinceReboot,
                  catchUp === "reboot-truncate" ? "truncate" : "delete",
                );
                boot++;
                control.sinceReboot = [];
                await readModel.catchUp(signal);
                complete = true;
              } else if (catchUp !== "partition") {
                // A catch-up with nothing to apply has no page, so no barrier.
                control.armed = true;
                const crashed = await readModel.catchUp(signal).then(
                  () => false,
                  (error) => {
                    assertStringIncludes(String(error), "injected crash");
                    return true;
                  },
                );
                control.armed = false;
                if (crashed) {
                  await loseWrite(
                    control.written,
                    catchUp === "crash-truncate" ? "truncate" : "delete",
                  );
                }
                await readModel.catchUp(signal);
                complete = true;
              } else {
                await readModel.catchUpPartition("", PARTITION, signal);
              }
              await assertMatchesModel(env, readModel, model, complete);
            }
            await readModel.catchUp(AbortSignal.timeout(30_000));
            await assertMatchesModel(env, readModel, model, true);
          } finally {
            await readModel.close();
          }

          // A second read model with no state replays from cursor 0.
          await Deno.remove(join(env.stateDir, READ_MODEL_STATE_FILE));
          const replay = env.openReadModel();
          try {
            await replay.catchUp(AbortSignal.timeout(30_000));
            await assertMatchesModel(env, replay, model, true);
          } finally {
            await replay.close();
          }
        });
      },
    ),
    { numRuns: 60 },
  );
});
