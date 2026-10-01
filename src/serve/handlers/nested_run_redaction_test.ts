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

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  type NamedWorkflow,
  nestedGateRefusalForClient,
  nestedPendingRefusalForClient,
  readableNestedRuns,
  redactingFor,
  redactParentRun,
  redactRunViewLinks,
  redactStreamEvent,
} from "./nested_run_redaction.ts";
import {
  NestedRunPendingError,
  type PendingNestedWait,
} from "../../domain/workflows/nested_run_link.ts";
import type { WorkflowRunView } from "../../libswamp/mod.ts";
import type { SerializedEvent } from "../protocol.ts";
import type { ConnectionContext } from "./shared.ts";

const readable = new Set(["readable-id"]);
const canRead = (w: NamedWorkflow) =>
  Promise.resolve(readable.has(w.workflowId));

Deno.test("redactParentRun: keeps a parent the principal may read, drops one it may not with what derives from it", async () => {
  const kept = {
    parentRun: { workflowId: "readable-id", workflowName: "parent" },
    parentWaiting: true,
  };
  await redactParentRun(kept, canRead);
  assertEquals(kept.parentRun.workflowName, "parent");
  assertEquals(kept.parentWaiting, true);

  const hidden: {
    parentRun?: NamedWorkflow;
    parentWaiting?: boolean;
  } = {
    parentRun: { workflowId: "secret-id", workflowName: "secret" },
    parentWaiting: true,
  };
  await redactParentRun(hidden, canRead);
  assertEquals(hidden, {});
});

Deno.test("readableNestedRuns: keeps only nested runs of readable workflows", async () => {
  const runs = [
    { workflowId: "readable-id", workflowName: "a", runId: "1" },
    { workflowId: "secret-id", workflowName: "b", runId: "2" },
  ];
  assertEquals(
    await readableNestedRuns(runs, (r) => r.workflowId, canRead),
    [runs[0]],
  );
  assertEquals(
    await readableNestedRuns([runs[1]], (r) => r.workflowId, canRead),
    undefined,
  );
  assertEquals(
    await readableNestedRuns(
      undefined,
      (r: typeof runs[0]) => r.workflowId,
      canRead,
    ),
    undefined,
  );
});

/**
 * A suspended run of a readable workflow whose parent, nested wait and
 * waiting step all name a workflow the principal may not read.
 */
function linkedView(childId = "secret-id"): WorkflowRunView {
  return {
    id: "run-1",
    workflowId: "readable-id",
    workflowName: "visible",
    status: "suspended",
    parentRun: {
      workflowId: "secret-id",
      workflowName: "secret-parent",
      runId: "parent-run",
      stepName: "call",
    },
    nestedWaits: [{
      workflowId: childId,
      workflowName: "secret-child",
      runId: "child-run",
      stepName: "call-child",
    }],
    jobs: [{
      name: "main",
      status: "failed",
      steps: [{
        name: "call-child",
        status: "failed",
        error:
          'Detached: the run ended while this step waited on run child-run of nested workflow "secret-child".',
        nestedRun: {
          workflowId: childId,
          workflowName: "secret-child",
          runId: "child-run",
          detached: true,
        },
      }],
    }],
  };
}

Deno.test("redactRunViewLinks: drops links to unreadable workflows and the step error that names the nested run", async () => {
  const view = linkedView();
  await redactRunViewLinks(view, canRead);
  assertEquals(view.parentRun, undefined);
  assertEquals(view.nestedWaits, undefined);
  const step = view.jobs[0].steps[0];
  assertEquals(step.nestedRun, undefined);
  assert(!step.error!.includes("secret-child"));
  assert(!step.error!.includes("child-run"));
});

Deno.test("redactRunViewLinks: keeps a nested run, and its step error, when its workflow is readable", async () => {
  const view = linkedView("readable-id");
  await redactRunViewLinks(view, canRead);
  assertEquals(view.nestedWaits?.length, 1);
  const step = view.jobs[0].steps[0];
  assertEquals(step.nestedRun?.runId, "child-run");
  assert(step.error!.includes("secret-child"));
});

Deno.test("redactStreamEvent: redacts a copy of a run view event, leaving the buffered event as it was", async () => {
  const event: SerializedEvent = { kind: "completed", run: linkedView() };
  const before = structuredClone(event);
  const visible = await redactStreamEvent(event, canRead);
  assertEquals(event, before);
  const run = visible.run as WorkflowRunView;
  assertEquals(run.parentRun, undefined);
  assertEquals(run.jobs[0].steps[0].nestedRun, undefined);
});

Deno.test("redactStreamEvent: a suspension drops its nested block with the waiting step's link", async () => {
  const suspended = (childId: string): SerializedEvent => ({
    kind: "suspended",
    run: linkedView(childId),
    jobId: "main",
    stepId: "call-child",
    prompt: "",
    nested: { workflowName: "secret-child", runId: "child-run" },
  });
  const hidden = await redactStreamEvent(suspended("secret-id"), canRead);
  assertEquals(hidden.nested, undefined);
  const shown = await redactStreamEvent(suspended("readable-id"), canRead);
  assertEquals(shown.nested, {
    workflowName: "secret-child",
    runId: "child-run",
  });
});

Deno.test("redactStreamEvent: keeps only the detached nested runs a superseding stream may name", async () => {
  const detached = [
    { workflowId: "readable-id", workflowName: "a", runId: "1" },
    { workflowId: "secret-id", workflowName: "b", runId: "2" },
  ];
  const visible = await redactStreamEvent({
    kind: "superseded_runs",
    cancelledRunIds: ["old"],
    detachedNestedRuns: detached,
  }, canRead);
  assertEquals(visible.detachedNestedRuns, [detached[0]]);
  assertEquals(visible.cancelledRunIds, ["old"]);

  const none = await redactStreamEvent({
    kind: "superseded_runs",
    cancelledRunIds: ["old"],
    detachedNestedRuns: [detached[1]],
  }, canRead);
  assertEquals("detachedNestedRuns" in none, false);
});

Deno.test("redactStreamEvent: hides a nested step's failure that names a run the principal may not read", async () => {
  const failed = (workflowId: string): SerializedEvent => ({
    kind: "step_failed",
    jobId: "main",
    stepId: "call-child",
    error:
      'Approval of step "gate" in nested run child-run of workflow "secret-child" was rejected.',
    nestedRun: { workflowId, workflowName: "secret-child" },
  });
  const event = failed("secret-id");
  const hidden = await redactStreamEvent(event, canRead);
  assertEquals(hidden.nestedRun, undefined);
  assert(!String(hidden.error).includes("secret-child"));
  assertEquals(hidden.stepId, "call-child");
  assertEquals(event, failed("secret-id"));

  const shown = failed("readable-id");
  assertStrictEquals(await redactStreamEvent(shown, canRead), shown);
});

Deno.test("redactStreamEvent: passes an event without links through unchanged", async () => {
  const event: SerializedEvent = { kind: "step_started", jobId: "j" };
  assertStrictEquals(await redactStreamEvent(event, canRead), event);
});

Deno.test("nestedGateRefusalForClient: names the nested run only to a reader of its workflow", async () => {
  const refusal = (workflowId: string) => ({
    code: "validation_failed",
    message: 'waits on nested run r-1 of workflow "secret-child"',
    details: {
      nestedWaitGate: {
        workflowId,
        workflowName: "secret-child",
        genericMessage: "waits on a nested workflow run",
      },
    },
  });
  assertEquals(
    await nestedGateRefusalForClient(refusal("secret-id"), canRead),
    "waits on a nested workflow run",
  );
  assertEquals(
    await nestedGateRefusalForClient(refusal("readable-id"), canRead),
    'waits on nested run r-1 of workflow "secret-child"',
  );
  assertEquals(
    await nestedGateRefusalForClient(
      { code: "validation_failed", message: "other" },
      canRead,
    ),
    undefined,
  );
});

/** A refusal naming a direct child and, through it, the run that has to act. */
function pendingRefusal(
  childId: string,
  targetId: string,
): NestedRunPendingError {
  const pending = {
    child: { workflowId: childId, workflowName: "child" },
    action: {
      kind: "resume",
      target: {
        workflowId: targetId,
        workflowName: "grandchild",
        runId: "g-1",
        serveOwned: false,
      },
    },
  } as unknown as PendingNestedWait;
  return new NestedRunPendingError(
    { workflowName: "parent", id: "p-1" },
    [pending],
  );
}

Deno.test("nestedPendingRefusalForClient: names the nested runs only when every one is readable", async () => {
  const all = pendingRefusal("readable-id", "readable-id");
  assertEquals(await nestedPendingRefusalForClient(all, canRead), all.message);
  for (
    const error of [
      pendingRefusal("secret-id", "readable-id"),
      pendingRefusal("readable-id", "secret-id"),
    ]
  ) {
    assertEquals(
      await nestedPendingRefusalForClient(error, canRead),
      error.genericMessage,
    );
  }
  assertEquals(
    await nestedPendingRefusalForClient(all, undefined),
    all.genericMessage,
  );
});

Deno.test("redactingFor: leaves the stream alone when serve runs without auth", () => {
  const ctx = { authConfig: { mode: "none" } } as unknown as ConnectionContext;
  assertEquals(redactingFor(ctx, {} as WebSocket, null), undefined);
});
