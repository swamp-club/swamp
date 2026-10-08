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
import fc from "fast-check";
import {
  continueAfterSignal,
  deliverSignalForCaller,
  SIGNAL_WAIT_NOT_FOUND_MESSAGE,
  type SignalDeliveryResult,
} from "./signal_delivery.ts";
import type { AccessCaller, ConnectionContext } from "./handlers/shared.ts";
import { ActiveRunRegistry } from "./active_run_registry.ts";
import type { MergedServeOptions } from "./serve_config.ts";
import type { Grant } from "../domain/models/access/grant_model.ts";
import { type Action, ActionSchema } from "../domain/access/action.ts";
import { GrantBasedAccessDecisionService } from "../domain/access/grant_based_access_decision_service.ts";
import { PolicySnapshot } from "../domain/access/policy_snapshot.ts";
import { Workflow } from "../domain/workflows/workflow.ts";
import { WorkflowRun } from "../domain/workflows/workflow_run.ts";
import { Job } from "../domain/workflows/job.ts";
import { Step } from "../domain/workflows/step.ts";
import { StepTask } from "../domain/workflows/step_task.ts";
import { SignalWait } from "../domain/workflows/signal_wait.ts";
import {
  encodeWaitRecord,
  registrationOf,
} from "../domain/workflows/signal_wait_records.ts";
import { InMemorySignalWaitStore } from "../domain/workflows/signal_wait_store_test_helpers.ts";

const SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  required: ["verdict"],
  properties: { verdict: { type: "string" as const, enum: ["ship", "fix"] } },
};

const UNKNOWN_WAIT = "00000000-0000-4000-8000-000000000000";
const CALLER_ID = "caller";

function waitingWorkflow(name: string, id?: string): Workflow {
  return Workflow.create({
    ...(id ? { id } : {}),
    name,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "review",
            task: StepTask.waitForSignal(3600, SCHEMA),
          }),
        ],
      }),
    ],
  });
}

interface Fixture {
  workflow: Workflow;
  run: WorkflowRun;
  waitId: string;
  waits: InMemorySignalWaitStore;
  /** The run records this host has; clear it to lose them. */
  runs: Map<string, WorkflowRun>;
  /** The workflows this host has; clear it to delete them. */
  workflows: Map<string, Workflow>;
  ctxWith(grants: Grant[]): ConnectionContext;
}

/** A run suspended on a registered wait, opened a moment ago. */
async function fixture(name = "release"): Promise<Fixture> {
  const workflow = waitingWorkflow(name);
  const run = WorkflowRun.create(workflow);
  run.start();
  const job = run.getJob("main")!;
  job.start();
  const step = job.getStep("review")!;
  step.start();
  const wait = SignalWait.open(SCHEMA, 3600, new Date());
  step.waitForSignal(wait);
  run.suspend();

  const waits = new InMemorySignalWaitStore();
  await waits.register(
    registrationOf(
      {
        workflowId: run.workflowId,
        workflowName: run.workflowName,
        runId: run.id,
        jobName: "main",
        stepName: "review",
      },
      wait,
      new Date(),
    ),
  );
  const runs = new Map([[run.id as string, run]]);
  const workflows = new Map([[workflow.name, workflow]]);
  const repoContext = {
    workflowRunRepo: {
      // Runs are stored per workflow, as in the real repository: a run is
      // found only under the workflow it belongs to.
      findById: (workflowId: string, runId: string) => {
        const found = runs.get(runId);
        return Promise.resolve(
          found && found.workflowId === workflowId ? found : null,
        );
      },
      findGlobalByStatus: () => {
        throw new Error("serve must not scan run records for a signal");
      },
      findAllGlobal: () => {
        throw new Error("serve must not scan run records for a signal");
      },
    },
    workflowRepo: {
      findByName: (n: string) => Promise.resolve(workflows.get(n) ?? null),
      findById: (id: string) =>
        Promise.resolve(
          [...workflows.values()].find((w) => w.id === id) ?? null,
        ),
    },
    signalWaits: { supported: true, store: waits },
  };
  return {
    workflow,
    run,
    waitId: wait.id,
    waits,
    runs,
    workflows,
    ctxWith: (grants) =>
      ({
        authConfig: { mode: "token" },
        policySnapshotLoader: {
          decisionService: new GrantBasedAccessDecisionService(
            new PolicySnapshot(grants, []),
          ),
        },
        repoContext,
      }) as unknown as ConnectionContext,
  };
}

function grantOf(
  actions: Action[],
  pattern = "*",
  effect: Grant["effect"] = "allow",
): Grant {
  return {
    id: crypto.randomUUID(),
    subject: { kind: "user", name: CALLER_ID },
    effect,
    actions,
    resource: { kind: "workflow", pattern },
    state: "active",
    source: "method",
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
  };
}

const CALLER: AccessCaller = {
  principal: { kind: "user", id: CALLER_ID },
  collectives: [],
  groups: [],
  sourceIp: "203.0.113.7",
};

function deliver(
  ctx: ConnectionContext,
  waitId: string,
  payload: unknown = { verdict: "ship" },
): Promise<SignalDeliveryResult> {
  return deliverSignalForCaller(ctx, CALLER, {
    requestId: "req-1",
    waitId,
    payload,
  });
}

const NOT_FOUND: SignalDeliveryResult = {
  status: "not_found",
  message: SIGNAL_WAIT_NOT_FOUND_MESSAGE,
};

Deno.test("deliverSignalForCaller: delivers and records the principal as the sender", async () => {
  const f = await fixture();
  const result = await deliver(f.ctxWith([grantOf(["signal"])]), f.waitId);

  assert(result.status === "delivered");
  assertEquals(result.data.signal.submittedBy, "user:caller");
  assertEquals(result.data.workflowName, undefined);
  const outcome = await f.waits.findOutcome(f.waitId);
  assert(outcome.kind === "found" && outcome.record.kind === "accepted");
  assertEquals(outcome.record.payload, { verdict: "ship" });
});

Deno.test("deliverSignalForCaller: a wait ID in another spelling reaches the same wait", async () => {
  const f = await fixture();
  const result = await deliver(
    f.ctxWith([grantOf(["signal"])]),
    `  ${f.waitId.toUpperCase()} `,
  );
  assertEquals(result.status, "delivered");
});

Deno.test("deliverSignalForCaller: text that is not a wait ID is not found and reads nothing", async () => {
  const f = await fixture();
  for (const waitId of ["", "review", "../../waits/x", `${f.waitId}/..`]) {
    assertEquals(
      await deliver(f.ctxWith([grantOf(["signal"])]), waitId),
      NOT_FOUND,
    );
  }
});

Deno.test("deliverSignalForCaller: a refused caller stores nothing", async () => {
  const f = await fixture();
  assertEquals(
    await deliver(f.ctxWith([grantOf(["read"])]), f.waitId),
    NOT_FOUND,
  );
  assertEquals((await f.waits.findOutcome(f.waitId)).kind, "absent");
});

Deno.test("deliverSignalForCaller: a registration whose workflow name was changed is refused", async () => {
  const f = await fixture("restricted");
  const allowed = waitingWorkflow("open");
  f.workflows.set(allowed.name, allowed);
  // Someone with write access to the store renames the wait's workflow to
  // one the caller may signal. The run, found under the unchanged workflow
  // ID, still records the name it belongs to.
  const stored = await f.waits.findRegistration(f.waitId);
  assert(stored.kind === "found");
  f.waits.registrations.set(
    f.waitId,
    encodeWaitRecord({ ...stored.record, workflowName: allowed.name }),
  );
  const ctx = f.ctxWith([grantOf(["signal", "read"], "open")]);

  assertEquals(await deliver(ctx, f.waitId), NOT_FOUND);
  assertEquals((await f.waits.findOutcome(f.waitId)).kind, "absent");
});

Deno.test("deliverSignalForCaller: a registration whose workflow ID was changed is not detected", async () => {
  const f = await fixture("restricted");
  const allowed = waitingWorkflow("open");
  f.workflows.set(allowed.name, allowed);
  // The limit of the check above, pinned so it is not mistaken for a
  // guarantee: with the ID changed too, the run is looked for under the
  // other workflow and not found, so the registration is all there is to
  // go on and the caller is authorized against the workflow it names.
  // Whoever can rewrite a registration can also create the outcome record
  // directly, so this path gives them nothing they did not have.
  const stored = await f.waits.findRegistration(f.waitId);
  assert(stored.kind === "found");
  f.waits.registrations.set(
    f.waitId,
    encodeWaitRecord({
      ...stored.record,
      workflowId: allowed.id,
      workflowName: allowed.name,
    }),
  );
  const ctx = f.ctxWith([grantOf(["signal", "read"], "open")]);

  const result = await deliver(ctx, f.waitId);

  assert(result.status === "delivered", JSON.stringify(result));
  assertEquals(result.data.workflowName, "open");
  assertEquals(result.data.runRecordAvailable, false);
});

Deno.test("deliverSignalForCaller: without the run record a signal is still delivered, and says so to a reader", async () => {
  const f = await fixture();
  f.runs.clear();

  const result = await deliver(
    f.ctxWith([grantOf(["signal", "read"])]),
    f.waitId,
  );

  assert(result.status === "delivered");
  assertEquals(result.data.runRecordAvailable, false);
  assertEquals(result.data.awaitingResume, false);
});

Deno.test("deliverSignalForCaller: a wait with only its outcome left is authorized by workflow id", async () => {
  const f = await fixture();
  assertEquals(
    (await deliver(f.ctxWith([grantOf(["signal"])]), f.waitId)).status,
    "delivered",
  );
  await f.waits.removeRegistration(f.waitId);
  f.runs.clear();

  assertEquals(
    await deliver(f.ctxWith([grantOf(["read"])]), f.waitId),
    NOT_FOUND,
  );
  const blind = await deliver(f.ctxWith([grantOf(["signal"])]), f.waitId);
  assertEquals(blind, {
    status: "already_settled",
    message: "The wait is already settled.",
  });
  const seen = await deliver(
    f.ctxWith([grantOf(["signal", "read"])]),
    f.waitId,
  );
  assert(seen.status === "already_settled" && seen.receipt !== undefined);

  // With its workflow deleted too, nothing ties the wait to a grant.
  f.workflows.clear();
  assertEquals(
    await deliver(f.ctxWith([grantOf(["signal", "read"])]), f.waitId),
    NOT_FOUND,
  );
});

Deno.test("deliverSignalForCaller: a renamed workflow's settled wait stays closed to a caller denied the recorded name, after its registration is removed", async () => {
  const f = await fixture("restricted");
  assertEquals(
    (await deliver(f.ctxWith([grantOf(["signal"])]), f.waitId)).status,
    "delivered",
  );
  // The workflow is renamed after the run recorded its name.
  f.workflows.clear();
  f.workflows.set("open", waitingWorkflow("open", f.workflow.id));
  const denied = f.ctxWith([
    grantOf(["signal", "read"], "open"),
    grantOf(["signal", "read"], "restricted", "deny"),
  ]);
  const both = f.ctxWith([grantOf(["signal", "read"])]);

  assertEquals(await deliver(denied, f.waitId), NOT_FOUND);

  // The run ended and its registration was removed; the run record is kept.
  await f.waits.removeRegistration(f.waitId);

  assertEquals(await deliver(denied, f.waitId), NOT_FOUND);
  const seen = await deliver(both, f.waitId);
  assert(seen.status === "already_settled" && seen.receipt !== undefined);
});

Deno.test("deliverSignalForCaller: a wait this host cannot place is not found, without scanning runs", async () => {
  const f = await fixture();
  await f.waits.removeRegistration(f.waitId);
  // The fixture's run repository throws if it is scanned.
  assertEquals(
    await deliver(f.ctxWith([grantOf(["signal", "read"])]), f.waitId),
    NOT_FOUND,
  );
});

Deno.test("deliverSignalForCaller: an unsupported datastore is said in general terms", async () => {
  const f = await fixture();
  const ctx = f.ctxWith([grantOf(["signal", "read"])]);
  (ctx.repoContext as { signalWaits: unknown }).signalWaits = {
    supported: false,
    reason: "the bucket at s3://internal-name has no control plane",
  };
  const result = await deliver(ctx, f.waitId);
  assertEquals(result.status, "unsupported");
  assert(result.status !== "delivered");
  assertEquals(result.message.includes("internal-name"), false);
});

const ACTIONS: readonly Action[] = ActionSchema.options;

const arbGrant: fc.Arbitrary<Grant> = fc.record({
  actions: fc.subarray([...ACTIONS], { minLength: 1 }),
  pattern: fc.constantFrom("*", "release", "rel*", "@other/*"),
  effect: fc.constantFrom("allow" as const, "deny" as const),
}).map(({ actions, pattern, effect }) => grantOf(actions, pattern, effect));

const arbPayload = fc.oneof(
  fc.constant({ verdict: "ship" }),
  fc.constant({ verdict: "nonsense" }),
  fc.constant(null),
  fc.jsonValue(),
);

Deno.test("deliverSignalForCaller: a caller who may not signal the workflow gets the answer of an unknown wait, whatever they send", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbGrant, { maxLength: 6 }),
      arbPayload,
      async (grants, payload) => {
        const f = await fixture();
        const ctx = f.ctxWith(grants);
        const service = ctx.policySnapshotLoader!.decisionService;
        const principal = {
          principal: { kind: "user" as const, id: CALLER_ID },
          collectives: [],
          groups: [],
        };
        const resource = {
          kind: "workflow" as const,
          name: f.workflow.name,
          fields: { name: f.workflow.name, tags: {} },
        };
        const decision = service.decide(principal, "signal", resource);
        const admin = service.decide(principal, "admin", {
          kind: "access",
          name: "*",
          fields: {},
        });
        const maySignal = decision
          ? decision.effect === "allow"
          : admin?.effect === "allow";

        const real = await deliver(ctx, f.waitId, payload);
        const unknown = await deliver(ctx, UNKNOWN_WAIT, payload);

        if (!maySignal) {
          assertEquals(real, unknown);
          assertEquals((await f.waits.findOutcome(f.waitId)).kind, "absent");
        } else {
          // An allowed caller is never told the wait does not exist.
          assert(real.status !== "not_found", JSON.stringify(real));
        }
      },
    ),
    { numRuns: 60 },
  );
});

// --- Continuing the run after a delivery (swamp-club#3108) --------------------

const SUBJECT = { principal: { kind: "user" as const, id: CALLER_ID } };

/** `ctx` as a server that can launch resumes, with auto-resume on. */
function launching(
  ctx: ConnectionContext,
): { ctx: ConnectionContext; registry: ActiveRunRegistry } {
  const registry = new ActiveRunRegistry();
  return {
    registry,
    ctx: {
      ...ctx,
      repoDir: "/nonexistent-swamp-repo",
      activeRunRegistry: registry,
      serveOptions: { autoResume: true } as MergedServeOptions,
    } as ConnectionContext,
  };
}

Deno.test("deliverSignalForCaller: names the run for the server, whatever the caller may read", async () => {
  const f = await fixture();
  const result = await deliver(f.ctxWith([grantOf(["signal"])]), f.waitId);

  assert(result.status === "delivered");
  assertEquals(result.data.runId, undefined);
  assertEquals(result.run, {
    workflowId: f.workflow.id,
    runId: f.run.id,
    recordAvailable: true,
  });
});

Deno.test("continueAfterSignal: launches the run once its last wait is settled, charged to the signaller", async () => {
  const f = await fixture();
  const { ctx, registry } = launching(f.ctxWith([grantOf(["signal"])]));
  const result = await deliver(ctx, f.waitId);

  await continueAfterSignal(ctx, result, SUBJECT);

  const active = registry.get(f.run.id);
  assertEquals(active?.principalId, "user:caller");
  await active?.completion;
});

Deno.test("continueAfterSignal: does nothing for a signal that was not delivered", async () => {
  const f = await fixture();
  const { ctx, registry } = launching(f.ctxWith([]));
  const result = await deliver(ctx, f.waitId);
  assertEquals(result, NOT_FOUND);

  await continueAfterSignal(ctx, result, SUBJECT);
  assertEquals(registry.get(f.run.id), undefined);
});

Deno.test("continueAfterSignal: fetches a run record this instance does not have, and never one it has", async () => {
  const f = await fixture();
  const { ctx, registry } = launching(f.ctxWith([grantOf(["signal"])]));
  const hydrated: string[] = [];
  const repoContext = ctx.repoContext as unknown as {
    hydrateFile: (
      path: string,
      options?: { signal?: AbortSignal },
    ) => Promise<boolean>;
    workflowRunRepo: { getPath: (w: string, r: string) => string };
  };
  repoContext.workflowRunRepo.getPath = (workflowId, runId) =>
    `${workflowId}/${runId}`;
  repoContext.hydrateFile = (path, options) => {
    // Made under the sync gate, so the download is always bounded.
    assert(options?.signal instanceof AbortSignal);
    hydrated.push(path);
    f.runs.set(f.run.id, f.run);
    return Promise.resolve(true);
  };

  // The record is here: nothing is fetched over it.
  const other = await fixture("other");
  f.runs.set(other.run.id, other.run);
  f.workflows.set(other.workflow.name, other.workflow);
  await f.waits.register(
    (await other.waits.listRegistrations())[0],
  );
  await continueAfterSignal(ctx, await deliver(ctx, other.waitId), SUBJECT);
  assertEquals(hydrated, []);
  await registry.get(other.run.id)?.completion;

  // The record is missing: it is fetched, and the run continued.
  f.runs.delete(f.run.id);
  const result = await deliver(ctx, f.waitId);
  assert(result.status === "delivered");
  assertEquals(result.run.recordAvailable, false);
  await continueAfterSignal(ctx, result, SUBJECT);
  assertEquals(hydrated, [`${f.workflow.id}/${f.run.id}`]);
  const active = registry.get(f.run.id);
  assert(active !== undefined);
  await active.completion;
});

Deno.test("continueAfterSignal: a download that is aborted leaves the run for the sweep", async () => {
  const f = await fixture();
  const { ctx, registry } = launching(f.ctxWith([grantOf(["signal"])]));
  const repoContext = ctx.repoContext as unknown as {
    hydrateFile: (
      path: string,
      options?: { signal?: AbortSignal },
    ) => Promise<boolean>;
    workflowRunRepo: { getPath: (w: string, r: string) => string };
  };
  repoContext.workflowRunRepo.getPath = (workflowId, runId) =>
    `${workflowId}/${runId}`;
  let downloads = 0;
  repoContext.hydrateFile = () => {
    downloads++;
    return Promise.reject(new DOMException("timed out", "TimeoutError"));
  };
  f.runs.delete(f.run.id);
  const result = await deliver(ctx, f.waitId);
  assert(result.status === "delivered");

  await continueAfterSignal(ctx, result, SUBJECT);
  assertEquals(downloads, 1);
  assertEquals(registry.get(f.run.id), undefined);
});

Deno.test("continueAfterSignal: a failure to continue never reaches the caller", async () => {
  const f = await fixture();
  const { ctx } = launching(f.ctxWith([grantOf(["signal"])]));
  const result = await deliver(ctx, f.waitId);
  (ctx.repoContext as unknown as { workflowRunRepo: { findById: unknown } })
    .workflowRunRepo.findById = () => Promise.reject(new Error("disk gone"));

  await continueAfterSignal(ctx, result, SUBJECT);
});
