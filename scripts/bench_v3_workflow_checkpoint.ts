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
 * What checkpointing a workflow run at every save would cost on v3
 * (swamp-club#3587). A simulated run of N steps saves its record twice a
 * step (started, completed), the record growing by about what a real
 * model step adds (its data artifacts' provenance), and stages one small
 * data record per step. "end only" commits once when the run ends, as
 * before the change; "checkpointed" checkpoints after every save. The A/A
 * pair runs the same case twice, so a gap between them is noise. Before
 * the benches, it prints the bytes each case adds to the datastore. The
 * stored bytes grow with the square of the steps, which is why
 * `WorkflowRunCheckpointer` starts at most one checkpoint per
 * `RUN_CHECKPOINT_INTERVAL_MS`.
 *
 * ```
 * deno bench -A scripts/bench_v3_workflow_checkpoint.ts
 * ```
 */

import { join } from "@std/path";
import type { CommitLogUnitOfWork } from "../src/domain/datastore_v3/commit_log_unit_of_work.ts";
import {
  AutoDefinitionChanges,
  recordKeyOf,
  RunChanges,
} from "../src/domain/datastore_v3/repository_changes.ts";
import { checkpointFrom } from "../src/infrastructure/datastore_v3/commit_log_unit_of_work.ts";
import {
  initializeV3Datastore,
  openV3Datastore,
} from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import { runInUnitOfWork } from "../src/infrastructure/persistence/unit_of_work_scope.ts";

/** About what a completed model step adds to its run's record. */
const RECORD_BYTES_PER_STEP = 4_500;
const RECORD_BASE_BYTES = 1_500;

const dir = await Deno.makeTempDir({ prefix: "swamp-v3-checkpoint-bench-" });
const datastorePath = join(dir, "datastore");
await initializeV3Datastore(datastorePath, "bench");
const handle = openV3Datastore({
  repoDir: join(dir, "repo"),
  datastorePath,
  writerFence: () => 1,
});
await handle.raiseWriterFence(1);
const engine = handle.engineFor(() => Promise.resolve(), () => {
  throw new Error("no run repository needed");
});

/** Runs a simulated workflow of `steps` steps in its own root. */
async function simulateRun(steps: number, checkpoint: boolean): Promise<void> {
  const workflowId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const run = new RunChanges(workflowId, runId);
  const recordKey = recordKeyOf([
    "workflow-runs",
    workflowId,
    `workflow-run-${runId}.yaml`,
  ]);
  await engine.runRoot({}, async () => {
    // The run's use-case unit, a child of the root, as `withUnitOfWork`
    // opens it.
    const unit = engine.openUnit() as unknown as CommitLogUnitOfWork;
    await runInUnitOfWork(unit, async () => {
      const save = async (kind: "run.create" | "run.update", size: number) => {
        // A real save stages a stream of the file it wrote, so the unit
        // elides a save superseded before it is read.
        const bytes = new Uint8Array(size).fill(size % 251);
        await unit.stageOps([
          run.write(kind, recordKey, () => ReadableStream.from([bytes])),
        ]);
        if (checkpoint) await checkpointFrom(unit);
      };
      await save("run.create", RECORD_BASE_BYTES);
      for (let step = 0; step < steps; step++) {
        const size = RECORD_BASE_BYTES + step * RECORD_BYTES_PER_STEP;
        await save("run.update", size);
        const id = crypto.randomUUID();
        await unit.stageOps([
          new AutoDefinitionChanges(id).write(
            recordKeyOf(["auto-definitions", `${id}.yaml`]),
            new Uint8Array(512).fill(step % 251),
          ),
        ]);
        await save("run.update", size + RECORD_BYTES_PER_STEP);
      }
    });
    await unit.commit();
  });
}

/** The bytes of the files under `path`. */
async function bytesUnder(path: string): Promise<number> {
  let total = 0;
  for await (const entry of Deno.readDir(path)) {
    const child = join(path, entry.name);
    if (entry.isDirectory) total += await bytesUnder(child);
    else if (entry.isFile) total += (await Deno.stat(child)).size;
  }
  return total;
}

/** Chunk bytes, and commit-log bytes (`commits.db` with its WAL). */
async function stored(): Promise<{ chunks: number; log: number }> {
  let log = 0;
  for (const name of ["commits.db", "commits.db-wal"]) {
    try {
      log += (await Deno.stat(join(datastorePath, name))).size;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return { chunks: await bytesUnder(join(datastorePath, "_blobs")), log };
}

const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
for (const steps of [10, 50, 200]) {
  for (const checkpoint of [false, true]) {
    const before = await stored();
    await simulateRun(steps, checkpoint);
    const after = await stored();
    console.log(
      `${steps} steps, ${checkpoint ? "checkpointed" : "end only"}: ` +
        `${mib(after.chunks - before.chunks)} of chunks, ` +
        `commit log grew ${mib(after.log - before.log)}`,
    );
  }
}

for (const steps of [10, 50]) {
  Deno.bench(`${steps} steps, end only`, async () => {
    await simulateRun(steps, false);
  });
  Deno.bench(`${steps} steps, checkpointed (A)`, async () => {
    await simulateRun(steps, true);
  });
  Deno.bench(`${steps} steps, checkpointed (A/A control)`, async () => {
    await simulateRun(steps, true);
  });
}
