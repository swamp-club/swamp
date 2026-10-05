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
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import type { WorkflowRunEvent } from "../src/libswamp/mod.ts";
import { executeWorkflowWithLocks } from "../src/serve/deps.ts";
import {
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
 * gate, and returns its last event kind with the run's status.
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
    const ops = observe(repos, base).ops;
    const firstPush = ops.findIndex((op) => op.startsWith("push"));
    assertEquals(ops.filter((op) => op.startsWith("push")).length, 2);
    assertEquals(
      ops.slice(0, firstPush).every((op) => op.startsWith("markDirty")),
      true,
    );
  });
});
