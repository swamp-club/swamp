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
 * (swamp-club#3034, swamp-club#3035). The use-case sync characterization
 * rows cover each converted handler's success path; these cover what they
 * do not: failed, refused and cancelled requests, replies sent before a
 * success-only push, model method runs with and without model locks,
 * suspended and cancelled workflow runs, resumes and the auto-resumes they
 * launch, and concurrent requests.
 * Each test pins today's marks, pushes and replies, and checks the work ran
 * in exactly one root unit that staged every mark.
 */

import "../src/domain/models/models.ts";
import { assertEquals } from "@std/assert";
import { configure, type LogRecord } from "@logtape/logtape";
import { waitFor } from "@swamp-club/swamp-testing";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { getRegisteredLockKeys } from "../src/infrastructure/persistence/datastore_sync_coordinator.ts";
import { createLegacyUnitOfWork } from "../src/infrastructure/persistence/legacy_unit_of_work.ts";
import {
  runInRootUnitOfWork,
  useUnitOfWorkFactoryForTesting,
} from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import type { WorkflowRunEvent } from "../src/libswamp/mod.ts";
import { ActiveRunRegistry } from "../src/serve/active_run_registry.ts";
import { handleMessage } from "../src/serve/connection.ts";
import { executeWorkflowWithLocks } from "../src/serve/deps.ts";
import { RunCancelRegistry } from "../src/serve/run_cancel_registry.ts";
import { handleWorkflowEdit } from "../src/serve/handlers/workflow_handlers.ts";
import { startDetachedResume } from "../src/serve/resume_launcher.ts";
import type { BufferTerminal } from "../src/serve/run_event_buffer.ts";
import {
  CALLER,
  errorFrame,
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
    // The reject's root pushed exactly once, then the parent's resume, in a
    // root of its own (swamp-club#3035).
    assertEquals(rootFlushes, [1, 1]);
  });
});

// ---------------------------------------------------------------------------
// Success-only handlers, model method runs and resumes (swamp-club#3035)
// ---------------------------------------------------------------------------

type Repos = Parameters<Parameters<typeof withRowRepos>[1]>[0];

/**
 * Runs `fn` with every root's flush counting the pushes it made, and
 * returns those counts in the order the roots ended. A root with no flush
 * is not counted.
 */
async function countRootFlushes(
  repos: Repos,
  fn: () => Promise<void>,
): Promise<number[]> {
  const pushes = () =>
    repos.remote.ops().filter((op) => op.instance === "A" && op.op === "push")
      .length;
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
    await fn();
  } finally {
    dispose();
  }
  return rootFlushes;
}

/**
 * Sends one request on a socket that records, with each frame, how many
 * pushes instance A had made since the request when it was sent.
 */
async function sendCountingPushes(
  repos: Repos,
  ctx: ReturnType<typeof serveCtx>,
  request: { type: string; payload: Record<string, unknown> },
): Promise<{ type: string; pushesBefore: number }[]> {
  const pushes = () =>
    repos.remote.ops().filter((op) => op.instance === "A" && op.op === "push")
      .length;
  const start = pushes();
  const sent: { type: string; pushesBefore: number }[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send(data: string) {
      sent.push({
        type: JSON.parse(data).type,
        pushesBefore: pushes() - start,
      });
    },
    close() {},
  };
  const id = crypto.randomUUID();
  const active = new Map<string, AbortController>();
  handleMessage(
    socket as unknown as WebSocket,
    ctx,
    active,
    new MessageEvent("message", { data: JSON.stringify({ id, ...request }) }),
    CALLER,
  );
  await waitFor(
    () => !active.has(id) && (ctx.activeRunRegistry?.size ?? 0) === 0,
    `request ${request.type} finished`,
  );
  return sent;
}

Deno.test("serve root units: a model.create whose use case fails pushes nothing and answers with its error", async () => {
  await withRowRepos({}, async (repos) => {
    await saveModel(repos.serveRepo, "m1");
    await settle(repos);
    const ctx = serveCtx(repos);
    const base = baseline(repos);
    let frames: Frame[] = [];
    const units = await captureUnits(async () => {
      frames = await sendRequest(ctx, {
        id: crypto.randomUUID(),
        type: "model.create",
        payload: { typeArg: repos.modelType.normalized, name: "m1" },
      });
    });
    const observation = observe(repos, base);

    assertEquals(errorOf(frames), {
      code: "model_create_failed",
      message: "Model already exists: m1",
    });
    assertEquals(observation.ops, []);
    assertRootUnit(
      {
        name: "model create (failed)",
        syncOrder: { serve: ["release"] },
      },
      "serve",
      repos,
      units,
      observation,
      syncOrder(repos, base),
    );
  });
});

Deno.test("serve root units: a model.delete refused for its data pushes nothing", async () => {
  await withRowRepos({}, async (repos) => {
    const model = await saveModel(repos.serveRepo, "m1");
    await saveData(repos.serveRepo, model, "first");
    await settle(repos);
    const ctx = serveCtx(repos);
    const base = baseline(repos);
    let frames: Frame[] = [];
    const units = await captureUnits(async () => {
      frames = await sendRequest(ctx, {
        id: crypto.randomUUID(),
        type: "model.delete",
        payload: { modelIdOrName: "m1" },
      });
    });
    const observation = observe(repos, base);

    assertEquals((errorOf(frames) as { code: string }).code, "has_data");
    assertEquals(observation.ops, []);
    assertRootUnit(
      {
        name: "model delete (has data)",
        syncOrder: { serve: ["release"] },
      },
      "serve",
      repos,
      units,
      observation,
      syncOrder(repos, base),
    );
  });
});

Deno.test("serve root units: a workflow.edit cancelled during its save pushes nothing and answers cancelled", async () => {
  await withRowRepos({}, async (repos) => {
    const model = await saveModel(repos.serveRepo, "m1");
    const workflow = await saveWorkflow(repos.serveRepo, "wf1", model);
    const path = repos.a.repoContext.workflowRepo.getPath(workflow.id);
    const content = (await Deno.readTextFile(path)).replace(
      "name: wf1",
      "name: wf1\ndescription: edited",
    );
    await settle(repos);
    const ctx = serveCtx(repos);
    const base = baseline(repos);
    const sent: Frame[] = [];
    const socket = {
      readyState: WebSocket.OPEN,
      send(data: string) {
        sent.push(JSON.parse(data) as Frame);
      },
      close() {},
    };
    const controller = new AbortController();
    controller.abort();
    const units = await captureUnits(async () => {
      await handleWorkflowEdit(
        socket as unknown as WebSocket,
        ctx,
        "edit-1",
        { workflowIdOrName: "wf1", content },
        controller,
        CALLER,
      );
    });
    const observation = observe(repos, base);

    assertEquals(sent.map((frame) => frame.type), ["error"]);
    assertEquals(sent[0].error?.code, "cancelled");
    assertEquals(observation.ops, []);
    assertRootUnit(
      { name: "workflow edit (cancelled)", syncOrder: { serve: [] } },
      "serve",
      repos,
      units,
      observation,
      syncOrder(repos, base),
    );
  });
});

Deno.test("serve root units: a vault.create replies before it pushes, and pushes once", async () => {
  await withRowRepos({}, async (repos) => {
    await settle(repos);
    const ctx = serveCtx(repos);
    let sent: { type: string; pushesBefore: number }[] = [];
    const rootFlushes = await countRootFlushes(repos, async () => {
      sent = await sendCountingPushes(repos, ctx, {
        type: "vault.create",
        payload: { vaultType: "local_encryption", name: "v1" },
      });
    });

    assertEquals(sent, [{ type: "vault.create", pushesBefore: 0 }]);
    assertEquals(rootFlushes, [1]);
  });
});

Deno.test("serve root units: a model.method.run by type pushes once after the run, under the gate", async () => {
  await withRowRepos({}, async (repos) => {
    await settle(repos);
    const ctx = serveCtx(repos);
    const base = baseline(repos);
    let frames: Frame[] = [];
    const units = await captureUnits(async () => {
      frames = await sendRequest(ctx, {
        id: crypto.randomUUID(),
        type: "model.method.run",
        payload: {
          modelIdOrName: "fresh",
          typeArg: repos.modelType.normalized,
          definitionName: "fresh",
          methodName: "noop",
        },
      });
    });
    const observation = observe(repos, base);

    assertEquals(errorFrame(frames), undefined);
    assertEquals(observation.ops.filter((op) => op.startsWith("push")), [
      "push[3]",
    ]);
    assertRootUnit(
      {
        name: "model method run by type",
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

Deno.test("serve root units: a model.method.run whose use case reports an error still pushes once, after the run", async () => {
  await withRowRepos({}, async (repos) => {
    await settle(repos);
    const ctx = serveCtx(repos);
    const base = baseline(repos);
    let frames: Frame[] = [];
    const units = await captureUnits(async () => {
      frames = await sendRequest(ctx, {
        id: crypto.randomUUID(),
        type: "model.method.run",
        payload: {
          modelIdOrName: "fresh",
          typeArg: repos.modelType.normalized,
          definitionName: "fresh",
          methodName: "missing",
        },
      });
    });
    const observation = observe(repos, base);

    // The use case reports the error as an event and the run completes, so
    // the push still runs: it follows the run, not the method's success.
    const events = frames.flatMap((frame) =>
      frame.type === "event" ? [frame.event as { kind: string }] : []
    );
    assertEquals(events.some((event) => event.kind === "error"), true);
    assertEquals(frames.at(-1)?.type, "done");
    assertEquals(observation.ops, ["push[0]"]);
    assertRootUnit(
      {
        name: "model method run (use case error)",
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

Deno.test("serve root units: a model.method.run that takes model locks pushes only through its lock flush", async () => {
  await withRowRepos({}, async (repos) => {
    await saveModel(repos.serveRepo, "m1");
    await settle(repos);
    const ctx = serveCtx(repos);
    const base = baseline(repos);
    let frames: Frame[] = [];
    const rootFlushes = await countRootFlushes(repos, async () => {
      frames = await sendRequest(ctx, {
        id: crypto.randomUUID(),
        type: "model.method.run",
        payload: { modelIdOrName: "m1", methodName: "touch" },
      });
    });
    const observation = observe(repos, base);

    assertEquals(errorFrame(frames), undefined);
    // The lock flush commits the run's changes when the locks are released;
    // the root's flush, which owns only the no-lock push, pushes nothing.
    assertEquals(observation.ops, [
      "pull[0]",
      "markDirty definitions-evaluated/<type>/m1.yaml",
      "markDirty outputs/<type>/touch/<id>-<time>.yaml",
      "markDirty data/<type>/<id>/report-swamp-method-summary",
      "markDirty data/<type>/<id>/report-swamp-method-summary-json",
      "prepare[8]",
      "commit[8]",
    ]);
    assertEquals(rootFlushes, [0]);
  });
});

/**
 * Sends one model.method.run and returns what happened, in order: each
 * reply frame's type (a run of event frames as one `event`), instance A's
 * pull, push, prepare and commit ops, `release` where a lock release or gate
 * exit came between them, and `deregister` where the run left the cancel
 * registry (inline) or the active run registry (detached). Pins where the
 * model lock's push sits relative to the reply and the run's cleanup
 * (swamp-club#3055). With `failFirstEvent`, the socket throws on the first
 * event frame, so the run throws out of the root as a lost connection does.
 */
async function methodRunTimeline(
  repos: Repos,
  options: {
    detached: boolean;
    payload: Record<string, unknown>;
    failFirstEvent?: boolean;
  },
): Promise<string[]> {
  const cancelRegistry = new RunCancelRegistry();
  const base = serveCtx(repos);
  const ctx = {
    ...base,
    cancelRegistry,
    activeRunRegistry: options.detached ? base.activeRunRegistry : undefined,
  };
  const timeline: string[] = [];
  let opsSeen = repos.remote.ops().length;
  let releasesSeen = repos.releases.length;
  const note = (entry: string) => {
    if (entry === "release" && timeline.at(-1) === "release") return;
    if (entry === "event" && timeline.at(-1) === "event") return;
    timeline.push(entry);
  };
  const catchUp = () => {
    const ops = repos.remote.ops();
    for (; opsSeen <= ops.length; opsSeen++) {
      while (
        releasesSeen < repos.releases.length &&
        repos.releases[releasesSeen] <= opsSeen
      ) {
        note("release");
        releasesSeen++;
      }
      if (opsSeen === ops.length) break;
      const op = ops[opsSeen];
      if (op.instance === "A" && op.op !== "markDirty") note(op.op);
    }
  };
  const deregisterCancel = cancelRegistry.deregister.bind(cancelRegistry);
  cancelRegistry.deregister = (type, id) => {
    catchUp();
    note("deregister");
    deregisterCancel(type, id);
  };
  const runs = ctx.activeRunRegistry;
  if (runs) {
    const deregisterRun = runs.deregister.bind(runs);
    runs.deregister = (runId) => {
      catchUp();
      note("deregister");
      return deregisterRun(runId);
    };
  }
  let failNext = options.failFirstEvent === true;
  const socket = {
    readyState: WebSocket.OPEN,
    send(data: string) {
      catchUp();
      const type = JSON.parse(data).type as string;
      if (type === "event" && failNext) {
        failNext = false;
        note("event (send failed)");
        throw new Error("socket send failed");
      }
      note(type);
    },
    close() {},
  };
  const id = crypto.randomUUID();
  const active = new Map<string, AbortController>();
  handleMessage(
    socket as unknown as WebSocket,
    ctx,
    active,
    new MessageEvent("message", {
      data: JSON.stringify({
        id,
        type: "model.method.run",
        payload: options.payload,
      }),
    }),
    CALLER,
  );
  await waitFor(
    () =>
      !active.has(id) && (ctx.activeRunRegistry?.size ?? 0) === 0 &&
      cancelRegistry.size === 0,
    "model.method.run finished",
  );
  catchUp();
  return timeline;
}

const LOCKED_RUN = { modelIdOrName: "m1", methodName: "touch" };

function unlockedRun(repos: Repos) {
  return {
    modelIdOrName: "fresh",
    typeArg: repos.modelType.normalized,
    definitionName: "fresh",
    methodName: "noop",
  };
}

Deno.test("serve root units: an inline model.method.run with a model lock replies and deregisters before the lock pushes and releases", async () => {
  await withRowRepos({}, async (repos) => {
    await saveModel(repos.serveRepo, "m1");
    await settle(repos);
    assertEquals(
      await methodRunTimeline(repos, { detached: false, payload: LOCKED_RUN }),
      [
        "pull",
        "release",
        "event",
        "done",
        "deregister",
        "prepare",
        "commit",
        "release",
      ],
    );
  });
});

Deno.test("serve root units: an inline model.method.run with a model lock that throws replies with its error, then the lock pushes and releases", async () => {
  await withRowRepos({}, async (repos) => {
    await saveModel(repos.serveRepo, "m1");
    await settle(repos);
    assertEquals(
      await methodRunTimeline(repos, {
        detached: false,
        payload: LOCKED_RUN,
        failFirstEvent: true,
      }),
      [
        "pull",
        "release",
        "event (send failed)",
        "error",
        "deregister",
        "prepare",
        "commit",
        "release",
      ],
    );
  });
});

/** Every warning logged under any category while `fn` runs, rendered. */
async function captureWarnings(fn: () => Promise<void>): Promise<string[]> {
  const captured: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => captured.push(record) },
    loggers: [
      { category: [], lowestLevel: "warning", sinks: ["capture"] },
      { category: ["logtape", "meta"], lowestLevel: "fatal", sinks: [] },
    ],
    reset: true,
  });
  try {
    await fn();
  } finally {
    await initializeLogging({ _reset: true });
  }
  return captured.map((record) =>
    record.message.map((part) => String(part)).join("")
  );
}

Deno.test("serve root units: an inline model.method.run whose lock push fails has already replied, warns once, and still releases the lock", async () => {
  await withRowRepos({}, async (repos) => {
    await saveModel(repos.serveRepo, "m1");
    await settle(repos);
    repos.remote.failNext("commit", new Error("injected commit failure"), {
      instance: "A",
    });
    let timeline: string[] = [];
    const warnings = await captureWarnings(async () => {
      timeline = await methodRunTimeline(repos, {
        detached: false,
        payload: LOCKED_RUN,
      });
    });
    assertEquals(timeline, [
      "pull",
      "release",
      "event",
      "done",
      "deregister",
      "prepare",
      "release",
    ]);
    assertEquals(
      warnings.filter((warning) =>
        warning.startsWith("Failed to release locks: ")
      ).length,
      1,
    );
    assertEquals(
      warnings.some((warning) => warning.includes("injected commit failure")),
      true,
    );
    assertEquals(getRegisteredLockKeys(), [], "the model lock was released");
  });
});

Deno.test("serve root units: an inline model.method.run without a lock replies, pushes, then deregisters", async () => {
  await withRowRepos({}, async (repos) => {
    await settle(repos);
    assertEquals(
      await methodRunTimeline(repos, {
        detached: false,
        payload: unlockedRun(repos),
      }),
      ["event", "done", "push", "release", "deregister"],
    );
  });
});

Deno.test("serve root units: an inline model.method.run without a lock that throws replies with its error and pushes nothing", async () => {
  await withRowRepos({}, async (repos) => {
    await settle(repos);
    assertEquals(
      await methodRunTimeline(repos, {
        detached: false,
        payload: unlockedRun(repos),
        failFirstEvent: true,
      }),
      ["event (send failed)", "error", "deregister"],
    );
  });
});

Deno.test("serve root units: a detached model.method.run with a model lock ends its stream before the lock pushes and releases", async () => {
  await withRowRepos({}, async (repos) => {
    await saveModel(repos.serveRepo, "m1");
    await settle(repos);
    assertEquals(
      await methodRunTimeline(repos, { detached: true, payload: LOCKED_RUN }),
      [
        "event",
        "pull",
        "release",
        "event",
        "done",
        "prepare",
        "commit",
        "release",
        "deregister",
      ],
    );
  });
});

Deno.test("serve root units: a detached model.method.run without a lock pushes before it ends its stream", async () => {
  await withRowRepos({}, async (repos) => {
    await settle(repos);
    assertEquals(
      await methodRunTimeline(repos, {
        detached: true,
        payload: unlockedRun(repos),
      }),
      ["event", "push", "release", "done", "deregister"],
    );
  });
});

Deno.test("serve root units: a workflow.resume without a run registry whose resume fails pushes once, after its error reply", async () => {
  await withRowRepos({}, async (repos) => {
    await saveGatedWorkflow(repos.serveRepo, "gated", "gate");
    await settle(repos);
    const ctx = { ...serveCtx(repos), activeRunRegistry: undefined };
    const base = baseline(repos);
    const runId = crypto.randomUUID();
    let sent: { type: string; pushesBefore: number }[] = [];
    const units = await captureUnits(async () => {
      sent = await sendCountingPushes(repos, ctx, {
        type: "workflow.resume",
        payload: { workflowIdOrName: "gated", runId },
      });
    });
    const observation = observe(repos, base);

    assertEquals(sent, [{ type: "error", pushesBefore: 0 }]);
    assertEquals(observation.ops, ["push[0]"]);
    assertRootUnit(
      {
        name: "workflow resume (failed)",
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

Deno.test("serve root units: resuming an approved nested child still auto-resumes its parent, each resume pushing once", async () => {
  await withRowRepos({}, async (repos) => {
    await saveModel(repos.serveRepo, "m1");
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
    // The child workflow does not opt into auto-resume, so the approval
    // only decides its gate.
    const approved = await sendRequest(ctx, {
      id: crypto.randomUUID(),
      type: "workflow.approve",
      payload: {
        workflowIdOrName: child.name,
        runId: childRun.id,
        stepName: "gate",
      },
    });
    assertEquals(errorFrame(approved), undefined);

    const rootFlushes = await countRootFlushes(repos, async () => {
      const resumed = await sendRequest(ctx, {
        id: crypto.randomUUID(),
        type: "workflow.resume",
        payload: { workflowIdOrName: child.name, runId: childRun.id },
      });
      assertEquals(errorFrame(resumed), undefined);
      // The child's resume launches the parent's once the child's own push
      // is done; the parent then runs to completion.
      await waitFor(
        async () =>
          (await runRepo.findById(parent.id, parentRun.id))?.status ===
            "succeeded" && registry.size === 0,
        "the parent resumed after its child completed",
      );
    });
    assertEquals(
      (await runRepo.findById(child.id, childRun.id))?.status,
      "succeeded",
    );
    // The child's resume and the parent's each push once, in their own root.
    assertEquals(rootFlushes, [1, 1]);
  });
});

Deno.test("serve root units: an approve that auto-resumes its run pushes once for the approval and once for the resume", async () => {
  await withRowRepos({}, async (repos) => {
    const gated = Workflow.create({
      name: "auto-gated",
      autoResume: true,
      jobs: [
        Job.create({
          name: "main",
          steps: [
            Step.create({
              name: "gate",
              task: StepTask.manualApproval("Approve"),
            }),
          ],
        }),
      ],
    });
    await repos.a.repoContext.workflowRepo.save(gated);
    let runId: string | undefined;
    await executeWorkflowWithLocks(
      repos.a.repoDir,
      repos.a.repoContext,
      repos.a.datastoreConfig,
      {
        workflowIdOrName: gated.name,
        inputs: {},
        instanceId: crypto.randomUUID(),
      },
      new AbortController().signal,
      (event: WorkflowRunEvent) => {
        if (event.kind === "started") runId = event.runId;
      },
      repos.a.syncService,
      undefined,
      { syncGate: undefined },
    );
    if (runId === undefined) throw new Error("the gated run never started");
    const gatedRunId: string = runId;
    await settle(repos);

    const registry = new ActiveRunRegistry();
    const ctx = serveCtx(repos, { activeRunRegistry: registry });
    let frames: Frame[] = [];
    const rootFlushes = await countRootFlushes(repos, async () => {
      frames = await sendRequest(ctx, {
        id: crypto.randomUUID(),
        type: "workflow.approve",
        payload: {
          workflowIdOrName: gated.name,
          runId: gatedRunId,
          stepName: "gate",
        },
      });
      await waitFor(
        async () =>
          (await repos.a.repoContext.workflowRunRepo.findAllByWorkflowId(
              gated.id,
            ))[0]?.status === "succeeded" && registry.size === 0,
        "the approved run resumed and completed",
      );
    });

    assertEquals(
      (frames[0].payload?.data as { autoResumed?: boolean }).autoResumed,
      true,
    );
    // The approval's root pushes, then the resume's.
    assertEquals(rootFlushes, [1, 1]);
  });
});

Deno.test("serve root units: a detached resume whose root cannot open still ends its stream with an error and leaves the registry", async () => {
  await withRowRepos({}, async (repos) => {
    const workflow = await saveGatedWorkflow(repos.serveRepo, "gated", "gate");
    let runId: string | undefined;
    await executeWorkflowWithLocks(
      repos.a.repoDir,
      repos.a.repoContext,
      repos.a.datastoreConfig,
      {
        workflowIdOrName: workflow.name,
        inputs: {},
        instanceId: crypto.randomUUID(),
      },
      new AbortController().signal,
      (event: WorkflowRunEvent) => {
        if (event.kind === "started") runId = event.runId;
      },
      repos.a.syncService,
      undefined,
      { syncGate: undefined },
    );
    if (runId === undefined) throw new Error("the gated run never started");
    const registry = new ActiveRunRegistry();
    const ctx = serveCtx(repos, { activeRunRegistry: registry });
    const approved = await sendRequest(ctx, {
      id: crypto.randomUUID(),
      type: "workflow.approve",
      payload: { workflowIdOrName: workflow.name, runId, stepName: "gate" },
    });
    assertEquals(errorFrame(approved), undefined);

    // Launched inside an open root for the same hook, the resume's own root
    // refuses to nest, so the resume never starts.
    let terminals: BufferTerminal[] = [];
    let onTerminal: BufferTerminal | undefined;
    await runInRootUnitOfWork(
      repos.a.repoContext,
      { flush: undefined },
      async () => {
        const launched = await startDetachedResume(ctx, registry, {
          workflowIdOrName: workflow.name,
          runId,
          principalId: null,
          onTerminal: (terminal) => {
            onTerminal = terminal;
          },
        });
        assertEquals(launched.ok, true);
        if (!launched.ok) return;
        const seen: BufferTerminal[] = [];
        launched.buffer.subscribe({
          onEvent: () => {},
          onTerminal: (terminal) => seen.push(terminal),
          onDetach: () => {},
        });
        terminals = seen;
      },
    );
    await waitFor(
      () => registry.size === 0 && onTerminal !== undefined,
      "the resume left the registry",
    );

    const expected: BufferTerminal = {
      kind: "error",
      code: "workflow_resume_failed",
      message:
        "a root unit of work was opened inside another for the same hook " +
        "with its own push; give that push to the outer root, or run it " +
        "outside",
    };
    assertEquals(terminals, [expected]);
    assertEquals(onTerminal, expected);
  });
});
