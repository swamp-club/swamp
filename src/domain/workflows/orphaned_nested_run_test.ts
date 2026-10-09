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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { cancelAndSettle } from "./abort_settlement.ts";
import { NestedRunLink } from "./nested_run_link.ts";
import { nestedChain } from "./nested_run_test_helpers.ts";
import { SignalWait } from "./signal_wait.ts";
import {
  OrphanedNestedRunError,
  settleOrphanedNestedRun,
} from "./orphaned_nested_run.ts";
import { WorkflowRun } from "./workflow_run.ts";

Deno.test("NestedRunLink.parentVerdict: a run with no parent is none", async () => {
  const { chain, runs, workflowRepo } = nestedChain();
  const link = new NestedRunLink({ runRepo: runs, workflowRepo });
  assertEquals(await link.parentVerdict(chain[0]), { kind: "none" });
});

Deno.test("NestedRunLink.parentVerdict: awaited names every ancestor read, nearest first", async () => {
  const { chain, runs, workflowRepo } = nestedChain(3);
  const link = new NestedRunLink({ runRepo: runs, workflowRepo });
  const verdict = await link.parentVerdict(chain[2]);
  assert(verdict.kind === "awaited");
  assertEquals(verdict.ancestors.map((a) => a.runId), [
    chain[1].id,
    chain[0].id,
  ]);
});

Deno.test("NestedRunLink.parentVerdict: a finished parent is ended, with its status", async () => {
  const { chain, runs, workflowRepo } = nestedChain();
  cancelAndSettle(chain[0], undefined, "stop");
  runs.add(chain[0]);
  const verdict = await new NestedRunLink({ runRepo: runs, workflowRepo })
    .parentVerdict(chain[1]);
  assert(verdict.kind === "ended");
  assertEquals(verdict.parent.runId, chain[0].id);
  assertEquals(verdict.status, "cancelled");
});

Deno.test("NestedRunLink.parentVerdict: an ended grandparent decides for a grandchild whose parent still waits", async () => {
  const { chain, runs, workflowRepo } = nestedChain(3);
  cancelAndSettle(chain[0], undefined, "stop");
  runs.add(chain[0]);
  const verdict = await new NestedRunLink({ runRepo: runs, workflowRepo })
    .parentVerdict(chain[2]);
  assert(verdict.kind === "ended");
  assertEquals(verdict.parent.runId, chain[0].id);
});

Deno.test("NestedRunLink.parentVerdict: an interrupted parent still awaits", async () => {
  const { chain, runs, workflowRepo } = nestedChain();
  const interrupted = WorkflowRun.fromData({
    ...chain[0].toData(),
    status: "interrupted",
  });
  runs.add(interrupted);
  const verdict = await new NestedRunLink({ runRepo: runs, workflowRepo })
    .parentVerdict(chain[1]);
  assertEquals(verdict.kind, "awaited");
});

Deno.test("NestedRunLink.parentVerdict: a parent that has not saved its wait yet still awaits a child its step started", async () => {
  const { chain, runs, workflowRepo } = nestedChain();
  // The parent as it is before the child's suspension reaches it: running,
  // its step started and carrying no link.
  const data = chain[0].toData();
  const before = WorkflowRun.fromData({
    ...data,
    status: "running",
    jobs: data.jobs.map((job) => ({
      ...job,
      status: "running",
      steps: job.steps.map((step) => {
        const { nestedRun: _link, ...rest } = step;
        return {
          ...rest,
          status: "running",
          startedAt: new Date(0).toISOString(),
        };
      }),
    })),
  });
  runs.add(before);
  const verdict = await new NestedRunLink({ runRepo: runs, workflowRepo })
    .parentVerdict(chain[1]);
  assertEquals(verdict.kind, "awaited");
});

Deno.test("NestedRunLink.parentVerdict: a parent step that waits on another run has replaced this one", async () => {
  const { chain, runs, workflowRepo, workflows } = nestedChain();
  const data = chain[0].toData();
  const moved = WorkflowRun.fromData({
    ...data,
    jobs: data.jobs.map((job) => ({
      ...job,
      steps: job.steps.map((step) => ({
        ...step,
        nestedRun: {
          workflowId: workflows[1].id,
          workflowName: workflows[1].name,
          runId: "55555555-5555-4555-8555-555555555555",
        },
      })),
    })),
  });
  runs.add(moved);
  const verdict = await new NestedRunLink({ runRepo: runs, workflowRepo })
    .parentVerdict(chain[1]);
  assertEquals(verdict.kind, "replaced");
});

Deno.test("NestedRunLink.parentVerdict: a parent step reset since this run started has replaced it", async () => {
  const { chain, runs, workflowRepo } = nestedChain();
  const data = chain[0].toData();
  const reset = WorkflowRun.fromData({
    ...data,
    status: "running",
    jobs: data.jobs.map((job) => ({
      ...job,
      status: "running",
      steps: job.steps.map((step) => {
        const { nestedRun: _link, startedAt: _started, ...rest } = step;
        return { ...rest, status: "pending" };
      }),
    })),
  });
  runs.add(reset);
  const verdict = await new NestedRunLink({ runRepo: runs, workflowRepo })
    .parentVerdict(chain[1]);
  assertEquals(verdict.kind, "replaced");
});

Deno.test("NestedRunLink.parentVerdict: a missing or unreadable parent is unreadable, never ended", async () => {
  const missing = nestedChain();
  missing.runs.byId.delete(missing.chain[0].id.toLowerCase());
  const gone = await new NestedRunLink({
    runRepo: missing.runs,
    workflowRepo: missing.workflowRepo,
  }).parentVerdict(missing.chain[1]);
  assert(gone.kind === "unreadable");
  assertEquals(gone.missing, true);

  const broken = nestedChain();
  broken.runs.unreadable.add(broken.chain[0].id.toLowerCase());
  const failed = await new NestedRunLink({
    runRepo: broken.runs,
    workflowRepo: broken.workflowRepo,
  }).parentVerdict(broken.chain[1]);
  assert(failed.kind === "unreadable");
  assertEquals(failed.missing, undefined);
});

Deno.test("settleOrphanedNestedRun: a run with no parent, or one still awaited, continues and nothing is saved", async () => {
  const { chain, runs, workflowRepo, workflows } = nestedChain();
  const deps = { runRepo: runs, workflowRepo };
  assertEquals(
    await settleOrphanedNestedRun(deps, chain[0], workflows[0]),
    undefined,
  );
  assertEquals(
    await settleOrphanedNestedRun(deps, chain[1], workflows[1]),
    undefined,
  );
  assertEquals(runs.saved, []);
});

Deno.test("settleOrphanedNestedRun: a suspended run whose parent ended is cancelled, saved and its tracker row completed", async () => {
  const { chain, runs, workflowRepo, workflows } = nestedChain();
  cancelAndSettle(chain[0], undefined, "stop");
  runs.add(chain[0]);
  const completed: unknown[][] = [];
  const refusal = await settleOrphanedNestedRun(
    {
      runRepo: runs,
      workflowRepo,
      runTracker: { complete: (...args) => void completed.push(args) },
    },
    chain[1],
    workflows[1],
  );
  assert(refusal?.kind === "orphaned");
  assert(refusal.message.includes(chain[0].id), refusal.message);
  assert(!refusal.genericMessage.includes(chain[0].id));
  assertEquals(runs.saved, [chain[1].id]);
  const stored = runs.get(chain[1]);
  assertEquals(stored.status, "cancelled");
  assert(stored.tags["cancel_reason"].includes(chain[0].id));
  assertEquals(stored.findWaitingApprovalStep(), undefined);
  assertEquals(completed.map((c) => c.slice(0, 2)), [[
    chain[1].id,
    "cancelled",
  ]]);
});

Deno.test("settleOrphanedNestedRun: an unreadable parent refuses and writes nothing", async () => {
  const { chain, runs, workflowRepo, workflows } = nestedChain();
  runs.unreadable.add(chain[0].id.toLowerCase());
  const refusal = await settleOrphanedNestedRun(
    { runRepo: runs, workflowRepo },
    chain[1],
    workflows[1],
  );
  assertEquals(refusal?.kind, "unreadable");
  assertEquals(runs.saved, []);
  assertEquals(chain[1].status, "suspended");
});

Deno.test("settleOrphanedNestedRun: a failed run whose parent ended is left for its own retry", async () => {
  const { chain, runs, workflowRepo, workflows } = nestedChain();
  cancelAndSettle(chain[0], undefined, "stop");
  runs.add(chain[0]);
  const failed = WorkflowRun.fromData({
    ...chain[1].toData(),
    status: "failed",
  });
  assertEquals(
    await settleOrphanedNestedRun(
      { runRepo: runs, workflowRepo },
      failed,
      workflows[1],
    ),
    undefined,
  );
  assertEquals(runs.saved, []);
});

Deno.test("settleOrphanedNestedRun: an awaited verdict is confirmed against the datastore for every ancestor", async () => {
  const { chain, runs, workflowRepo, workflows } = nestedChain(3);
  const asked: string[] = [];
  const refusal = await settleOrphanedNestedRun(
    {
      runRepo: runs,
      workflowRepo,
      runRecordCurrency: (run) => {
        asked.push(run.runId);
        return Promise.resolve(true);
      },
    },
    chain[2],
    workflows[2],
  );
  assertEquals(refusal, undefined);
  assertEquals(asked, [chain[1].id, chain[0].id]);
});

Deno.test("settleOrphanedNestedRun: a parent record that is not the datastore's refuses as stale and writes nothing", async () => {
  const { chain, runs, workflowRepo, workflows } = nestedChain();
  const refusal = await settleOrphanedNestedRun(
    {
      runRepo: runs,
      workflowRepo,
      runRecordCurrency: () => Promise.resolve(false),
    },
    chain[1],
    workflows[1],
  );
  assertEquals(refusal?.kind, "stale");
  assertEquals(runs.saved, []);
  assertEquals(chain[1].status, "suspended");
});

Deno.test("settleOrphanedNestedRun: a datastore that cannot be read refuses, never taken for agreement", async () => {
  const { chain, runs, workflowRepo, workflows } = nestedChain();
  const refusal = await settleOrphanedNestedRun(
    {
      runRepo: runs,
      workflowRepo,
      runRecordCurrency: () => Promise.reject(new Error("remote down")),
    },
    chain[1],
    workflows[1],
  );
  assertEquals(refusal?.kind, "unreadable");
  assertEquals(runs.saved, []);
});

Deno.test("settleOrphanedNestedRun: an ended verdict is trusted without asking the datastore", async () => {
  const { chain, runs, workflowRepo, workflows } = nestedChain();
  cancelAndSettle(chain[0], undefined, "stop");
  runs.add(chain[0]);
  let asked = 0;
  const refusal = await settleOrphanedNestedRun(
    {
      runRepo: runs,
      workflowRepo,
      runRecordCurrency: () => {
        asked++;
        return Promise.resolve(false);
      },
    },
    chain[1],
    workflows[1],
  );
  assertEquals(refusal?.kind, "orphaned");
  assertEquals(asked, 0);
});

Deno.test("OrphanedNestedRunError: carries the refusal and a message that names no other run", () => {
  const error = new OrphanedNestedRunError({
    kind: "orphaned",
    message: "names parent run p-1",
    genericMessage: "names none",
  });
  assertEquals(error.message, "names parent run p-1");
  assertEquals(error.genericMessage, "names none");
});

Deno.test("settleOrphanedNestedRun: a parent record this host lacks is fetched before it is taken for missing", async () => {
  const { chain, runs, workflowRepo, workflows } = nestedChain();
  const parent = runs.get(chain[0]);
  runs.byId.delete(chain[0].id.toLowerCase());
  const fetched: string[] = [];
  const refusal = await settleOrphanedNestedRun(
    {
      runRepo: runs,
      workflowRepo,
      fetchMissing: (run) => {
        fetched.push(run.runId);
        runs.add(parent);
        return Promise.resolve();
      },
    },
    chain[1],
    workflows[1],
  );
  assertEquals(refusal, undefined);
  assertEquals(fetched, [chain[0].id]);
});

Deno.test("settleOrphanedNestedRun: the cancel command of an unreadable-parent refusal quotes the workflow name and names the server for a serve-owned run", async () => {
  const { chain, runs, workflowRepo, workflows } = nestedChain();
  runs.byId.delete(chain[0].id.toLowerCase());
  const odd = WorkflowRun.fromData({
    ...chain[1].toData(),
    workflowName: "odd flow; touch PWNED",
  });
  const refusal = await settleOrphanedNestedRun(
    { runRepo: runs, workflowRepo },
    odd,
    workflows[1],
  );
  assertEquals(refusal?.kind, "unreadable");
  const command =
    `'swamp workflow cancel 'odd flow; touch PWNED' --run ${odd.id}'`;
  assertStringIncludes(refusal!.message, command);
  assertStringIncludes(refusal!.genericMessage, command);

  const served = WorkflowRun.fromData({
    ...chain[1].toData(),
    instanceId: "instance-1",
  });
  const servedRefusal = await settleOrphanedNestedRun(
    { runRepo: runs, workflowRepo },
    served,
    workflows[1],
  );
  const servedCommand =
    `swamp workflow cancel ${served.workflowName} --run ${served.id} --server <url>`;
  assertStringIncludes(servedRefusal!.message, servedCommand);
  assertStringIncludes(servedRefusal!.genericMessage, servedCommand);
});

Deno.test("NestedRunLink.signalWaitsBelow: lists the waits of unfinished runs at any depth, and none below a finished or unlinked child", async () => {
  const wait = SignalWait.open({ type: "object" }, 60, new Date());
  const { chain, runs, workflowRepo } = nestedChain(3, wait);
  const link = new NestedRunLink({ runRepo: runs, workflowRepo });
  assertEquals(
    (await link.signalWaitsBelow(chain[0])).map((ref) => ref.wait?.id),
    [wait.id],
  );
  // The run's own waits are not below it.
  assertEquals(await link.signalWaitsBelow(chain[2]), []);

  // A gate holds no signal wait.
  const gated = nestedChain(3);
  assertEquals(
    await new NestedRunLink({
      runRepo: gated.runs,
      workflowRepo: gated.workflowRepo,
    }).signalWaitsBelow(gated.chain[0]),
    [],
  );

  // A finished middle run ends the walk: its child is no longer its own.
  cancelAndSettle(chain[1], undefined, "stop");
  runs.add(chain[1]);
  assertEquals(await link.signalWaitsBelow(chain[0]), []);
});
