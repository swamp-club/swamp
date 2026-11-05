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

import { assertEquals, assertRejects } from "@std/assert";
import { hostname as osHostname } from "node:os";
import { waitFor } from "@swamp-club/swamp-testing";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import type {
  CommitLogEngine,
  OpenUnitAppend,
  OpenUnitCheckpoint,
} from "./repo_unit_of_work.ts";
import {
  AppendUnrecordedError,
  COMMIT_UNREACHABLE_CODE,
  type TypedChange,
} from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import { StepStartUnrecordedError } from "../../domain/workflows/step_start.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";
import { YamlWorkflowRunRepository } from "./yaml_workflow_run_repository.ts";
import {
  RUN_CHECKPOINT_INTERVAL_MS,
  setRunCheckpointIntervalForTesting,
  WorkflowRunCheckpointer,
} from "./workflow_run_checkpointer.ts";

const ROOT_FAILED = new Error("the end commit failed");
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
  assertEquals(
    await checkpointer.restoreUncommittedRuns(() => tracker(), ROOT_FAILED),
    [],
  );
});

Deno.test("setRunCheckpointIntervalForTesting: paces a checkpointer built without an interval", async () => {
  setRunCheckpointIntervalForTesting(60_000);
  try {
    const commitLog = engine(() => Promise.resolve("committed"));
    let now = 0;
    const checkpointer = new WorkflowRunCheckpointer({ commitLog }, {
      now: () => now,
    });
    const run = newRun();
    await checkpointer.checkpoint(run);
    now = 59_999;
    await checkpointer.checkpoint(run);
    assertEquals(commitLog.calls(), 1);
    await checkpointer.close();
    assertEquals(commitLog.calls(), 1);
  } finally {
    setRunCheckpointIntervalForTesting(undefined);
  }
});

Deno.test("setRunCheckpointIntervalForTesting: undefined restores the default interval", async () => {
  setRunCheckpointIntervalForTesting(60_000);
  setRunCheckpointIntervalForTesting(undefined);
  const commitLog = engine(() => Promise.resolve("committed"));
  let now = 0;
  const checkpointer = new WorkflowRunCheckpointer({ commitLog }, {
    now: () => now,
  });
  const run = newRun();
  await checkpointer.checkpoint(run);
  now = RUN_CHECKPOINT_INTERVAL_MS - 1;
  await checkpointer.checkpoint(run);
  assertEquals(commitLog.calls(), 1);
  await checkpointer.close();
  const fresh = new WorkflowRunCheckpointer({ commitLog }, {
    now: () => now,
  });
  now = 0;
  await fresh.checkpoint(run);
  now = RUN_CHECKPOINT_INTERVAL_MS;
  await fresh.checkpoint(run);
  assertEquals(commitLog.calls(), 3);
  await fresh.close();
});

Deno.test("setRunCheckpointIntervalForTesting: an explicit interval wins over it", async () => {
  setRunCheckpointIntervalForTesting(60_000);
  try {
    const commitLog = engine(() => Promise.resolve("committed"));
    let now = 0;
    const checkpointer = new WorkflowRunCheckpointer({ commitLog }, {
      intervalMs: 0,
      now: () => now,
    });
    const run = newRun();
    await checkpointer.checkpoint(run);
    now = 1;
    await checkpointer.checkpoint(run);
    assertEquals(commitLog.calls(), 2);
    await checkpointer.close();
  } finally {
    setRunCheckpointIntervalForTesting(undefined);
  }
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

Deno.test("WorkflowRunCheckpointer: a nested child run's ending save stays paced; its parent's covers it", async () => {
  const commitLog = engine(() => Promise.resolve("committed"));
  let now = 0;
  const checkpointer = new WorkflowRunCheckpointer({ commitLog }, {
    intervalMs: 60_000,
    now: () => now,
  });
  const parent = newRun();
  await checkpointer.checkpoint(parent);
  now = 10;
  const child = newRun();
  child.recordParentRun({
    workflowId: parent.workflowId,
    workflowName: "flow",
    runId: parent.id,
    jobName: "main",
    stepName: "a",
    nestingDepth: 1,
    ancestorWorkflowNames: ["flow"],
  });
  child.start();
  child.complete();
  await checkpointer.checkpoint(child);
  assertEquals(commitLog.calls(), 1);
  parent.start();
  parent.complete();
  await checkpointer.checkpoint(parent);
  assertEquals(commitLog.calls(), 2);
  assertEquals(
    await checkpointer.restoreUncommittedRuns(() => tracker(), ROOT_FAILED),
    [],
  );
});

Deno.test("WorkflowRunCheckpointer.committedUnknownSteps: names the steps in flight in the latest committed save, not in a later save that failed to commit (swamp-club#3882)", async () => {
  let failing = false;
  const commitLog = engine(() =>
    failing
      ? Promise.reject(new Error("the commit store is down"))
      : Promise.resolve("committed")
  );
  const checkpointer = new WorkflowRunCheckpointer({ commitLog }, {
    intervalMs: 0,
  });
  const cutMidStep = newRun();
  const cutBetweenSteps = newRun();
  const never = newRun();
  for (const run of [cutMidStep, cutBetweenSteps]) {
    run.start();
    run.jobs[0].start();
  }
  // Saved and committed while its step ran; the step ends in a save the
  // commit store never takes.
  cutMidStep.jobs[0].steps[0].start();
  await checkpointer.checkpoint(cutMidStep);
  cutBetweenSteps.jobs[0].steps[0].start();
  cutBetweenSteps.jobs[0].steps[0].succeed();
  await checkpointer.checkpoint(cutBetweenSteps);
  failing = true;
  cutMidStep.jobs[0].steps[0].succeed();
  await checkpointer.checkpoint(cutMidStep);
  await checkpointer.checkpoint(never);

  assertEquals(checkpointer.committedUnknownSteps(cutMidStep.id), ["a"]);
  assertEquals(checkpointer.committedUnknownSteps(cutBetweenSteps.id), []);
  assertEquals(checkpointer.committedUnknownSteps(never.id), undefined);
});

function twoStepRun(): WorkflowRun {
  return WorkflowRun.create(Workflow.create({
    name: "flow",
    jobs: [Job.create({
      name: "main",
      steps: ["a", "b"].map((name) =>
        Step.create({ name, task: StepTask.model("writer", "write", {}) })
      ),
    })],
  }));
}

Deno.test("WorkflowRunCheckpointer: a save that starts a step checkpoints at once inside the interval and resolves only once that checkpoint lands (swamp-club#4295)", async () => {
  let release: (() => void) | undefined;
  const commitLog = engine(() =>
    release === undefined ? Promise.resolve("committed") : new Promise<
      OpenUnitCheckpoint
    >((resolve) => {
      const done = release!;
      release = () => {
        done();
        resolve("committed");
      };
    })
  );
  let now = 0;
  const checkpointer = new WorkflowRunCheckpointer({ commitLog }, {
    intervalMs: 60_000,
    now: () => now,
  });
  const run = twoStepRun();
  await checkpointer.checkpoint(run);
  now = 10;
  run.start();
  run.jobs[0].start();
  await checkpointer.checkpoint(run);
  assertEquals(commitLog.calls(), 1);

  let landed = false;
  release = () => {
    landed = true;
  };
  run.jobs[0].steps[0].start();
  const saved = checkpointer.checkpoint(run).then(() => landed);
  await waitFor(() => commitLog.calls() === 2, "the step's checkpoint");
  release();
  assertEquals(await saved, true);
  assertEquals(checkpointer.committedUnknownSteps(run.id), ["a"]);
  await checkpointer.close();
});

Deno.test("WorkflowRunCheckpointer: inside the interval a step's progress and its end stay paced; only the next start checkpoints at once (swamp-club#4295)", async () => {
  const commitLog = engine(() => Promise.resolve("committed"));
  let now = 0;
  const checkpointer = new WorkflowRunCheckpointer({ commitLog }, {
    intervalMs: 60_000,
    now: () => now,
  });
  const run = twoStepRun();
  run.start();
  run.jobs[0].start();
  run.jobs[0].steps[0].start();
  await checkpointer.checkpoint(run);
  assertEquals(commitLog.calls(), 1);
  now = 10;
  await checkpointer.checkpoint(run);
  run.jobs[0].steps[0].succeed();
  await checkpointer.checkpoint(run);
  assertEquals(commitLog.calls(), 1);
  run.jobs[0].steps[1].start();
  await checkpointer.checkpoint(run);
  assertEquals(commitLog.calls(), 2);
  await checkpointer.close();
  assertEquals(commitLog.calls(), 2);
});

Deno.test("WorkflowRunCheckpointer: steps that start while a checkpoint runs share the one queued after it (swamp-club#4295)", async () => {
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
  let now = 0;
  const checkpointer = new WorkflowRunCheckpointer({ commitLog }, {
    intervalMs: 60_000,
    now: () => now,
  });
  const run = twoStepRun();
  run.start();
  run.jobs[0].start();
  const inFlight = checkpointer.checkpoint(run);
  now = 10;
  run.jobs[0].steps[0].start();
  const startA = checkpointer.checkpoint(run);
  run.jobs[0].steps[1].start();
  const startB = checkpointer.checkpoint(run);
  release();
  await Promise.all([inFlight, startA, startB]);
  assertEquals(commitLog.calls(), 2);
  assertEquals(checkpointer.committedUnknownSteps(run.id), ["a", "b"]);
  await checkpointer.close();
});

Deno.test("WorkflowRunCheckpointer: a step started again under the same name checkpoints at once (swamp-club#4295)", async () => {
  const commitLog = engine(() => Promise.resolve("committed"));
  let now = 0;
  const checkpointer = new WorkflowRunCheckpointer({ commitLog }, {
    intervalMs: 60_000,
    now: () => now,
  });
  const startedAt = (at: string) => {
    const data = newRun().toData();
    return WorkflowRun.fromData({
      ...data,
      id: runId,
      status: "running",
      jobs: [{
        ...data.jobs[0],
        status: "running",
        steps: [{ stepName: "a", status: "running", startedAt: at }],
      }],
    });
  };
  const runId = crypto.randomUUID();
  await checkpointer.checkpoint(startedAt("2026-11-02T10:00:00.000Z"));
  now = 10;
  await checkpointer.checkpoint(startedAt("2026-11-02T10:00:00.000Z"));
  assertEquals(commitLog.calls(), 1);
  await checkpointer.checkpoint(startedAt("2026-11-02T10:00:05.000Z"));
  assertEquals(commitLog.calls(), 2);
  await checkpointer.close();
});

Deno.test("WorkflowRunCheckpointer: a step start whose checkpoint fails still resolves, and the run goes on (swamp-club#4295)", async () => {
  let failing = false;
  const commitLog = engine(() =>
    failing
      ? Promise.reject(new Error("the commit store is down"))
      : Promise.resolve("committed")
  );
  let now = 0;
  const checkpointer = new WorkflowRunCheckpointer({ commitLog }, {
    intervalMs: 60_000,
    now: () => now,
  });
  const run = newRun();
  run.start();
  run.jobs[0].start();
  await checkpointer.checkpoint(run);
  now = 10;
  failing = true;
  run.jobs[0].steps[0].start();
  await checkpointer.checkpoint(run);
  assertEquals(commitLog.calls(), 2);
  await checkpointer.close();
});

Deno.test("WorkflowRunCheckpointer: a step that ends while a sibling runs checkpoints at once; one that ends alone stays paced (swamp-club#4295)", async () => {
  const commitLog = engine(() => Promise.resolve("committed"));
  let now = 0;
  const checkpointer = new WorkflowRunCheckpointer({ commitLog }, {
    intervalMs: 60_000,
    now: () => now,
  });
  const run = twoStepRun();
  run.start();
  run.jobs[0].start();
  run.jobs[0].steps[0].start();
  run.jobs[0].steps[1].start();
  await checkpointer.checkpoint(run);
  assertEquals(commitLog.calls(), 1);
  now = 10;
  run.jobs[0].steps[0].succeed();
  await checkpointer.checkpoint(run);
  assertEquals(commitLog.calls(), 2);
  assertEquals(checkpointer.committedUnknownSteps(run.id), ["b"]);
  run.jobs[0].steps[1].succeed();
  await checkpointer.checkpoint(run);
  assertEquals(commitLog.calls(), 2);
  await checkpointer.close();
});

interface Appended {
  readonly kind: string;
  readonly bytes: number;
}

/** an engine that takes direct appends, recording each attempt's intent and size */
function journalEngine(
  answer: (change: TypedChange) => Promise<OpenUnitAppend>,
): CommitLogEngine & {
  readonly calls: () => number;
  readonly appended: Appended[];
} {
  const base = engine(() => Promise.resolve("committed"));
  const appended: Appended[] = [];
  return {
    ...base,
    appendToOpenUnit: async (changes) => {
      const [change] = changes;
      const put = "put" in change ? change.put : undefined;
      appended.push({
        kind: put?.intent.kind ?? "op",
        bytes: put?.content instanceof Uint8Array ? put.content.length : -1,
      });
      return await answer(change);
    },
    appended,
  };
}

async function withRunRepo(
  fn: (repo: YamlWorkflowRunRepository) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-journal-" });
  try {
    await fn(new YamlWorkflowRunRepository(dir));
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

function manyStepRun(steps: number): WorkflowRun {
  return WorkflowRun.create(Workflow.create({
    name: "flow",
    jobs: [Job.create({
      name: "main",
      steps: Array.from({ length: steps }, (_, i) =>
        Step.create({
          name: `step-${i}`,
          task: StepTask.model("writer", "write", {}),
        })),
    })],
  }));
}

Deno.test("WorkflowRunCheckpointer: with a journal, a run's move into running appends its record and each step start appends only its StepStart, with no whole-record checkpoint", async () => {
  await withRunRepo(async (workflowRunRepo) => {
    const commitLog = journalEngine(() => Promise.resolve("committed"));
    const checkpointer = new WorkflowRunCheckpointer(
      { commitLog, workflowRunRepo },
      { intervalMs: 60_000, now: () => 0 },
    );
    const run = twoStepRun();
    run.start();
    await workflowRunRepo.save(createWorkflowId(run.workflowId), run);
    await checkpointer.checkpoint(run);
    run.jobs[0].start();
    run.jobs[0].steps[0].start();
    await checkpointer.checkpoint(run);
    run.jobs[0].steps[0].succeed();
    run.jobs[0].steps[1].start();
    await checkpointer.checkpoint(run);
    assertEquals(commitLog.appended.map((a) => a.kind), [
      "run.update",
      "run-start.save",
      "run-start.save",
    ]);
    // the first save of the run committed nothing else at once
    assertEquals(commitLog.calls(), 1);
    assertEquals(
      new Set(checkpointer.committedUnknownSteps(run.id)),
      new Set(["a", "b"]),
    );
    await checkpointer.close();
  });
});

Deno.test("WorkflowRunCheckpointer: a step start appends the same bytes whatever the size of the run's record", async () => {
  await withRunRepo(async (workflowRunRepo) => {
    const sizes: number[] = [];
    for (const steps of [1, 2_000]) {
      const commitLog = journalEngine(() => Promise.resolve("committed"));
      const checkpointer = new WorkflowRunCheckpointer(
        { commitLog, workflowRunRepo },
        { intervalMs: 60_000, now: () => 0 },
      );
      const run = manyStepRun(steps);
      run.start();
      await workflowRunRepo.save(createWorkflowId(run.workflowId), run);
      await checkpointer.checkpoint(run);
      run.jobs[0].start();
      run.jobs[0].steps[0].start();
      await checkpointer.checkpoint(run);
      const start = commitLog.appended.find((a) => a.kind === "run-start.save");
      sizes.push(start!.bytes);
      await checkpointer.close();
    }
    assertEquals(sizes[0], sizes[1]);
  });
});

Deno.test("WorkflowRunCheckpointer: a start that could not be committed rejects with the coded error and is appended again at the next save", async () => {
  await withRunRepo(async (workflowRunRepo) => {
    let failStarts = true;
    const commitLog = journalEngine((change) => {
      const kind = "put" in change ? change.put.intent.kind : "";
      if (failStarts && kind === "run-start.save") {
        return Promise.reject(
          new AppendUnrecordedError(new Error("serve is down"), false),
        );
      }
      return Promise.resolve("committed");
    });
    const checkpointer = new WorkflowRunCheckpointer(
      { commitLog, workflowRunRepo },
      { intervalMs: 60_000, now: () => 0 },
    );
    const run = twoStepRun();
    run.start();
    await workflowRunRepo.save(createWorkflowId(run.workflowId), run);
    await checkpointer.checkpoint(run);
    run.jobs[0].start();
    run.jobs[0].steps[0].start();
    const error = await assertRejects(
      () => checkpointer.checkpoint(run),
      StepStartUnrecordedError,
    );
    assertEquals(error.code, COMMIT_UNREACHABLE_CODE);
    assertEquals(error.start.stepName, "a");
    assertEquals(error.start.jobName, "main");
    failStarts = false;
    await checkpointer.checkpoint(run);
    assertEquals(
      commitLog.appended.filter((a) => a.kind === "run-start.save").length,
      2,
    );
    await checkpointer.close();
  });
});

Deno.test("WorkflowRunCheckpointer: a run whose move into running could not be committed rejects before any step starts", async () => {
  await withRunRepo(async (workflowRunRepo) => {
    const commitLog = journalEngine(() =>
      Promise.reject(new AppendUnrecordedError(new Error("refused"), true))
    );
    const checkpointer = new WorkflowRunCheckpointer(
      { commitLog, workflowRunRepo },
      { intervalMs: 60_000, now: () => 0 },
    );
    const run = twoStepRun();
    run.start();
    await workflowRunRepo.save(createWorkflowId(run.workflowId), run);
    const error = await assertRejects(
      () => checkpointer.checkpoint(run),
      StepStartUnrecordedError,
    );
    assertEquals(error.start.stepName, undefined);
    await checkpointer.close();
  });
});

function forbidden(): AppendUnrecordedError {
  return new AppendUnrecordedError(
    Object.assign(new Error("it changes a waiting approval gate's start"), {
      code: "forbidden",
    }),
    true,
  );
}

Deno.test("WorkflowRunCheckpointer: a run record the datastore refuses rejects with the refusal's code, not unreachable (swamp-club#4368)", async () => {
  await withRunRepo(async (workflowRunRepo) => {
    const commitLog = journalEngine(() => Promise.reject(forbidden()));
    const checkpointer = new WorkflowRunCheckpointer(
      { commitLog, workflowRunRepo },
      { intervalMs: 60_000, now: () => 0 },
    );
    const run = twoStepRun();
    run.start();
    await workflowRunRepo.save(createWorkflowId(run.workflowId), run);
    const error = await assertRejects(
      () => checkpointer.checkpoint(run),
      StepStartUnrecordedError,
    );
    assertEquals(error.code, "forbidden");
    assertEquals(error.start.stepName, undefined);
    assertEquals(error.message.includes("reachable"), false, error.message);
    await checkpointer.close();
  });
});

Deno.test("WorkflowRunCheckpointer: a step start the datastore refuses rejects with the refusal's code, not unreachable (swamp-club#4368)", async () => {
  await withRunRepo(async (workflowRunRepo) => {
    const commitLog = journalEngine((change) => {
      const kind = "put" in change ? change.put.intent.kind : "";
      return kind === "run-start.save"
        ? Promise.reject(forbidden())
        : Promise.resolve("committed");
    });
    const checkpointer = new WorkflowRunCheckpointer(
      { commitLog, workflowRunRepo },
      { intervalMs: 60_000, now: () => 0 },
    );
    const run = twoStepRun();
    run.start();
    await workflowRunRepo.save(createWorkflowId(run.workflowId), run);
    await checkpointer.checkpoint(run);
    run.jobs[0].start();
    run.jobs[0].steps[0].start();
    const error = await assertRejects(
      () => checkpointer.checkpoint(run),
      StepStartUnrecordedError,
    );
    assertEquals(error.code, "forbidden");
    assertEquals(error.start.stepName, "a");
    assertEquals(error.message.includes("reachable"), false, error.message);
    await checkpointer.close();
  });
});

Deno.test("WorkflowRunCheckpointer: when serve takes no step starts, a start commits the whole record at once instead", async () => {
  await withRunRepo(async (workflowRunRepo) => {
    const commitLog = journalEngine((change) => {
      const kind = "put" in change ? change.put.intent.kind : "";
      return Promise.resolve(
        kind === "run-start.save" ? "unsupported" : "committed",
      );
    });
    const checkpointer = new WorkflowRunCheckpointer(
      { commitLog, workflowRunRepo },
      { intervalMs: 60_000, now: () => 0 },
    );
    const run = twoStepRun();
    run.start();
    await workflowRunRepo.save(createWorkflowId(run.workflowId), run);
    await checkpointer.checkpoint(run);
    assertEquals(commitLog.calls(), 1);
    run.jobs[0].start();
    run.jobs[0].steps[0].start();
    await checkpointer.checkpoint(run);
    assertEquals(commitLog.calls(), 2);
    run.jobs[0].steps[0].succeed();
    run.jobs[0].steps[1].start();
    await checkpointer.checkpoint(run);
    assertEquals(commitLog.calls(), 3);
    // after serve first answers it takes no starts, no other start is tried
    assertEquals(
      commitLog.appended.filter((a) => a.kind === "run-start.save").length,
      1,
    );
    await checkpointer.close();
  });
});

Deno.test("WorkflowRunCheckpointer: with a journal, a step that ends while a sibling runs stays paced", async () => {
  await withRunRepo(async (workflowRunRepo) => {
    const commitLog = journalEngine(() => Promise.resolve("committed"));
    const checkpointer = new WorkflowRunCheckpointer(
      { commitLog, workflowRunRepo },
      { intervalMs: 60_000, now: () => 0 },
    );
    const run = twoStepRun();
    run.start();
    await workflowRunRepo.save(createWorkflowId(run.workflowId), run);
    await checkpointer.checkpoint(run);
    run.jobs[0].start();
    run.jobs[0].steps[0].start();
    run.jobs[0].steps[1].start();
    await checkpointer.checkpoint(run);
    const before = commitLog.calls();
    run.jobs[0].steps[0].succeed();
    await checkpointer.checkpoint(run);
    assertEquals(commitLog.calls(), before);
    await checkpointer.close();
  });
});

Deno.test("WorkflowRunCheckpointer.committedLatest: true only once a checkpoint covers the run's latest save", async () => {
  let fail = false;
  const commitLog = engine(() =>
    fail ? Promise.reject(new Error("down")) : Promise.resolve("committed")
  );
  const checkpointer = new WorkflowRunCheckpointer({ commitLog }, {
    intervalMs: 0,
  });
  const run = newRun();
  await checkpointer.checkpoint(run);
  assertEquals(checkpointer.committedLatest(run.id), true);
  fail = true;
  run.start();
  await checkpointer.checkpoint(run);
  assertEquals(checkpointer.committedLatest(run.id), false);
  await checkpointer.close();
});
