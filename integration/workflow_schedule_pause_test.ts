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

// Pausing a workflow's schedule end to end (swamp-club#3522): the serve
// handlers and the libswamp operations write pauses to the control-plane
// store, and the scheduler reads them there at each fire.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { waitFor } from "@swamp-club/swamp-testing";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { createWorkflowId } from "../src/domain/workflows/workflow_id.ts";
import type { Definition } from "../src/domain/definitions/definition.ts";
import { FileSystemControlPlaneStore } from "../src/infrastructure/persistence/fs_control_plane_store.ts";
import { ControlPlaneSchedulePauseRepository } from "../src/infrastructure/persistence/control_plane_schedule_pause_repository.ts";
import { ExtensionWorkflowRepository } from "../src/infrastructure/persistence/extension_workflow_repository.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import {
  type ScheduledExecutionEvent,
  ScheduledExecutionService,
} from "../src/libswamp/workflows/scheduled_execution.ts";
import {
  createWorkflowScheduleDeps,
  workflowSchedulePause,
  type WorkflowSchedulePauseEvent,
} from "../src/libswamp/workflows/schedule.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { collect } from "../src/libswamp/testing.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import {
  createServeCtx,
  errorFrame,
  type Frame,
  grant,
  saveModel,
  sendRequest,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";

await initializeLogging({});

function request(type: string, payload: Record<string, unknown>) {
  return { type, id: crypto.randomUUID(), payload };
}

function data<T>(frames: Frame[], type: string): T {
  assertEquals(errorFrame(frames), undefined, JSON.stringify(frames));
  const frame = frames.find((f) => f.type === type);
  assert(frame, JSON.stringify(frames));
  return (frame.payload as { data: T }).data;
}

/** Serve's control-plane store for a filesystem datastore. */
function storeOf(repo: ServeRepo): FileSystemControlPlaneStore {
  return new FileSystemControlPlaneStore(swampPath(repo.repoDir));
}

/** A serve context with the control-plane store serve keeps pauses in. */
function ctxFor(repo: ServeRepo, grants?: Grant[]): ConnectionContext {
  return { ...createServeCtx(repo, grants), controlPlaneStore: storeOf(repo) };
}

function scheduledWorkflow(
  name: string,
  model: Definition,
  schedule: string,
  tags: Record<string, string> = {},
): Workflow {
  return Workflow.create({
    name,
    tags,
    trigger: { schedule },
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "noop",
            task: StepTask.modelMethod(model.name, "noop"),
          }),
        ],
      }),
    ],
  });
}

async function saveScheduled(
  repo: ServeRepo,
  name: string,
  schedule = "* * * * * *",
  tags: Record<string, string> = {},
): Promise<Workflow> {
  const model = await saveModel(repo, `${name}-db`);
  const workflow = scheduledWorkflow(name, model, schedule, tags);
  await repo.repoContext.workflowRepo.save(workflow);
  return workflow;
}

const WORKFLOW_GRANTS = [
  grant({ resource: { kind: "workflow", pattern: "*" } }),
  grant({ resource: { kind: "model", pattern: "*" } }),
];

Deno.test("schedule pause: serve's scheduler skips a paused workflow, runs it once resumed, and manual runs still run", async () => {
  await withServeRepo(async (repo) => {
    const wf = await saveScheduled(repo, "nightly-gc");
    const ctx = ctxFor(repo);
    data(
      await sendRequest(
        ctx,
        request("workflow.schedule.pause", {
          workflowIdOrName: "nightly-gc",
          reason: "stalling serve",
        }),
      ),
      "workflow.schedule.pause",
    );

    const events: ScheduledExecutionEvent[] = [];
    let scheduledRuns = 0;
    const service = new ScheduledExecutionService({
      workflowRepo: repo.repoContext.workflowRepo,
      repoDir: repo.repoDir,
      executeWorkflow: () => {
        scheduledRuns++;
        return Promise.resolve();
      },
      schedulePauses: new ControlPlaneSchedulePauseRepository(storeOf(repo)),
    });
    await service.start((e) => events.push(e));
    try {
      await waitFor(
        () => events.some((e) => e.kind === "schedule_skipped"),
        "paused fire skipped",
      );
      assertEquals(scheduledRuns, 0);
      const skipped = events.find((e) => e.kind === "schedule_skipped");
      assert(skipped?.kind === "schedule_skipped");
      assertEquals(skipped.workflowId, wf.id);
      assertEquals(skipped.paused?.reason, "stalling serve");

      // A manual run is not a cron fire: the pause does not stop it.
      const run = await sendRequest(
        ctx,
        request("workflow.run", { workflowIdOrName: "nightly-gc" }),
      );
      assertEquals(errorFrame(run), undefined, JSON.stringify(run));

      const resumed = data<{ wasPaused: boolean }>(
        await sendRequest(
          ctx,
          request("workflow.schedule.resume", {
            workflowIdOrName: "nightly-gc",
          }),
        ),
        "workflow.schedule.resume",
      );
      assertEquals(resumed.wasPaused, true);
      await waitFor(() => scheduledRuns > 0, "fire after resume");
    } finally {
      await service.stop();
    }
  });
});

Deno.test("schedule pause: pausing by id and by name keeps one record, attributed to the caller", async () => {
  await withServeRepo(async (repo) => {
    const wf = await saveScheduled(repo, "nightly-gc", "0 3 * * *");
    const ctx = ctxFor(repo, WORKFLOW_GRANTS);
    data(
      await sendRequest(
        ctx,
        request("workflow.schedule.pause", { workflowIdOrName: wf.id }),
      ),
      "workflow.schedule.pause",
    );
    const second = data<{ replaced: boolean; pausedBy: string }>(
      await sendRequest(
        ctx,
        request("workflow.schedule.pause", { workflowIdOrName: wf.name }),
      ),
      "workflow.schedule.pause",
    );
    assertEquals(second.replaced, true);
    assertEquals(second.pausedBy, "user:caller");
    assertEquals(await storeOf(repo).list("schedule-pauses"), [
      `schedule-pauses/${wf.id}`,
    ]);
  });
});

Deno.test("schedule pause: a pause survives renaming the workflow through workflow.edit", async () => {
  await withServeRepo(async (repo) => {
    const wf = await saveScheduled(repo, "nightly-gc", "0 3 * * *");
    const ctx = ctxFor(repo);
    data(
      await sendRequest(
        ctx,
        request("workflow.schedule.pause", { workflowIdOrName: "nightly-gc" }),
      ),
      "workflow.schedule.pause",
    );

    const renamed = { ...wf.toData(), name: "nightly-gc-v2" };
    data(
      await sendRequest(
        ctx,
        request("workflow.edit", {
          workflowIdOrName: "nightly-gc",
          content: stringifyYaml(JSON.parse(JSON.stringify(renamed))),
          allowRename: true,
        }),
      ),
      "workflow.edit",
    );

    const listed = data<
      { schedules: Array<{ workflowName: string; paused: boolean }> }
    >(
      await sendRequest(ctx, request("workflow.schedule.list", {})),
      "workflow.schedule.list",
    );
    assertEquals(
      listed.schedules.map((s) => [s.workflowName, s.paused]),
      [["nightly-gc-v2", true]],
    );
    const pause = await new ControlPlaneSchedulePauseRepository(storeOf(repo))
      .get(createWorkflowId(wf.id));
    assertEquals(pause?.workflowName, "nightly-gc");
  });
});

Deno.test("schedule pause: list leaves out workflows the caller may not read; pause and resume need write", async () => {
  await withServeRepo(async (repo) => {
    await saveScheduled(repo, "prod-gc", "0 3 * * *", { env: "prod" });
    await saveScheduled(repo, "dev-gc", "0 4 * * *");
    const grants = [
      ...WORKFLOW_GRANTS,
      grant({
        effect: "deny",
        actions: ["read", "write"],
        resource: { kind: "workflow", pattern: "*" },
        condition: 'tags.env == "prod"',
      }),
    ];
    const ctx = ctxFor(repo, grants);

    const listed = data<{ schedules: Array<{ workflowName: string }> }>(
      await sendRequest(ctx, request("workflow.schedule.list", {})),
      "workflow.schedule.list",
    );
    assertEquals(listed.schedules.map((s) => s.workflowName), ["dev-gc"]);

    for (
      const type of ["workflow.schedule.pause", "workflow.schedule.resume"]
    ) {
      const refused = await sendRequest(
        ctx,
        request(type, { workflowIdOrName: "prod-gc" }),
      );
      assert(errorFrame(refused), `${type}: ${JSON.stringify(refused)}`);
    }
    assertEquals(await storeOf(repo).list("schedule-pauses"), []);
  });
});

Deno.test("schedule pause: an orphaned pause is resumed by its id only under a grant matching the id", async () => {
  await withServeRepo(async (repo) => {
    const id = crypto.randomUUID();
    await new ControlPlaneSchedulePauseRepository(storeOf(repo)).save({
      workflowId: id,
      workflowName: "deleted-gc",
      pausedBy: "user:ops",
      pausedAt: new Date().toISOString(),
    });

    const narrow = ctxFor(repo, [
      grant({ resource: { kind: "workflow", pattern: "nightly-*" } }),
    ]);
    const refused = await sendRequest(
      narrow,
      request("workflow.schedule.resume", { workflowIdOrName: id }),
    );
    assert(errorFrame(refused), JSON.stringify(refused));

    const resumed = data<{ workflowName: string; wasPaused: boolean }>(
      await sendRequest(
        ctxFor(repo, WORKFLOW_GRANTS),
        request("workflow.schedule.resume", { workflowIdOrName: id }),
      ),
      "workflow.schedule.resume",
    );
    assertEquals(
      resumed,
      {
        workflowId: id,
        workflowName: "deleted-gc",
        wasPaused: true,
      } as typeof resumed,
    );
    assertEquals(await storeOf(repo).list("schedule-pauses"), []);
  });
});

Deno.test("schedule pause: a pulled extension workflow is paused by its scoped name", async () => {
  await withServeRepo(async (repo) => {
    const extensionDir = join(repo.repoDir, "ext-workflows");
    await Deno.mkdir(extensionDir);
    const model = await saveModel(repo, "gc-db");
    const wf = scheduledWorkflow("@acme/ops/nightly-gc", model, "0 3 * * *");
    await Deno.writeTextFile(
      join(extensionDir, "nightly-gc.yaml"),
      stringifyYaml(JSON.parse(JSON.stringify(wf.toData()))),
    );

    const deps = createWorkflowScheduleDeps({
      workflowRepo: new ExtensionWorkflowRepository(extensionDir),
      controlPlaneStore: storeOf(repo),
      overrideSchedules: () => Promise.resolve(new Map()),
    });
    const events = await collect<WorkflowSchedulePauseEvent>(
      workflowSchedulePause(createLibSwampContext(), deps, {
        workflowIdOrName: "@acme/ops/nightly-gc",
        pausedBy: "user:ops",
      }),
    );
    const last = events[events.length - 1];
    assert(last.kind === "completed", JSON.stringify(last));
    assertEquals(last.data.workflowId, wf.id);
    assertEquals(
      (await deps.pauses.get(createWorkflowId(wf.id)))?.workflowName,
      "@acme/ops/nightly-gc",
    );
  });
});

Deno.test("schedule pause: over serve, a bad --until gets its own message, not a thrown date or schema dump", async () => {
  await withServeRepo(async (repo) => {
    await saveScheduled(repo, "nightly-gc", "0 3 * * *");
    const ctx = ctxFor(repo);
    for (
      const [until, expected] of [
        ["99999999y", "--until 99999999y is too far in the future."],
        [
          "9999-12-31T23:59-05:00",
          "--until 9999-12-31T23:59-05:00 is too far in the future.",
        ],
        [
          "2026-10-17T09:00",
          "--until 2026-10-17T09:00 has no time zone: add Z or an offset such as +02:00, or give a duration such as 2h.",
        ],
      ]
    ) {
      const frames = await sendRequest(
        ctx,
        request("workflow.schedule.pause", {
          workflowIdOrName: "nightly-gc",
          until,
        }),
      );
      const error = errorFrame(frames);
      assert(error, `${until}: ${JSON.stringify(frames)}`);
      const message = JSON.stringify(error);
      assert(message.includes(expected), `${until}: ${message}`);
      assert(!message.includes("Invalid time value"), message);
      assert(!message.includes("regex"), message);
    }
    assertEquals(await storeOf(repo).list("schedule-pauses"), []);
  });
});
