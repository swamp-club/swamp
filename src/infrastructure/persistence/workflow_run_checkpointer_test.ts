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
import { hostname as osHostname } from "node:os";
import { waitFor } from "@swamp-club/swamp-testing";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import type {
  CommitLogEngine,
  OpenUnitCheckpoint,
} from "./repo_unit_of_work.ts";
import { WorkflowRunCheckpointer } from "./workflow_run_checkpointer.ts";

/** A root's end that failed to commit. */
const ROOT_FAILED = new Error("the end commit failed");
/** A root that committed, then threw (a settled refusal). */
const COMMITTED_THEN_THREW = new Error("refused, settled and committed");

function newRun(): WorkflowRun {
  return WorkflowRun.create(Workflow.create({
    name: "flow",
    jobs: [Job.create({
      name: "main",
      steps: [Step.create({
        name: "a",
        task: StepTask.model("writer", "write", {}),
      })],
    })],
  }));
}

/** An engine whose checkpoints answer from `answer`, counting the calls. */
function engine(
  answer: () => Promise<OpenUnitCheckpoint>,
): CommitLogEngine & { readonly calls: () => number } {
  let calls = 0;
  return {
    openUnit: () => {
      throw new Error("not used");
    },
    hasOpenUnit: () => true,
    checkpointOpenUnit: () => {
      calls++;
      return answer();
    },
    runRoot: () => Promise.reject(new Error("not used")),
    committedBeforeThrowing: (error) => error === COMMITTED_THEN_THREW,
    calls: () => calls,
  };
}

/** A tracker that records which rows were reopened. */
function tracker(): {
  reopened: string[];
  reopenCompleted(runId: string, pid: number, hostname: string): boolean;
} {
  const reopened: string[] = [];
  return {
    reopened,
    reopenCompleted(runId, pid, hostname) {
      assertEquals(pid, Deno.pid);
      assertEquals(hostname, osHostname());
      reopened.push(runId);
      return true;
    },
  };
}

Deno.test("WorkflowRunCheckpointer: a v2 context commits nothing and leaves no run to reopen", async () => {
  const checkpointer = new WorkflowRunCheckpointer({}, { intervalMs: 0 });
  const run = newRun();
  await checkpointer.checkpoint(run);
  const rows = tracker();
  assertEquals(
    await checkpointer.restoreUncommittedRuns(() => rows, ROOT_FAILED),
    [],
  );
  assertEquals(rows.reopened, []);
});

Deno.test("WorkflowRunCheckpointer: saves made while a checkpoint runs share the next one", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  const commitLog = engine(async () => {
    if (first) {
      first = false;
      await held;
    }
    return "committed";
  });
  const checkpointer = new WorkflowRunCheckpointer({ commitLog }, {
    intervalMs: 0,
  });
  const run = newRun();
  const saves = [
    checkpointer.checkpoint(run),
    checkpointer.checkpoint(run),
    checkpointer.checkpoint(run),
    checkpointer.checkpoint(run),
  ];
  release();
  await Promise.all(saves);
  assertEquals(commitLog.calls(), 2);
  // Every save was committed, so a failed end leaves nothing to reopen.
  assertEquals(
    await checkpointer.restoreUncommittedRuns(() => tracker(), ROOT_FAILED),
    [],
  );
});

Deno.test("WorkflowRunCheckpointer: a failed checkpoint never rejects, and after a failed end only a run committed before its last save is reopened", async () => {
  let failing = false;
  const commitLog = engine(() =>
    failing
      ? Promise.reject(new Error("the commit store is down"))
      : Promise.resolve("committed")
  );
  const checkpointer = new WorkflowRunCheckpointer({ commitLog }, {
    intervalMs: 0,
  });
  const finished = newRun();
  const lagging = newRun();
  const never = newRun();
  await checkpointer.checkpoint(finished);
  await checkpointer.checkpoint(lagging);
  failing = true;
  await checkpointer.checkpoint(lagging);
  await checkpointer.checkpoint(never);
  const rows = tracker();
  assertEquals(
    await checkpointer.restoreUncommittedRuns(() => rows, ROOT_FAILED),
    [
      lagging.id,
    ],
  );
  assertEquals(rows.reopened, [lagging.id]);
});

Deno.test("WorkflowRunCheckpointer: a refusal stops the checkpoints, and the saves after it count as uncommitted", async () => {
  let answer: OpenUnitCheckpoint = "committed";
  const commitLog = engine(() => Promise.resolve(answer));
  const checkpointer = new WorkflowRunCheckpointer({ commitLog }, {
    intervalMs: 0,
  });
  const run = newRun();
  await checkpointer.checkpoint(run);
  answer = "refused";
  await checkpointer.checkpoint(run);
  answer = "committed";
  await checkpointer.checkpoint(run);
  assertEquals(commitLog.calls(), 2);
  assertEquals(
    await checkpointer.restoreUncommittedRuns(() => tracker(), ROOT_FAILED),
    [
      run.id,
    ],
  );
});

Deno.test("WorkflowRunCheckpointer: a tracker that fails to open or reopen is logged, never thrown", async () => {
  const commitLog = engine(() => Promise.resolve("committed"));
  const checkpointer = new WorkflowRunCheckpointer({ commitLog }, {
    intervalMs: 0,
  });
  const run = newRun();
  await checkpointer.checkpoint(run);
  commitLog.checkpointOpenUnit = () => Promise.reject(new Error("down"));
  await checkpointer.checkpoint(run);
  assertEquals(
    await checkpointer.restoreUncommittedRuns(() => {
      throw new Error("the tracker database is locked");
    }, ROOT_FAILED),
    [],
  );
});

Deno.test("WorkflowRunCheckpointer: within the interval a save waits for one trailing checkpoint, which covers every save before it", async () => {
  const commitLog = engine(() => Promise.resolve("committed"));
  let now = 0;
  const checkpointer = new WorkflowRunCheckpointer({ commitLog }, {
    intervalMs: 50,
    now: () => now,
  });
  const run = newRun();
  await checkpointer.checkpoint(run);
  assertEquals(commitLog.calls(), 1);
  now = 10;
  await checkpointer.checkpoint(run);
  await checkpointer.checkpoint(run);
  assertEquals(commitLog.calls(), 1);
  await waitFor(() => commitLog.calls() === 2, "the trailing checkpoint");
  await checkpointer.close();
  assertEquals(commitLog.calls(), 2);
  // The trailing checkpoint covered the later saves.
  assertEquals(
    await checkpointer.restoreUncommittedRuns(() => tracker(), ROOT_FAILED),
    [],
  );
});

Deno.test("WorkflowRunCheckpointer: close cancels a trailing checkpoint not yet started, and a later save takes none", async () => {
  const commitLog = engine(() => Promise.resolve("committed"));
  const checkpointer = new WorkflowRunCheckpointer({ commitLog }, {
    intervalMs: 60_000,
  });
  const run = newRun();
  await checkpointer.checkpoint(run);
  await checkpointer.checkpoint(run);
  await checkpointer.close();
  await checkpointer.checkpoint(run);
  assertEquals(commitLog.calls(), 1);
  // The saves after the first were never committed by a checkpoint.
  const rows = tracker();
  assertEquals(
    await checkpointer.restoreUncommittedRuns(() => rows, ROOT_FAILED),
    [
      run.id,
    ],
  );
});

Deno.test("WorkflowRunCheckpointer: a save that ends the run checkpoints at once, so a failed end reopens nothing it committed", async () => {
  const commitLog = engine(() => Promise.resolve("committed"));
  let now = 0;
  const checkpointer = new WorkflowRunCheckpointer({ commitLog }, {
    intervalMs: 60_000,
    now: () => now,
  });
  const run = newRun();
  await checkpointer.checkpoint(run);
  now = 10;
  await checkpointer.checkpoint(run);
  assertEquals(commitLog.calls(), 1);
  run.start();
  run.endAsCancelled();
  await checkpointer.checkpoint(run);
  assertEquals(commitLog.calls(), 2);
  const rows = tracker();
  assertEquals(
    await checkpointer.restoreUncommittedRuns(() => rows, ROOT_FAILED),
    [],
  );
  assertEquals(rows.reopened, []);
});

Deno.test("WorkflowRunCheckpointer: a root that committed before it threw reopens nothing, even after a refusal", async () => {
  let answer: OpenUnitCheckpoint = "committed";
  const commitLog = engine(() => Promise.resolve(answer));
  const checkpointer = new WorkflowRunCheckpointer({ commitLog }, {
    intervalMs: 0,
  });
  const run = newRun();
  await checkpointer.checkpoint(run);
  answer = "refused";
  run.start();
  run.endAsCancelled();
  await checkpointer.checkpoint(run);
  const rows = tracker();
  assertEquals(
    await checkpointer.restoreUncommittedRuns(
      () => rows,
      COMMITTED_THEN_THREW,
    ),
    [],
  );
  assertEquals(rows.reopened, []);
});
