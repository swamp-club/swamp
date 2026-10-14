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
 * Serve's shutdown disposes the continuation sweep, and must not wait for
 * the boot pass's read of a run index that has to be rebuilt or repaired
 * (swamp-club#3472): a real repository, a real serve context, and the
 * sweep as serve wires it.
 */

import { assertEquals } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  ContinuationSweepService,
  sweepContinuations,
} from "../src/serve/continuation_sweep_service.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../src/infrastructure/persistence/paths.ts";
import {
  getIndexPath,
  withIndexQueue,
} from "../src/infrastructure/persistence/workflow_run_index.ts";
import {
  createServeCtx,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";

await initializeLogging({});

const opts = { sanitizeOps: false, sanitizeResources: false };

/**
 * Saves a workflow with `count` suspended runs, then deletes its run index,
 * so the next read of it rebuilds the index from every record. Returns the
 * directory the index lives in.
 */
async function suspendedRunsWithoutIndex(
  repo: ServeRepo,
  count: number,
): Promise<string> {
  const workflow = Workflow.create({
    name: `held-${crypto.randomUUID().slice(0, 8)}`,
    autoResume: true,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({ name: "gate", task: StepTask.manualApproval("ok?") }),
        ],
      }),
    ],
  });
  await repo.repoContext.workflowRepo.save(workflow);
  for (let i = 0; i < count; i++) {
    const run = WorkflowRun.create(workflow);
    run.start();
    run.suspend();
    await repo.repoContext.workflowRunRepo.save(workflow.id, run);
  }
  const indexDir = swampPath(
    repo.repoDir,
    SWAMP_SUBDIRS.workflowRuns,
    workflow.id,
  );
  await Deno.remove(getIndexPath(indexDir));
  return indexDir;
}

/** The continuation sweep as serve builds it, over `repo`. */
function sweepService(repo: ServeRepo): ContinuationSweepService {
  const ctx = createServeCtx(repo);
  return new ContinuationSweepService({
    intervalMs: 3_600_000,
    sweep: ({ isStopping, signal }) =>
      sweepContinuations(ctx, { takeover: true, isStopping, signal }),
  });
}

/** Whether a file exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

Deno.test({
  name:
    "ContinuationSweepService: dispose does not wait for a boot pass read queued behind another reader of the run index",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const indexDir = await suspendedRunsWithoutIndex(repo, 3);
      const indexPath = getIndexPath(indexDir);

      // Another reader holds the index queue, as a request's rebuild does.
      const holder = Promise.withResolvers<void>();
      const held = withIndexQueue(indexDir, () => holder.promise);

      // The boot pass reads the missing index, then queues its repair.
      const original = Deno.readTextFile;
      let indexReads = 0;
      Deno.readTextFile = ((...args: Parameters<typeof original>) => {
        if (String(args[0]) === indexPath) indexReads++;
        return original(...args);
      }) as typeof original;
      const service = sweepService(repo);
      try {
        service.start();
        await waitFor(() => indexReads > 0, "the boot pass to read the index");
        // Resolves while the other reader still holds the queue.
        await service.dispose();
      } finally {
        Deno.readTextFile = original;
        holder.resolve();
        await held;
      }

      // The repair it let go of runs once the queue frees, sees its signal
      // aborted, and writes nothing. Queued behind it, this runs after it.
      await withIndexQueue(indexDir, () => Promise.resolve());
      assertEquals(await exists(indexPath), false);
    });
  },
});

Deno.test({
  name:
    "ContinuationSweepService: dispose stops the boot pass's run index rebuild between records, and it writes no index",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const indexDir = await suspendedRunsWithoutIndex(repo, 3);
      const indexPath = getIndexPath(indexDir);
      const service = sweepService(repo);

      // Disposed while the rebuild reads its first record, as SIGTERM does.
      const original = Deno.readTextFile;
      let recordReads = 0;
      let disposing: Promise<void> | undefined;
      Deno.readTextFile = ((...args: Parameters<typeof original>) => {
        if (/workflow-run-[^/\\]*\.yaml$/.test(String(args[0]))) {
          recordReads++;
          disposing ??= service.dispose();
        }
        return original(...args);
      }) as typeof original;
      try {
        service.start();
        await waitFor(() => disposing !== undefined, "the rebuild to start");
        await disposing;
        // The let-go rebuild settles at its next record; queued behind it,
        // this runs after it.
        await withIndexQueue(indexDir, () => Promise.resolve());
      } finally {
        Deno.readTextFile = original;
      }

      assertEquals(recordReads, 1);
      assertEquals(await exists(indexPath), false);
    });
  },
});
