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
import { RUN_CHECKPOINT_INTERVAL_MS } from "../src/infrastructure/persistence/workflow_run_checkpointer.ts";

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

// WorkflowRunCheckpointer's pacing on a simulated clock; `atStart` adds the
// at-once checkpoint of each step start.
async function simulatePacedRun(
  steps: number,
  stepMs: number,
  atStart: boolean,
): Promise<number> {
  const workflowId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const run = new RunChanges(workflowId, runId);
  const recordKey = recordKeyOf([
    "workflow-runs",
    workflowId,
    `workflow-run-${runId}.yaml`,
  ]);
  let checkpoints = 0;
  await engine.runRoot({}, async () => {
    const unit = engine.openUnit() as unknown as CommitLogUnitOfWork;
    await runInUnitOfWork(unit, async () => {
      let lastStarted = Number.NEGATIVE_INFINITY;
      let trailingAt: number | undefined;
      const commit = async (at: number) => {
        lastStarted = at;
        checkpoints++;
        await checkpointFrom(unit);
      };
      const save = async (
        kind: "run.create" | "run.update",
        size: number,
        at: number,
        atOnce: boolean,
      ) => {
        if (trailingAt !== undefined && trailingAt <= at) {
          await commit(trailingAt);
          trailingAt = undefined;
        }
        // Salted per run: the chunk store keeps one copy of equal content.
        const bytes = new Uint8Array(size).fill(size % 251);
        bytes.set(new TextEncoder().encode(runId).subarray(0, size));
        await unit.stageOps([
          run.write(kind, recordKey, () => ReadableStream.from([bytes])),
        ]);
        if (atOnce || at - lastStarted >= RUN_CHECKPOINT_INTERVAL_MS) {
          trailingAt = undefined;
          await commit(at);
        } else {
          trailingAt ??= lastStarted + RUN_CHECKPOINT_INTERVAL_MS;
        }
      };
      let now = 0;
      await save("run.create", RECORD_BASE_BYTES, now, false);
      for (let step = 0; step < steps; step++) {
        const size = RECORD_BASE_BYTES + step * RECORD_BYTES_PER_STEP;
        await save("run.update", size, now, atStart);
        const id = crypto.randomUUID();
        await unit.stageOps([
          new AutoDefinitionChanges(id).write(
            recordKeyOf(["auto-definitions", `${id}.yaml`]),
            new Uint8Array(512).fill(step % 251),
          ),
        ]);
        now += stepMs;
        await save("run.update", size + RECORD_BYTES_PER_STEP, now, false);
      }
      await save(
        "run.update",
        RECORD_BASE_BYTES + steps * RECORD_BYTES_PER_STEP,
        now,
        true,
      );
    });
    await unit.commit();
  });
  return checkpoints;
}

async function bytesUnder(path: string): Promise<number> {
  let total = 0;
  for await (const entry of Deno.readDir(path)) {
    const child = join(path, entry.name);
    if (entry.isDirectory) total += await bytesUnder(child);
    else if (entry.isFile) total += (await Deno.stat(child)).size;
  }
  return total;
}

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

for (const steps of [10, 50, 200, 1_000]) {
  for (const stepMs of steps === 1_000 ? [0] : [0, 100, 500, 2_000]) {
    const sizes: string[] = [];
    for (const atStart of [false, true]) {
      const before = await stored();
      const checkpoints = await simulatePacedRun(steps, stepMs, atStart);
      const after = await stored();
      sizes.push(
        `${mib(after.chunks - before.chunks)} (${checkpoints} checkpoints)`,
      );
    }
    console.log(
      `${steps} steps of ${stepMs} ms: paced ${sizes[0]}, ` +
        `with each step start ${sizes[1]}`,
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
