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
 * Integration tests for retrying a failed run: `workflow resume` without
 * `--from` (swamp-club#2409).
 *
 * The first half drives a run to failure on real YAML repositories and a
 * real run tracker, reloads the run through fresh repository instances, and
 * retries it with a counting step executor. The second half retries through
 * both branches of the serve handler against a real repository, where a
 * shell step's exit code comes from an input the retry overrides.
 */

import { join } from "@std/path";
import { hostname } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { assertEquals, assertRejects } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import type { WorkflowRunEvent } from "../src/libswamp/mod.ts";
import {
  type StepExecutionContext,
  type StepExecutor,
  WorkflowExecutionService,
} from "../src/domain/workflows/execution_service.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../src/domain/workflows/workflow_id.ts";
import type { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "../src/infrastructure/persistence/yaml_workflow_run_repository.ts";
import { RunTrackerStore } from "../src/infrastructure/persistence/run_tracker_store.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../src/infrastructure/persistence/paths.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { executeWorkflowWithLocks } from "../src/serve/deps.ts";
import { handleWorkflowResume } from "../src/serve/handlers/workflow_handlers.ts";
import { ActiveRunRegistry } from "../src/serve/active_run_registry.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import type { ServeAuthConfig } from "../src/domain/access/serve_auth_config.ts";

// Import models barrel to trigger built-in registration.
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

async function withRepo(fn: (repoDir: string) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-resume-failed-" });
  try {
    await Deno.writeTextFile(
      join(repoDir, ".swamp.yaml"),
      "swampVersion: 0.0.0\ninitializedAt: 2026-01-01T00:00:00.000Z\n",
    );
    await fn(repoDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

// ── Execution service on real repositories ──────────────────────────────

interface TrackerRow {
  status: string;
  pid: number;
  hostname: string;
}

/**
 * Counts calls per `job/step`, fails the steps named in `failing`, and
 * records the tracker row as each step runs.
 */
class CountingStepExecutor implements StepExecutor {
  readonly calls = new Map<string, number>();
  readonly failing = new Set<string>();
  readonly trackerRows: TrackerRow[] = [];

  constructor(private readonly tracker: RunTrackerStore) {}

  execute(_step: Step, ctx: StepExecutionContext): Promise<unknown> {
    const key = `${ctx.jobName}/${ctx.stepName}`;
    const attempt = (this.calls.get(key) ?? 0) + 1;
    this.calls.set(key, attempt);
    const row = this.tracker.findById(ctx.workflowRunId);
    if (row) {
      this.trackerRows.push({
        status: row.status,
        pid: row.pid,
        hostname: row.hostname,
      });
    }
    if (this.failing.has(ctx.stepName)) {
      return Promise.reject(new Error(`${ctx.stepName} failed`));
    }
    return Promise.resolve({ step: ctx.stepName, attempt });
  }

  count(key: string): number {
    return this.calls.get(key) ?? 0;
  }
}

/**
 * build: compile → package; deploy depends on build; docs is independent.
 * package reads an input, so a string override fails evaluation.
 */
function pipelineWorkflow(): Workflow {
  return Workflow.create({
    name: "retry-pipeline",
    jobs: [
      Job.create({
        name: "build",
        steps: [
          Step.create({
            name: "compile",
            task: StepTask.model("test-model", "run"),
          }),
          Step.create({
            name: "package",
            task: StepTask.model("test-model", "run", {
              version: "${{ inputs.build + 1 }}",
            }),
            dependsOn: [{
              step: "compile",
              condition: TriggerCondition.succeeded(),
            }],
          }),
        ],
      }),
      Job.create({
        name: "deploy",
        dependsOn: [{ job: "build", condition: TriggerCondition.succeeded() }],
        steps: [
          Step.create({
            name: "push",
            task: StepTask.model("test-model", "run"),
          }),
        ],
      }),
      Job.create({
        name: "docs",
        steps: [
          Step.create({
            name: "publish",
            task: StepTask.model("test-model", "run"),
          }),
        ],
      }),
    ],
  });
}

/** A service over fresh repository instances, as a new process would have. */
function freshService(
  repoDir: string,
  executor: StepExecutor,
  tracker: RunTrackerStore,
  catalogStore: CatalogStore,
): { service: WorkflowExecutionService; runRepo: YamlWorkflowRunRepository } {
  const runRepo = new YamlWorkflowRunRepository(repoDir);
  const service = new WorkflowExecutionService(
    new YamlWorkflowRepository(repoDir),
    runRepo,
    repoDir,
    executor,
    undefined,
    catalogStore,
    undefined,
    undefined,
    undefined,
    undefined,
    tracker,
  );
  return { service, runRepo };
}

async function failPipeline(repoDir: string) {
  const workflow = pipelineWorkflow();
  await new YamlWorkflowRepository(repoDir).save(workflow);
  const tracker = RunTrackerStore.fromSwampDir(swampPath(repoDir));
  const catalogStore = new CatalogStore(join(repoDir, "_catalog.db"));
  const executor = new CountingStepExecutor(tracker);
  executor.failing.add("compile");
  const { service } = freshService(repoDir, executor, tracker, catalogStore);
  const failed = await service.execute(workflow.name, { inputs: { build: 1 } });
  assertEquals(failed.status, "failed");
  return { workflow, tracker, catalogStore, executor, failed };
}

/** Hands the tracker row to a dead process on another host. */
function orphanTrackerRow(repoDir: string, runId: string): void {
  const db = new DatabaseSync(join(swampPath(repoDir), "run_tracker.db"));
  try {
    db.prepare(
      "UPDATE active_runs SET pid = 2147483647, hostname = 'old-host' WHERE id = ?",
    ).run(runId);
  } finally {
    db.close();
  }
}

async function drainResume(
  service: WorkflowExecutionService,
  workflowName: string,
  runId: string,
  inputs?: Record<string, unknown>,
): Promise<WorkflowRun | undefined> {
  let completed: WorkflowRun | undefined;
  for await (const event of service.resume(workflowName, runId, { inputs })) {
    if (event.kind === "completed") completed = event.run;
  }
  return completed;
}

Deno.test("retry: a reloaded failed run resumes without --from and re-runs only what failed", async () => {
  await withRepo(async (repoDir) => {
    const { workflow, tracker, catalogStore, executor, failed } =
      await failPipeline(repoDir);
    try {
      assertEquals(tracker.findById(failed.id)?.status, "failed");
      orphanTrackerRow(repoDir, failed.id);
      const publishBefore = failed.getJob("docs")!.getStep("publish")!
        .toData();

      executor.failing.clear();
      executor.trackerRows.length = 0;
      const { service, runRepo } = freshService(
        repoDir,
        executor,
        tracker,
        catalogStore,
      );
      const retried = await drainResume(service, workflow.name, failed.id);

      assertEquals(retried?.id, failed.id);
      assertEquals(retried?.status, "succeeded");
      assertEquals(executor.count("build/compile"), 2);
      assertEquals(executor.count("build/package"), 1);
      assertEquals(executor.count("deploy/push"), 1);
      assertEquals(executor.count("docs/publish"), 1);

      // The tracker row followed the resuming process while steps ran.
      for (const row of executor.trackerRows) {
        assertEquals(row, {
          status: "running",
          pid: Deno.pid,
          hostname: hostname(),
        });
      }
      assertEquals(tracker.findById(failed.id)?.status, "completed");

      const reloaded = await new YamlWorkflowRunRepository(repoDir).findById(
        createWorkflowId(workflow.id),
        createWorkflowRunId(failed.id),
      );
      assertEquals(reloaded?.status, "succeeded");
      assertEquals(
        reloaded?.startedAt?.toISOString(),
        failed.startedAt?.toISOString(),
      );
      assertEquals(
        reloaded?.getJob("docs")?.getStep("publish")?.toData(),
        publishBefore,
      );
      assertEquals(
        (await runRepo.findAllByWorkflowId(createWorkflowId(workflow.id)))
          .length,
        1,
      );
    } finally {
      tracker.close();
      catalogStore.close();
    }
  });
});

Deno.test("retry: an evaluation failure after the early save leaves the reloaded run failed", async () => {
  await withRepo(async (repoDir) => {
    const { workflow, tracker, catalogStore, executor, failed } =
      await failPipeline(repoDir);
    try {
      const repo = new YamlWorkflowRunRepository(repoDir);
      const before = (await repo.findById(
        createWorkflowId(workflow.id),
        createWorkflowRunId(failed.id),
      ))!.toData();

      executor.failing.clear();
      const { service } = freshService(
        repoDir,
        executor,
        tracker,
        catalogStore,
      );
      await assertRejects(
        () => drainResume(service, workflow.name, failed.id, { build: "x" }),
        Error,
        "no such overload",
      );

      const reloaded = await new YamlWorkflowRunRepository(repoDir).findById(
        createWorkflowId(workflow.id),
        createWorkflowRunId(failed.id),
      );
      assertEquals(reloaded?.status, "failed");
      assertEquals(reloaded?.toData(), before);
      assertEquals(executor.count("build/compile"), 1);
    } finally {
      tracker.close();
      catalogStore.close();
    }
  });
});

// ── Serve handler branches on a real repository ─────────────────────────

const modeNone: ServeAuthConfig = {
  mode: "none",
  admins: [],
  allowedCollectives: [],
  allowedUsers: [],
  oauthProvider: "",
  groupsField: "",
  restrictedModelTypes: [],
  restrictedCommands: [],
  approveRequiresExplicitGrant: false,
};

/** A step that passes, then a shell step that exits with `inputs.code`. */
function exitCodeWorkflow(name: string): Workflow {
  return Workflow.create({
    name,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "prepare",
            task: StepTask.directExecution(
              "command/shell",
              `${name}-prepare`,
              "execute",
              { run: "echo prepared" },
            ),
          }),
          Step.create({
            name: "check",
            task: StepTask.directExecution(
              "command/shell",
              `${name}-check`,
              "execute",
              { run: "exit ${{ inputs.code }}" },
            ),
            dependsOn: [{
              step: "prepare",
              condition: TriggerCondition.succeeded(),
            }],
          }),
        ],
      }),
    ],
  });
}

interface MockSocket {
  sent: string[];
  readyState: number;
  send(data: string): void;
}

async function failOverServe(
  repoDir: string,
  workflow: Workflow,
  withRegistry: boolean,
): Promise<{ ctx: ConnectionContext; runId: string }> {
  await new YamlWorkflowRepository(repoDir).save(workflow);
  const { repoDir: resolved, repoContext, datastoreConfig, syncService } =
    await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });

  let runId: string | undefined;
  await executeWorkflowWithLocks(
    resolved,
    repoContext,
    datastoreConfig,
    { workflowIdOrName: workflow.name, inputs: { code: 1 } },
    new AbortController().signal,
    (event: WorkflowRunEvent) => {
      if (event.kind === "started") runId = event.runId;
    },
    syncService,
  );
  if (!runId) throw new Error("no run id observed");

  const ctx = {
    repoDir: resolved,
    repoContext,
    datastoreConfig,
    authConfig: modeNone,
    activeRunRegistry: withRegistry ? new ActiveRunRegistry() : undefined,
  } as ConnectionContext;
  const run = await stepStatuses(ctx, workflow, runId);
  assertEquals(run, {
    status: "failed",
    check: "failed",
    prepare: "succeeded",
  });
  return { ctx, runId };
}

async function stepStatuses(
  ctx: ConnectionContext,
  workflow: Workflow,
  runId: string,
): Promise<{ status?: string; prepare?: string; check?: string }> {
  const run = await ctx.repoContext.workflowRunRepo.findById(
    createWorkflowId(workflow.id),
    createWorkflowRunId(runId),
  );
  const job = run?.getJob("main");
  return {
    status: run?.status,
    prepare: job?.getStep("prepare")?.status,
    check: job?.getStep("check")?.status,
  };
}

/** How many times `text` appears in the run's log. */
async function countInRunLog(
  ctx: ConnectionContext,
  workflow: Workflow,
  runId: string,
  text: string,
): Promise<number> {
  const log = await Deno.readTextFile(
    join(
      swampPath(ctx.repoDir, SWAMP_SUBDIRS.workflowRuns),
      workflow.id,
      `workflow-run-${runId}.log`,
    ),
  );
  return log.split(text).length - 1;
}

for (const withRegistry of [false, true]) {
  for (const from of [undefined, "check"]) {
    const branch = withRegistry ? "registry" : "no-registry";
    const mode = from ? "explicit --from" : "automatic";
    Deno.test({
      name: `retry: serve ${branch} branch retries a failed run (${mode})`,
      sanitizeOps: false,
      sanitizeResources: false,
      fn: async () => {
        await withRepo(async (repoDir) => {
          const workflow = exitCodeWorkflow(
            `retry-serve-${branch}-${from ? "from" : "auto"}`,
          );
          const { ctx, runId } = await failOverServe(
            repoDir,
            workflow,
            withRegistry,
          );
          const socket: MockSocket = {
            sent: [],
            readyState: WebSocket.OPEN,
            send(data: string) {
              this.sent.push(data);
            },
          };

          await handleWorkflowResume(
            socket as unknown as WebSocket,
            ctx,
            "resume-1",
            {
              workflowIdOrName: workflow.name,
              runId,
              from,
              inputs: { code: 0 },
            },
            new AbortController(),
            null,
          );

          const frames = socket.sent.map((s) => JSON.parse(s));
          assertEquals(
            frames.some((f) => f.type === "error"),
            false,
            JSON.stringify(frames.filter((f) => f.type === "error")),
          );
          await waitFor(
            async () =>
              (await stepStatuses(ctx, workflow, runId)).status ===
                "succeeded",
            "retried run succeeds",
          );
          assertEquals(await stepStatuses(ctx, workflow, runId), {
            status: "succeeded",
            prepare: "succeeded",
            check: "succeeded",
          });
          // prepare succeeded the first time and is not a dependent of check.
          assertEquals(
            await countInRunLog(ctx, workflow, runId, "prepared"),
            1,
          );
          if (ctx.activeRunRegistry) {
            await waitFor(
              () => ctx.activeRunRegistry!.get(runId) === undefined,
              "run deregistered",
            );
          }
        });
      },
    });
  }
}
