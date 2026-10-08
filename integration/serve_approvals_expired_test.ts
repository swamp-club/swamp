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
 * Expired approval gates listed through `swamp serve` (swamp-club#3045):
 * `workflow.approvals` returns an `expired` list beside `approvals`, and
 * each list is filtered on the complete fields of every row's workflow.
 * Requests go through `handleMessage`, the real dispatch path, against a
 * real repository.
 */

import { assertEquals } from "@std/assert";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { createWorkflowRunId } from "../src/domain/workflows/workflow_id.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import {
  createServeCtx,
  errorFrame,
  grant,
  sendRequest,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";

await initializeLogging({});

const GATE = "gate";
const HOUR_SECONDS = 3600;

interface ParentLink {
  workflowId: string;
  workflowName: string;
  runId: string;
}

/**
 * Saves a workflow whose one step is a gate with a one-hour timeout and runs
 * it through serve, with authorization off, until it suspends. With
 * `expired`, the gate's start is then moved two hours into the past.
 */
async function suspendAtGate(
  repo: ServeRepo,
  options: {
    expired: boolean;
    tags?: Record<string, string>;
    parent?: ParentLink;
  },
): Promise<{ workflow: Workflow; runId: string }> {
  const workflow = Workflow.create({
    name: `gated-${crypto.randomUUID().slice(0, 8)}`,
    tags: options.tags ?? {},
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: GATE,
            task: StepTask.manualApproval("Ship it?", HOUR_SECONDS),
          }),
        ],
      }),
    ],
  });
  await repo.repoContext.workflowRepo.save(workflow);
  const frames = await sendRequest(createServeCtx(repo), {
    type: "workflow.run",
    id: `run-${crypto.randomUUID()}`,
    payload: { workflowIdOrName: workflow.name },
  }, null);
  assertEquals(errorFrame(frames), undefined, JSON.stringify(frames));
  const runRepo = repo.repoContext.workflowRunRepo;
  const suspended = await runRepo.findSummariesByStatus(
    workflow.id,
    "suspended",
  );
  assertEquals(suspended.length, 1, JSON.stringify(frames));
  const run = await runRepo.findById(
    workflow.id,
    createWorkflowRunId(suspended[0].id),
  );

  const data = run!.toData();
  if (options.expired) {
    const twoHoursAgo = new Date(Date.now() - 2 * HOUR_SECONDS * 1000)
      .toISOString();
    for (const job of data.jobs) {
      for (const step of job.steps) step.startedAt = twoHoursAgo;
    }
  }
  if (options.parent) {
    data.parentRun = {
      ...options.parent,
      jobName: "main",
      stepName: "call-child",
      nestingDepth: 1,
      ancestorWorkflowNames: [],
    };
  }
  await runRepo.save(workflow.id, WorkflowRun.fromData(data));
  return { workflow, runId: run!.id };
}

interface Row {
  workflowName: string;
  runId: string;
  parentRun?: { workflowName: string };
  parentWaiting?: boolean;
}

async function approvals(
  ctx: ConnectionContext,
): Promise<{ keys: string[]; approvals: Row[]; expired: Row[] }> {
  const frames = await sendRequest(ctx, {
    type: "workflow.approvals",
    id: `approvals-${crypto.randomUUID()}`,
  });
  assertEquals(errorFrame(frames), undefined, JSON.stringify(frames));
  const frame = frames.find((f) => f.type === "workflow.approvals");
  const data = frame!.payload!.data as { approvals: Row[]; expired: Row[] };
  return { keys: Object.keys(data), ...data };
}

function workflowGrant(
  actions: Grant["actions"],
  pattern = "*",
  effect: Grant["effect"] = "allow",
): Grant {
  return grant({ actions, effect, resource: { kind: "workflow", pattern } });
}

const runIds = (rows: Row[]) => rows.map((row) => row.runId).sort();

const opts = { sanitizeOps: false, sanitizeResources: false };

Deno.test({
  name:
    "serve approvals: an expired gate is listed under expired, after approvals, and not as pending",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const open = await suspendAtGate(repo, { expired: false });
      const stale = await suspendAtGate(repo, { expired: true });

      const listed = await approvals(createServeCtx(repo));

      // Dashboards older than the expired list read the first array.
      assertEquals(listed.keys, ["approvals", "expired"]);
      assertEquals(runIds(listed.approvals), [open.runId]);
      assertEquals(runIds(listed.expired), [stale.runId]);
    });
  },
});

Deno.test({
  name:
    "serve approvals: gates of a workflow the caller may not read are withheld from both lists",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const openSeen = await suspendAtGate(repo, { expired: false });
      const staleSeen = await suspendAtGate(repo, { expired: true });
      const openHidden = await suspendAtGate(repo, { expired: false });
      const staleHidden = await suspendAtGate(repo, { expired: true });
      const ctx = createServeCtx(repo, [
        workflowGrant(["read"], openSeen.workflow.name),
        workflowGrant(["read"], staleSeen.workflow.name),
      ]);

      const listed = await approvals(ctx);

      assertEquals(runIds(listed.approvals), [openSeen.runId]);
      assertEquals(runIds(listed.expired), [staleSeen.runId]);
      const all = JSON.stringify(listed);
      assertEquals(all.includes(openHidden.runId), false);
      assertEquals(all.includes(staleHidden.runId), false);
      assertEquals(all.includes(staleHidden.workflow.name), false);
    });
  },
});

Deno.test({
  name:
    "serve approvals: a deny on the workflow's tags leaves its gates out of both lists",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const prod = { env: "prod" };
      const openDev = await suspendAtGate(repo, { expired: false });
      const staleDev = await suspendAtGate(repo, { expired: true });
      await suspendAtGate(repo, { expired: false, tags: prod });
      await suspendAtGate(repo, { expired: true, tags: prod });
      const ctx = createServeCtx(repo, [
        workflowGrant(["read"]),
        {
          ...workflowGrant(["read"], "*", "deny"),
          condition: 'tags.env == "prod"',
        },
      ]);

      const listed = await approvals(ctx);

      assertEquals(runIds(listed.approvals), [openDev.runId]);
      assertEquals(runIds(listed.expired), [staleDev.runId]);
    });
  },
});

Deno.test({
  name:
    "serve approvals: an expired nested run names its parent only to a reader of the parent's workflow",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const parent = await suspendAtGate(repo, { expired: false });
      const child = await suspendAtGate(repo, {
        expired: true,
        parent: {
          workflowId: parent.workflow.id,
          workflowName: parent.workflow.name,
          runId: parent.runId,
        },
      });

      const childOnly = await approvals(
        createServeCtx(repo, [workflowGrant(["read"], child.workflow.name)]),
      );
      assertEquals(runIds(childOnly.expired), [child.runId]);
      assertEquals("parentRun" in childOnly.expired[0], false);
      assertEquals("parentWaiting" in childOnly.expired[0], false);
      assertEquals(
        JSON.stringify(childOnly).includes(parent.workflow.name),
        false,
      );

      const both = await approvals(
        createServeCtx(repo, [workflowGrant(["read"])]),
      );
      assertEquals(
        both.expired[0].parentRun?.workflowName,
        parent.workflow.name,
      );
      assertEquals(both.expired[0].parentWaiting, false);
    });
  },
});
