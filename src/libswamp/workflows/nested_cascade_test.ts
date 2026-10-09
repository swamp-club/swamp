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

import { assert, assertEquals } from "@std/assert";
import { ActiveRun } from "../../domain/models/active_run.ts";
import type { RunTrackerRepository } from "../../domain/models/run_tracker_repository.ts";
import { cancelAndSettle } from "../../domain/workflows/abort_settlement.ts";
import {
  type NestedChain,
  nestedChain,
} from "../../domain/workflows/nested_run_test_helpers.ts";
import { MAX_WORKFLOW_NESTING_DEPTH } from "../../domain/workflows/nested_run_ref.ts";
import {
  unclaimedRuns,
  type WorkflowRunClaims,
} from "../../domain/workflows/run_claim.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import {
  createNestedCascade,
  type NestedCascadeDeps,
  nestedCascadeFields,
  settleNestedRunsOf,
} from "./nested_cascade.ts";

const HOST = "test-host";

/** The chain with its top run cancelled and stored, as a cancel leaves it. */
function endedChain(levels = 2): NestedChain & { ended: WorkflowRun } {
  const built = nestedChain(levels);
  cancelAndSettle(built.chain[0], undefined, "stop");
  built.runs.add(built.chain[0]);
  return { ...built, ended: built.chain[0] };
}

function depsOf(
  built: NestedChain,
  extra: Partial<NestedCascadeDeps> = {},
): NestedCascadeDeps {
  return {
    workflowRepo: built.workflowRepo,
    runRepo: built.runs,
    runClaims: unclaimedRuns,
    findEvaluatedWorkflow: () => Promise.resolve(null),
    ...extra,
  };
}

/** A tracker holding one row, and recording what is completed. */
function trackerWith(
  row: ActiveRun | null,
): RunTrackerRepository & { completed: string[] } {
  const completed: string[] = [];
  const tracker = {
    completed,
    findById: (id: string) => (row && row.id === id ? row : null),
    complete: (id: string) => void completed.push(id),
  };
  return tracker as unknown as RunTrackerRepository & { completed: string[] };
}

Deno.test("createNestedCascade: cancels the suspended child and the runs below it, each named with its parent", async () => {
  const built = endedChain(3);
  const tracker = trackerWith(null);
  const result = await createNestedCascade(
    depsOf(built, { runTracker: tracker }),
  )(built.ended);

  assertEquals(result.cancelledNestedRuns.map((r) => r.runId), [
    built.chain[1].id,
    built.chain[2].id,
  ]);
  assertEquals(result.stopRequestedNestedRuns, []);
  assertEquals(result.detachedNestedRuns, []);
  const child = built.runs.get(built.chain[1]);
  const grandchild = built.runs.get(built.chain[2]);
  assertEquals(child.status, "cancelled");
  assertEquals(grandchild.status, "cancelled");
  assert(child.tags["cancel_reason"].includes(built.ended.id));
  assert(grandchild.tags["cancel_reason"].includes(built.chain[1].id));
  assertEquals(grandchild.findWaitingApprovalStep(), undefined);
  assertEquals(tracker.completed, [built.chain[1].id, built.chain[2].id]);
  // The ended parent is never written.
  assert(!built.runs.saved.includes(built.ended.id));
});

Deno.test("createNestedCascade: a parent that waited on nothing reports nothing", async () => {
  const built = nestedChain();
  const result = await createNestedCascade(depsOf(built))(built.chain[1]);
  assertEquals(nestedCascadeFields(result), {});
});

Deno.test("createNestedCascade: a finished or missing child needs no cancel", async () => {
  const finished = endedChain();
  cancelAndSettle(finished.chain[1], undefined, "already");
  finished.runs.add(finished.chain[1]);
  assertEquals(
    nestedCascadeFields(
      await createNestedCascade(depsOf(finished))(finished.ended),
    ),
    {},
  );

  const missing = endedChain();
  missing.runs.byId.delete(missing.chain[1].id.toLowerCase());
  assertEquals(
    nestedCascadeFields(
      await createNestedCascade(depsOf(missing))(missing.ended),
    ),
    {},
  );
  assertEquals(missing.runs.saved, []);
});

Deno.test("createNestedCascade: a run that does not link back is left and reported", async () => {
  const built = endedChain();
  const back = built.chain[1].parentRun;
  assert(back?.kind === "valid");
  built.runs.add(WorkflowRun.fromData({
    ...built.chain[1].toData(),
    parentRun: { ...back.ref, runId: "55555555-5555-4555-8555-555555555555" },
  }));
  const result = await createNestedCascade(depsOf(built))(built.ended);
  assertEquals(result.cancelledNestedRuns, []);
  assertEquals(result.detachedNestedRuns.map((r) => r.runId), [
    built.chain[1].id,
  ]);
  assertEquals(built.runs.saved, []);
  assertEquals(built.runs.get(built.chain[1]).status, "suspended");
});

Deno.test("createNestedCascade: a suspended child whose owner still runs is left, judged by its tracker row", async () => {
  const built = endedChain();
  const row = ActiveRun.createWorkflowRun({
    id: built.chain[1].id,
    workflowName: "wf-1",
    pid: 4242,
    hostname: HOST,
  });
  const result = await createNestedCascade(depsOf(built, {
    runTracker: trackerWith(row),
    liveness: { hostname: HOST, isDead: () => false },
  }))(built.ended);
  assertEquals(result.cancelledNestedRuns, []);
  assertEquals(result.detachedNestedRuns.length, 1);
  assertEquals(built.runs.saved, []);
});

Deno.test("createNestedCascade: a suspended child whose tracked owner is dead is cancelled", async () => {
  const built = endedChain();
  const row = ActiveRun.createWorkflowRun({
    id: built.chain[1].id,
    workflowName: "wf-1",
    pid: 4242,
    hostname: HOST,
  });
  const result = await createNestedCascade(depsOf(built, {
    runTracker: trackerWith(row),
    liveness: { hostname: HOST, isDead: () => true },
  }))(built.ended);
  assertEquals(result.cancelledNestedRuns.length, 1);
});

Deno.test("createNestedCascade: a child the caller may not settle is left with the command that cancels it", async () => {
  const built = endedChain();
  built.runs.add(WorkflowRun.fromData({
    ...built.chain[1].toData(),
    instanceId: "instance-1",
  }));
  const result = await createNestedCascade(depsOf(built, {
    maySettle: (child) => child.instanceId === undefined,
  }))(built.ended);
  assertEquals(result.cancelledNestedRuns, []);
  assertEquals(
    result.detachedNestedRuns[0].cancelCommand,
    `swamp workflow cancel wf-1 --run ${built.chain[1].id} --server <url>`,
  );
  assertEquals(built.runs.saved, []);
});

Deno.test("createNestedCascade: a running child is asked to stop when something here drives it, else left", async () => {
  const running = (built: NestedChain) =>
    built.runs.add(WorkflowRun.fromData({
      ...built.chain[1].toData(),
      status: "running",
    }));

  const driven = endedChain();
  running(driven);
  const asked: string[] = [];
  const stopping = await createNestedCascade(depsOf(driven, {
    requestStop: (child, reason) => {
      asked.push(`${child.id}:${reason}`);
      return true;
    },
  }))(driven.ended);
  assertEquals(stopping.stopRequestedNestedRuns.map((r) => r.runId), [
    driven.chain[1].id,
  ]);
  assertEquals(stopping.detachedNestedRuns, []);
  assert(asked[0].includes(driven.ended.id));
  assertEquals(driven.runs.saved, []);

  const elsewhere = endedChain();
  running(elsewhere);
  const left = await createNestedCascade(depsOf(elsewhere, {
    requestStop: () => false,
  }))(elsewhere.ended);
  assertEquals(left.stopRequestedNestedRuns, []);
  assertEquals(left.detachedNestedRuns.length, 1);

  const noPort = endedChain();
  running(noPort);
  const reported = await createNestedCascade(depsOf(noPort))(noPort.ended);
  assertEquals(reported.detachedNestedRuns.length, 1);
});

Deno.test("createNestedCascade: a child whose id is reserved is left, and a reservation taken is released", async () => {
  const busy = endedChain();
  const left = await createNestedCascade(depsOf(busy, {
    reserveChild: () => null,
  }))(busy.ended);
  assertEquals(left.cancelledNestedRuns, []);
  assertEquals(left.detachedNestedRuns.length, 1);
  assertEquals(busy.runs.saved, []);

  const free = endedChain();
  const events: string[] = [];
  await createNestedCascade(depsOf(free, {
    reserveChild: (runId) => {
      events.push(`reserve:${runId}`);
      return () => void events.push(`release:${runId}`);
    },
  }))(free.ended);
  assertEquals(events, [
    `reserve:${free.chain[1].id}`,
    `release:${free.chain[1].id}`,
  ]);
});

Deno.test("createNestedCascade: a child whose record is not the datastore's is left", async () => {
  const built = endedChain();
  const result = await createNestedCascade(depsOf(built, {
    runRecordCurrency: () => Promise.resolve(false),
  }))(built.ended);
  assertEquals(result.cancelledNestedRuns, []);
  assertEquals(result.detachedNestedRuns.length, 1);
  assertEquals(built.runs.saved, []);
});

Deno.test("createNestedCascade: a child that changed before its claim is read again and left", async () => {
  const built = endedChain();
  // An approver resumes the child between the listing and the claim.
  const claims: WorkflowRunClaims = {
    withClaim: (runId, fn) => {
      built.runs.add(WorkflowRun.fromData({
        ...built.runs.get({ id: runId }).toData(),
        status: "running",
      }));
      return fn();
    },
  };
  const result = await createNestedCascade(
    depsOf(built, { runClaims: claims }),
  )(built.ended);
  assertEquals(result.cancelledNestedRuns, []);
  assertEquals(result.detachedNestedRuns.length, 1);
  assertEquals(built.runs.saved, []);
});

Deno.test("createNestedCascade: a save that fails leaves the child reported and does not throw", async () => {
  const built = endedChain();
  const result = await createNestedCascade(depsOf(built, {
    runRepo: {
      findById: (w, r) => built.runs.findById(w, r),
      save: () => Promise.reject(new Error("disk full")),
    },
  }))(built.ended);
  assertEquals(result.cancelledNestedRuns, []);
  assertEquals(result.detachedNestedRuns.map((r) => r.runId), [
    built.chain[1].id,
  ]);
});

Deno.test("createNestedCascade: fetches a child record before reading it", async () => {
  const built = endedChain();
  const fetched: string[] = [];
  await createNestedCascade(depsOf(built, {
    fetchMissing: (run) => {
      fetched.push(run.runId);
      return Promise.resolve();
    },
  }))(built.ended);
  assertEquals(fetched, [built.chain[1].id]);
});

Deno.test("createNestedCascade: stops at the nesting depth bound", async () => {
  const levels = MAX_WORKFLOW_NESTING_DEPTH + 2;
  const built = endedChain(levels);
  const result = await createNestedCascade(depsOf(built))(built.ended);
  assertEquals(
    result.cancelledNestedRuns.length,
    MAX_WORKFLOW_NESTING_DEPTH,
  );
  // The run below the bound is left as it was.
  assertEquals(built.runs.get(built.chain[levels - 1]).status, "suspended");
});

Deno.test("settleNestedRunsOf: without a cascade the children are only reported", async () => {
  const built = endedChain();
  const result = await settleNestedRunsOf(
    { runRepo: built.runs },
    undefined,
    built.ended,
  );
  assertEquals(result.cancelledNestedRuns, []);
  assertEquals(result.detachedNestedRuns.map((r) => r.runId), [
    built.chain[1].id,
  ]);
  assertEquals(built.runs.saved, []);
});
