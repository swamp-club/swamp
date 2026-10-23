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
 * Run search and run summary over real repositories on a temp directory,
 * with a second set of repositories on the same directories standing in for
 * another process (swamp-club#3443). That is the shape of the local
 * dashboard child, which serves reads from one long-lived process while the
 * CLI writes runs: whatever the writer does, the reader's cached run index
 * snapshots must follow it.
 */

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { basename, dirname, join } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { trace } from "@opentelemetry/api";
import { waitFor } from "@swamp-club/swamp-testing";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../src/domain/workflows/workflow_id.ts";
import {
  getIndexPath,
  readRunIndex,
  withIndexQueue,
} from "../src/infrastructure/persistence/workflow_run_index.ts";
import { withCapturedSpans } from "../src/infrastructure/tracing/span_test_helpers.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "../src/infrastructure/persistence/yaml_workflow_run_repository.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { collect } from "../src/libswamp/testing.ts";
import {
  createWorkflowApprovalsDeps,
  workflowApprovals,
} from "../src/libswamp/workflows/approvals.ts";
import {
  workflowRunSearch,
  type WorkflowRunSearchDeps,
  type WorkflowRunSearchEvent,
  type WorkflowRunSearchInput,
} from "../src/libswamp/workflows/run_search.ts";
import {
  workflowRunSummary,
  type WorkflowRunSummaryData,
  type WorkflowRunSummaryEvent,
} from "../src/libswamp/workflows/run_summary.ts";
import type { RunIndexSnapshot } from "../src/domain/workflows/run_index_snapshot.ts";
import { RunIndexWarmup } from "../src/serve/run_index_warmup.ts";
import { RUN_INDEX_CACHE_MAX_RUNS } from "../src/infrastructure/persistence/run_index_cache.ts";
import "../src/domain/models/models.ts";

async function withRepoDir(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "swamp-run-index-cache-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

function workflowNamed(name: string): Workflow {
  return Workflow.create({
    name,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "step",
            task: StepTask.model("test-model", "run"),
          }),
        ],
      }),
    ],
  });
}

/**
 * One process's view of the repository. Its run index cache judges file
 * times by a clock a minute ahead: `settle` sets mtimes back, but
 * `Deno.utime` moves ctimes to now, and a recent ctime is not trusted
 * (swamp-club#3467).
 */
function processOn(dir: string) {
  const workflowRepo = new YamlWorkflowRepository(dir);
  const runRepo = new YamlWorkflowRunRepository(
    dir,
    undefined,
    undefined,
    undefined,
    () => Date.now() + 60_000,
  );
  const deps: WorkflowRunSearchDeps = {
    findAllWorkflows: () => workflowRepo.findAllListings(),
    runIndexOf: (id) => runRepo.runIndexSnapshot(createWorkflowId(id)),
  };
  return {
    workflowRepo,
    runRepo,
    async search(input: WorkflowRunSearchInput) {
      for await (
        const event of workflowRunSearch(createLibSwampContext(), deps, input)
      ) {
        if (event.kind === "completed") {
          return event as Extract<
            WorkflowRunSearchEvent,
            { kind: "completed" }
          >;
        }
      }
      throw new Error("run search did not complete");
    },
    async summary(): Promise<WorkflowRunSummaryData> {
      for await (
        const event of workflowRunSummary(createLibSwampContext(), deps, {})
      ) {
        if (event.kind === "completed") {
          return (event as Extract<
            WorkflowRunSummaryEvent,
            { kind: "completed" }
          >).data;
        }
      }
      throw new Error("run summary did not complete");
    },
  };
}

/**
 * Sets a workflow's run index file and records directory back a minute, so
 * the reader's next snapshot of it is kept.
 */
async function settle(dir: string, workflow: Workflow) {
  const runsDir = join(dir, ".swamp", "workflow-runs", workflow.id);
  const when = new Date(Date.now() - 60_000);
  await Deno.utime(getIndexPath(runsDir), when, when);
  await Deno.utime(runsDir, when, when);
}

async function startRun(
  repo: YamlWorkflowRunRepository,
  workflow: Workflow,
): Promise<WorkflowRun> {
  const run = WorkflowRun.create(workflow);
  run.start();
  await repo.save(workflow.id, run);
  return run;
}

Deno.test("run index cache: the reader follows runs another process saves, updates and adds", async () => {
  await withRepoDir(async (dir) => {
    const writer = processOn(dir);
    const reader = processOn(dir);
    const deploy = workflowNamed("deploy");
    const other = workflowNamed("other");
    await writer.workflowRepo.save(deploy);
    await writer.workflowRepo.save(other);
    const first = await startRun(writer.runRepo, deploy);
    await startRun(writer.runRepo, other);
    await settle(dir, deploy);
    await settle(dir, other);

    const before = await reader.search({ workflow: "deploy", limit: 20 });
    assertEquals(before.data.results.map((r) => r.runId), [first.id]);
    assertEquals(before.total, 1);
    assertEquals((await reader.summary()).totals.running, 2);

    // Same record count: only the index changes.
    first.interruptOrphaned("test");
    await writer.runRepo.save(deploy.id, first);
    assertEquals(
      (await reader.search({ workflow: "deploy" })).data.results[0].status,
      "interrupted",
    );
    await settle(dir, deploy);
    assertEquals((await reader.summary()).totals.failed, 1);

    // A new record.
    const second = await startRun(writer.runRepo, deploy);
    const after = await reader.search({ workflow: "deploy", limit: 20 });
    assertEquals(after.total, 2);
    assertEquals(after.data.results[0].runId, second.id);
    assertEquals((await reader.summary()).totals.runs, 3);
  });
});

Deno.test({
  name:
    "run index cache: a record edited in place is seen while the index cannot be repaired",
  ignore: Deno.build.os === "windows" || Deno.uid() === 0,
  fn: async () => {
    await withRepoDir(async (dir) => {
      const writer = processOn(dir);
      const reader = processOn(dir);
      const deploy = workflowNamed("deploy");
      await writer.workflowRepo.save(deploy);
      const edited = await startRun(writer.runRepo, deploy);
      const other = await startRun(writer.runRepo, deploy);
      const runsDir = join(dir, ".swamp", "workflow-runs", deploy.id);
      // A record the index does not list, added where the reader cannot
      // write its repaired index (swamp-club#3467).
      const extra = crypto.randomUUID();
      const otherText = await Deno.readTextFile(
        join(runsDir, `workflow-run-${other.id}.yaml`),
      );
      await Deno.writeTextFile(
        join(runsDir, `workflow-run-${extra}.yaml`),
        otherText.replaceAll(other.id, extra),
      );
      await Deno.chmod(runsDir, 0o555);
      try {
        assertEquals(
          (await reader.search({ workflow: "deploy", limit: 20 })).total,
          3,
        );

        const path = join(runsDir, `workflow-run-${edited.id}.yaml`);
        const text = await Deno.readTextFile(path);
        await Deno.writeTextFile(
          path,
          text.replace("status: running", "status: failed"),
        );
        const found = await reader.search({
          workflow: "deploy",
          query: edited.id,
        });
        assertEquals(found.data.results[0].status, "failed");
      } finally {
        await Deno.chmod(runsDir, 0o755);
      }
    });
  },
});

Deno.test("run index cache: a full run id finds its run, and paging reports the total", async () => {
  await withRepoDir(async (dir) => {
    const writer = processOn(dir);
    const reader = processOn(dir);
    const deploy = workflowNamed("deploy");
    await writer.workflowRepo.save(deploy);
    const runs: WorkflowRun[] = [];
    for (let i = 0; i < 5; i++) {
      runs.push(await startRun(writer.runRepo, deploy));
    }
    await settle(dir, deploy);

    const target = runs[2];
    const found = await reader.search({
      workflow: "deploy",
      query: target.id.toUpperCase(),
      limit: 1,
    });
    assertEquals(found.data.results.map((r) => r.runId), [target.id]);
    assertEquals(found.total, 1);

    const page = await reader.search({ offset: 1, limit: 2 });
    assertEquals(page.total, 5);
    assertEquals(page.data.results.length, 2);
  });
});

Deno.test("run index cache: deleting a workflow's runs empties its results", async () => {
  await withRepoDir(async (dir) => {
    const writer = processOn(dir);
    const reader = processOn(dir);
    const deploy = workflowNamed("deploy");
    await writer.workflowRepo.save(deploy);
    await startRun(writer.runRepo, deploy);
    await settle(dir, deploy);
    assertEquals((await reader.search({})).total, 1);

    await writer.runRepo.deleteAllByWorkflowId(deploy.id);
    assertEquals((await reader.search({})).total, 0);
    assertEquals((await reader.summary()).totals.runs, 0);
  });
});

Deno.test("run index cache: renamed and deleted workflows are seen through the workflow listings", async () => {
  await withRepoDir(async (dir) => {
    const writer = processOn(dir);
    const reader = processOn(dir);
    const deploy = workflowNamed("deploy");
    const doomed = workflowNamed("doomed");
    await writer.workflowRepo.save(deploy);
    await writer.workflowRepo.save(doomed);
    const oldRun = await startRun(writer.runRepo, deploy);
    await startRun(writer.runRepo, doomed);
    await settle(dir, deploy);
    await settle(dir, doomed);
    assertEquals((await reader.search({})).total, 2);

    // Renamed: runs keep the name they recorded.
    const renamed = Workflow.fromData({ ...deploy.toData(), name: "shipped" });
    await writer.workflowRepo.delete(deploy.id, deploy.name);
    await writer.workflowRepo.save(renamed);
    const newRun = await startRun(writer.runRepo, renamed);
    assertEquals(
      (await reader.search({ workflow: "deploy" })).data.results.map((r) =>
        r.runId
      ),
      [oldRun.id],
    );
    assertEquals(
      (await reader.search({ workflows: ["shipped"] })).data.results.map((r) =>
        r.runId
      ),
      [newRun.id],
    );

    // Deleted: its runs are no longer listed.
    await writer.workflowRepo.delete(doomed.id, doomed.name);
    const remaining = await reader.search({});
    assertEquals(remaining.total, 2);
    assertEquals(
      remaining.data.results.every((r) => r.workflowId === deploy.id),
      true,
    );
  });
});

Deno.test("run index cache: the serve warm-up leaves each snapshot cached for the first request", async () => {
  await withRepoDir(async (dir) => {
    const writer = processOn(dir);
    const workflows = [workflowNamed("alpha"), workflowNamed("beta")];
    for (const workflow of workflows) {
      await writer.workflowRepo.save(workflow);
      await startRun(writer.runRepo, workflow);
      await settle(dir, workflow);
    }

    const serve = processOn(dir);
    const warmed = new Map<string, RunIndexSnapshot>();
    const warmup = new RunIndexWarmup({
      listWorkflowIds: async () =>
        (await serve.workflowRepo.findAllListings()).map((w) => w.id),
      countRunRecords: (id, signal) =>
        serve.runRepo.countRunRecords(createWorkflowId(id), signal),
      maxRuns: RUN_INDEX_CACHE_MAX_RUNS,
      warm: async (id) => {
        warmed.set(
          id,
          await serve.runRepo.runIndexSnapshot(createWorkflowId(id)),
        );
      },
    });
    warmup.start();
    // A request that arrives during the warm-up shares its loads.
    const during = await serve.search({});
    // Waited on, not disposed: a stopped warm-up lets go of the load in
    // flight rather than waiting for it (swamp-club#3468).
    await warmup.finished();

    assertEquals(during.total, 2);
    assertEquals(warmed.size, 2);
    for (const workflow of workflows) {
      assertStrictEquals(
        await serve.runRepo.runIndexSnapshot(workflow.id),
        warmed.get(workflow.id),
      );
    }
  });
});

// The requests a dashboard issues together, over the same long-lived repo.
// A queued cohort validates once after every member's observation; readers
// arriving during a scan share one subsequent pass, never its older result.
for (
  const scenario of ["queued", "rebuilding", "writer", "recent-stamp"] as const
) {
  Deno.test(`run index repair: concurrent search, summary and two approvals, ${scenario} (swamp-club#3857)`, async () => {
    await withRepoDir(async (dir) => {
      const workflowRepo = new YamlWorkflowRepository(dir);
      const runRepo = new YamlWorkflowRunRepository(
        dir,
        undefined,
        undefined,
        undefined,
        scenario === "recent-stamp" ? undefined : () => Date.now() + 60_000,
      );
      const workflow = workflowNamed(`cohort-${crypto.randomUUID()}`);
      await workflowRepo.save(workflow);
      const runs: WorkflowRun[] = [];
      for (let i = 0; i < 4; i++) runs.push(await startRun(runRepo, workflow));
      const runsDir = join(dir, ".swamp", "workflow-runs", workflow.id);
      const indexPath = getIndexPath(runsDir);
      const changedPath = runRepo.getPath(workflow.id, runs[0].id);
      await Deno.remove(indexPath);
      const deps = {
        findAllWorkflows: () => workflowRepo.findAllListings(),
        runIndexOf: (id: string) =>
          runRepo.runIndexSnapshot(createWorkflowId(id)),
      };
      const approvalDeps = createWorkflowApprovalsDeps(
        workflowRepo,
        runRepo,
        async (id) => {
          const suspended = await runRepo.findSummariesByStatus(
            id,
            "suspended",
          );
          const found = await Promise.all(
            suspended.map((s) =>
              runRepo.findById(id, createWorkflowRunId(s.id))
            ),
          );
          return found.filter((r): r is WorkflowRun => r !== null);
        },
      );
      const ctx = createLibSwampContext();
      const release = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const held = scenario === "queued"
        ? withIndexQueue(runsDir, () => release.promise)
        : Promise.resolve();
      const originalRead = Deno.readTextFile;
      const originalStat = Deno.stat;
      const originalRename = Deno.rename;
      const statsBySpan = new Map<string, number>();
      let indexReads = 0;
      let blocked = false;
      let writerApplied = false;
      const isRecord = (path: string | URL) =>
        dirname(String(path)) === runsDir &&
        /^workflow-run-.*\.yaml$/.test(basename(String(path)));
      Deno.readTextFile = async (...args: Parameters<typeof originalRead>) => {
        if (scenario !== "queued" && isRecord(args[0]) && !blocked) {
          blocked = true;
          entered.resolve();
          await release.promise;
        }
        try {
          return await originalRead(...args);
        } finally {
          if (String(args[0]) === indexPath) indexReads++;
        }
      };
      Deno.stat = async (...args: Parameters<typeof originalStat>) => {
        if (isRecord(args[0])) {
          const id = trace.getActiveSpan()?.spanContext().spanId ?? "none";
          statsBySpan.set(id, (statsBySpan.get(id) ?? 0) + 1);
        }
        return await originalStat(...args);
      };
      Deno.rename = async (...args: Parameters<typeof originalRename>) => {
        await originalRename(...args);
        if (
          scenario === "writer" && String(args[1]) === indexPath &&
          !writerApplied
        ) {
          writerApplied = true;
          // A foreign writer bypasses the process-local queue. Its index copy
          // has the same count and even the same contents, but the record moved.
          const staleIndex = await originalRead(indexPath);
          const record = parseYaml(await originalRead(changedPath)) as Record<
            string,
            unknown
          >;
          record.status = "interrupted";
          await Deno.writeTextFile(changedPath, stringifyYaml(record));
          const when = new Date("2030-01-01T00:00:00Z");
          await Deno.utime(changedPath, when, when);
          const temporary = join(runsDir, `.${crypto.randomUUID()}.tmp`);
          await Deno.writeTextFile(temporary, staleIndex);
          await originalRename(temporary, indexPath);
        }
      };
      const reading: Promise<unknown>[] = [];
      try {
        await withCapturedSpans(async (spans) => {
          const search = collect(workflowRunSearch(ctx, deps, {}));
          reading.push(search);
          if (scenario !== "queued") await entered.promise;
          const summary = collect(workflowRunSummary(ctx, deps, {}));
          const approvals = [
            collect(workflowApprovals(ctx, approvalDeps)),
            collect(workflowApprovals(ctx, approvalDeps)),
          ];
          reading.push(summary, ...approvals);
          // One initial index read per uncached consumer, plus the repair's
          // read once its queue is acquired. A settled snapshot shares search
          // and summary; the real clock may conservatively load both.
          const expectedReads = scenario === "queued"
            ? 3
            : scenario === "recent-stamp"
            ? 5
            : 4;
          await waitFor(
            () => Promise.resolve(indexReads >= expectedReads),
            "all readers to observe the invalid index",
          );
          release.resolve();
          const [searchEvents, summaryEvents, ...approvalEvents] = await Promise
            .all([search, summary, ...approvals]);
          const searched = searchEvents.find((e) => e.kind === "completed");
          const summarized = summaryEvents.find((e) => e.kind === "completed");
          assert(searched?.kind === "completed" && "total" in searched);
          assert(
            summarized?.kind === "completed" && "totals" in summarized.data,
          );
          assertEquals(searched.total, 4);
          assertEquals(summarized.data.totals.runs, 4);
          for (const events of approvalEvents) {
            const result = events.find((e) => e.kind === "completed");
            assert(result?.kind === "completed");
            assertEquals(result.data, { approvals: [], expired: [] });
          }
          const repairs = spans.filter((s) =>
            s.name === "swamp.workflow_runs.index.repair"
          );
          assertEquals(repairs.length, scenario === "queued" ? 1 : 2);
          assertEquals(
            spans.filter((s) => s.name === "swamp.workflow_runs.index.rebuild")
              .length,
            1,
          );
          const stats = repairs.map((s) =>
            statsBySpan.get(s.spanContext().spanId) ?? 0
          ).sort((a, b) => a - b);
          assertEquals(
            stats,
            scenario === "queued"
              ? [0]
              : scenario === "writer"
              ? [0, 7]
              : [0, 4],
          );
          assertEquals(
            repairs.reduce(
              (sum, s) =>
                sum + Number(s.attributes["workflow_runs.records_read"]),
              0,
            ),
            scenario === "writer" ? 1 : 0,
          );
          if (scenario === "writer") {
            assert(writerApplied);
            assertEquals(
              (await readRunIndex(runsDir))!.entries[runs[0].id].status,
              "interrupted",
            );
          }
        });
      } finally {
        release.resolve();
        await held;
        await Promise.allSettled(reading);
        Deno.readTextFile = originalRead;
        Deno.stat = originalStat;
        Deno.rename = originalRename;
      }
    });
  });
}
