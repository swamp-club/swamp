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
 * Serve commits through root units of work with no behaviour change
 * (swamp-club#3034). The use-case sync characterization rows cover each
 * converted handler's success path; these cover what they do not: failed
 * requests, suspended and cancelled workflow runs, and concurrent requests.
 * Each test pins today's marks, pushes and replies, and checks the work ran
 * in exactly one root unit that staged every mark.
 */

import "../src/domain/models/models.ts";
import { assertEquals } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { createLegacyUnitOfWork } from "../src/infrastructure/persistence/legacy_unit_of_work.ts";
import { useUnitOfWorkFactoryForTesting } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import type { WorkflowRunEvent } from "../src/libswamp/mod.ts";
import { ActiveRunRegistry } from "../src/serve/active_run_registry.ts";
import { handleMessage } from "../src/serve/connection.ts";
import { executeWorkflowWithLocks } from "../src/serve/deps.ts";
import {
  CALLER,
  type Frame,
  saveData,
  saveGatedWorkflow,
  saveModel,
  saveWorkflow,
  sendRequest,
} from "./serve_request_harness.ts";
import {
  assertRootUnit,
  baseline,
  captureUnits,
  normalisePath,
  observe,
  ObservedSyncGate,
  serveCtx,
  settle,
  syncOrder,
  withRowRepos,
} from "./usecase_sync_fixtures.ts";

await initializeLogging({});

/** The error a request answered with, without its per-request id. */
function errorOf(frames: Frame[]): unknown {
  assertEquals(frames.length, 1, "expected exactly one reply frame");
  return frames[0].type === "error" ? frames[0].error : frames[0];
}

Deno.test("serve root units: a data.delete whose use case fails still pushes once and answers with its error", async () => {
  await withRowRepos({}, async (repos) => {
    const model = await saveModel(repos.serveRepo, "m1");
    await saveData(repos.serveRepo, model, "state");
    await settle(repos);
    const ctx = serveCtx(repos);
    const base = baseline(repos);
    let frames: Frame[] = [];
    const units = await captureUnits(async () => {
      frames = await sendRequest(ctx, {
        id: crypto.randomUUID(),
        type: "data.delete",
        payload: { modelIdOrName: "m1", dataName: "missing" },
      });
    });
    const observation = observe(repos, base);

    assertEquals(errorOf(frames), {
      code: "data_delete_failed",
      message: 'No data named "missing" exists for model m1',
    });
    assertEquals(observation.ops, ["push[0]"]);
    assertRootUnit(
      {
        name: "data delete (failed)",
        syncOrder: { serve: ["push", "release"] },
      },
      "serve",
      repos,
      units,
      observation,
      syncOrder(repos, base),
    );
  });
});

Deno.test("serve root units: a workflow.approve whose use case fails still pushes once and answers with its error", async () => {
  await withRowRepos({}, async (repos) => {
    await saveGatedWorkflow(repos.serveRepo, "gated", "gate");
    await settle(repos);
    const ctx = serveCtx(repos);
    const base = baseline(repos);
    const runId = crypto.randomUUID();
    let frames: Frame[] = [];
    const units = await captureUnits(async () => {
      frames = await sendRequest(ctx, {
        id: crypto.randomUUID(),
        type: "workflow.approve",
        payload: { workflowIdOrName: "gated", runId, stepName: "gate" },
      });
    });
    const observation = observe(repos, base);

    assertEquals(errorOf(frames), {
      code: "workflow_approve_failed",
      message: `Workflow run not found: ${runId}`,
    });
    assertEquals(observation.ops, ["push[0]"]);
    assertRootUnit(
      {
        name: "workflow approve (failed)",
        syncOrder: { serve: ["push", "release"] },
      },
      "serve",
      repos,
      units,
      observation,
      syncOrder(repos, base),
    );
  });
});

/**
 * Runs `workflowName` through executeWorkflowWithLocks under an observed
 * gate, and returns how it stopped as `<kind>:<status>` when it suspended
 * or was cancelled, or undefined otherwise.
 */
async function runWorkflow(
  repos: Parameters<Parameters<typeof withRowRepos>[1]>[0],
  workflowName: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  let last: string | undefined;
  await executeWorkflowWithLocks(
    repos.a.repoDir,
    repos.a.repoContext,
    repos.a.datastoreConfig,
    {
      workflowIdOrName: workflowName,
      inputs: {},
      instanceId: crypto.randomUUID(),
    },
    signal,
    (event: WorkflowRunEvent) => {
      if (event.kind === "suspended" || event.kind === "cancelled") {
        last = `${event.kind}:${event.run.status}`;
      }
    },
    repos.a.syncService,
    undefined,
    { syncGate: new ObservedSyncGate(repos) },
  );
  return last;
}

Deno.test("serve root units: a workflow run that suspends pushes once, after the run", async () => {
  await withRowRepos({}, async (repos) => {
    await saveGatedWorkflow(repos.serveRepo, "gated", "gate");
    await settle(repos);
    const base = baseline(repos);
    let last: string | undefined;
    const units = await captureUnits(async () => {
      last = await runWorkflow(repos, "gated", new AbortController().signal);
    });
    const observation = observe(repos, base);

    assertEquals(last, "suspended:suspended");
    assertEquals(observation.ops, [
      "markDirty workflows-evaluated/workflow-gated.yaml",
      "markDirty workflows-evaluated/runs/<id>/evaluated-workflow.yaml",
      "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
      "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
      "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
      "push[3]",
    ]);
    assertRootUnit(
      {
        name: "workflow run (suspended)",
        syncOrder: { serve: ["push", "release"] },
      },
      "serve",
      repos,
      units,
      observation,
      syncOrder(repos, base),
    );
  });
});

Deno.test("serve root units: a workflow run cancelled before it starts a step pushes once, after the run", async () => {
  await withRowRepos({}, async (repos) => {
    const model = await saveModel(repos.serveRepo, "m1");
    await saveWorkflow(repos.serveRepo, "plain", model);
    await settle(repos);
    const base = baseline(repos);
    const controller = new AbortController();
    controller.abort();
    let last: string | undefined;
    const units = await captureUnits(async () => {
      last = await runWorkflow(repos, "plain", controller.signal);
    });
    const observation = observe(repos, base);

    assertEquals(last, "cancelled:cancelled");
    assertEquals(observation.ops, [
      "markDirty workflows-evaluated/workflow-plain.yaml",
      "markDirty workflows-evaluated/runs/<id>/evaluated-workflow.yaml",
      "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
      "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
      "markDirty workflow-runs/<id>/workflow-run-<id>.yaml",
      "push[3]",
    ]);
    assertRootUnit(
      {
        name: "workflow run (cancelled)",
        syncOrder: { serve: ["push", "release"] },
      },
      "serve",
      repos,
      units,
      observation,
      syncOrder(repos, base),
    );
  });
});

Deno.test("serve root units: concurrent requests get separate roots, each pushing its own changes under the gate", async () => {
  await withRowRepos({}, async (repos) => {
    const model = await saveModel(repos.serveRepo, "m1");
    await saveData(repos.serveRepo, model, "first");
    await saveData(repos.serveRepo, model, "second");
    await settle(repos);
    const ctx = serveCtx(repos);
    const base = baseline(repos);
    const remove = (dataName: string) =>
      sendRequest(ctx, {
        id: crypto.randomUUID(),
        type: "data.delete",
        payload: { modelIdOrName: "m1", dataName },
      });
    let replies: Frame[][] = [];
    const units = await captureUnits(async () => {
      replies = await Promise.all([remove("first"), remove("second")]);
    });

    for (const frames of replies) {
      assertEquals(frames.length, 1);
      assertEquals(frames[0].type, "data.delete");
    }
    const roots = units.filter((captured) => captured.role === "root");
    assertEquals(roots.length, 2, "expected one root per request");
    const stagedNames = roots.map(({ unit }) =>
      unit.staged().map((change) =>
        change.kind === "bulk" ? "bulk" : normalisePath(repos, change.path)
      )
    );
    for (const [own, other] of [["first", "second"], ["second", "first"]]) {
      const staged = stagedNames.find((paths) =>
        paths.some((path) => path.includes(`/${own}/`))
      );
      assertEquals(staged !== undefined, true, `no root staged ${own}`);
      assertEquals(
        staged!.some((path) => path.includes(`/${other}/`)),
        false,
        `the root for ${own} staged the other request's change`,
      );
    }
    // The gate runs the requests one after the other: each pushes before
    // its gate exit, and the second marks nothing until the first has left.
    assertEquals(syncOrder(repos, base), [
      "push",
      "release",
      "push",
      "release",
    ]);
    const ops = repos.remote.ops().slice(base.opCount)
      .filter((op) => op.instance === "A");
    assertEquals(ops.filter((op) => op.op === "push").length, 2);
    // Op-log length at the first gate exit, relative to the baseline.
    const firstExit = repos.releases[base.releaseCount] - base.opCount;
    const firstPush = ops.findIndex((op) => op.op === "push");
    assertEquals(
      ops.slice(0, firstPush).every((op) => op.op === "markDirty"),
      true,
      "the first request marks, then pushes",
    );
    assertEquals(
      ops.slice(firstPush + 1, firstExit).some((op) => op.op === "markDirty"),
      false,
      "the second request marked before the first left the gate",
    );
    assertEquals(
      ops.slice(firstExit).some((op) => op.op === "markDirty"),
      true,
      "the second request's marks follow the first gate exit",
    );
  });
});

/**
 * A parent workflow (auto-resume on) whose first step runs `child`, a
 * workflow suspended at its `gate` approval.
 */
async function saveParentAwaitingGatedChild(
  repos: Parameters<Parameters<typeof withRowRepos>[1]>[0],
): Promise<{ parent: Workflow; child: Workflow }> {
  const child = Workflow.create({
    name: "gated-child",
    jobs: [
      Job.create({
        name: "child-job",
        steps: [
          Step.create({
            name: "gate",
            task: StepTask.manualApproval("Approve the child"),
          }),
        ],
      }),
    ],
  });
  const parent = Workflow.create({
    name: "waiting-parent",
    autoResume: true,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "call-nested",
            task: StepTask.workflow(child.name),
          }),
          Step.create({
            name: "after-nested",
            task: StepTask.model("m1", "noop"),
            dependsOn: [{
              step: "call-nested",
              condition: TriggerCondition.succeeded(),
            }],
          }),
        ],
      }),
    ],
  });
  await repos.a.repoContext.workflowRepo.save(child);
  await repos.a.repoContext.workflowRepo.save(parent);
  return { parent, child };
}

Deno.test("serve root units: a workflow.reject whose reply fails after the save still resumes the parent and pushes once", async () => {
  await withRowRepos({}, async (repos) => {
    const { parent, child } = await saveParentAwaitingGatedChild(repos);
    await executeWorkflowWithLocks(
      repos.a.repoDir,
      repos.a.repoContext,
      repos.a.datastoreConfig,
      {
        workflowIdOrName: parent.name,
        inputs: {},
        instanceId: crypto.randomUUID(),
      },
      new AbortController().signal,
      () => {},
      repos.a.syncService,
      undefined,
      { syncGate: undefined },
    );
    const runRepo = repos.a.repoContext.workflowRunRepo;
    const [parentRun] = await runRepo.findAllByWorkflowId(parent.id);
    const [childRun] = await runRepo.findAllByWorkflowId(child.id);
    assertEquals(parentRun.status, "suspended");
    assertEquals(childRun.status, "suspended");
    await settle(repos);

    const registry = new ActiveRunRegistry();
    const ctx = serveCtx(repos, { activeRunRegistry: registry });
    const pushes = () =>
      repos.remote.ops().filter((op) => op.instance === "A" && op.op === "push")
        .length;
    // Each root's flush, with the pushes it made.
    const rootFlushes: number[] = [];
    const dispose = useUnitOfWorkFactoryForTesting((markDirty, options) => {
      const flush = options.flush;
      return createLegacyUnitOfWork(markDirty, {
        flush: options.role === "root" && flush !== undefined
          ? async () => {
            const before = pushes();
            await flush();
            rootFlushes.push(pushes() - before);
          }
          : flush,
        parent: options.parent,
        afterCommit: "forward",
      });
    });
    try {
      // The socket closes while the reject's reply is sent: that send throws,
      // and the error reply after it is dropped, as the socket is closed.
      const socket = {
        readyState: WebSocket.OPEN,
        send(data: string) {
          if (JSON.parse(data).type === "workflow.reject") {
            socket.readyState = WebSocket.CLOSED;
            throw new Error("socket closed mid-send");
          }
        },
        close() {},
      };
      const requestId = crypto.randomUUID();
      const active = new Map<string, AbortController>();
      handleMessage(
        socket as unknown as WebSocket,
        ctx,
        active,
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "workflow.reject",
            id: requestId,
            payload: {
              workflowIdOrName: child.name,
              runId: childRun.id,
              stepName: "gate",
              reason: "not today",
            },
          }),
        }),
        CALLER,
      );
      await waitFor(() => !active.has(requestId), "the reject finished");

      // The rejection was saved before the reply failed, so the parent still
      // resumes, and fails its step as a rejected approval.
      await waitFor(
        async () =>
          (await runRepo.findById(parent.id, parentRun.id))?.status ===
            "failed" && registry.size === 0,
        "the parent resumed after its child was rejected",
      );
      const rejectedChild = await runRepo.findById(child.id, childRun.id);
      assertEquals(rejectedChild?.status, "failed");
    } finally {
      dispose();
    }
    // The reject's root pushed exactly once; the resume pushes on its own.
    assertEquals(rootFlushes, [1]);
  });
});
