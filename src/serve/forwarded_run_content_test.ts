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
import { stringify as stringifyYaml } from "@std/yaml";
import { createIntent } from "../domain/datastore_v3/intent.ts";
import { type PutOp, putOp } from "../domain/datastore_v3/op.ts";
import { partitionOf } from "../domain/datastore_v3/partition_key.ts";
import { RecordKey } from "../domain/datastore_v3/record_key.ts";
import { Job } from "../domain/workflows/job.ts";
import { Step } from "../domain/workflows/step.ts";
import { StepTask } from "../domain/workflows/step_task.ts";
import { Workflow } from "../domain/workflows/workflow.ts";
import type {
  ContentCheckContext,
  PriorRecord,
} from "./forwarded_content_authorization.ts";
import { checkRunRecord, checkRunSnapshot } from "./forwarded_run_content.ts";
import type { ConnectionContext } from "./handlers/shared.ts";

const WORKFLOW = "44444444-5555-4666-8777-888888888888";
const RUN = "33333333-4444-4555-8666-777777777777";
const STARTED = "2026-10-26T00:00:00.000Z";
const encoder = new TextEncoder();

function yaml(value: unknown): Uint8Array {
  return encoder.encode(stringifyYaml(JSON.parse(JSON.stringify(value))));
}

function record(fields: Record<string, unknown> = {}) {
  return {
    id: RUN,
    workflowId: WORKFLOW,
    workflowName: "deploy",
    status: "running",
    tags: {},
    jobs: [],
    ...fields,
  };
}

function context(
  stored: Record<string, Uint8Array>,
  allowed: readonly string[],
): { context: ContentCheckContext; asked: string[] } {
  const asked: string[] = [];
  const ctx = {
    instanceId: "serve-1",
    repoContext: {
      workflowRepo: {
        findById: () => Promise.resolve(null),
        findByName: () => Promise.resolve(null),
      },
      workflowRunRepo: { findGlobalById: () => Promise.resolve(null) },
    },
  } as unknown as ConnectionContext;
  return {
    asked,
    context: {
      deps: {
        ctx,
        // no authenticated caller: initiators are checked in their own tests
        caller: { principal: null, collectives: [], groups: [], sourceIp: "" },
        partition: partitionOf({
          kind: "run",
          workflowId: WORKFLOW,
          runId: RUN,
        }),
      } as unknown as ContentCheckContext["deps"],
      authority: {
        allows: (action) => {
          asked.push(action);
          return allowed.includes(action);
        },
        allowsAll: () => false,
      },
      bytesOf: (op: PutOp) =>
        Promise.resolve(
          Uint8Array.from(
            atob((op.content as { inline: string }).inline),
            (c) => c.charCodeAt(0),
          ),
        ),
      prior: (_partition, key): Promise<PriorRecord> =>
        Promise.resolve(
          key in stored
            ? { kind: "present", bytes: stored[key] }
            : { kind: "absent" },
        ),
      digest: () => Promise.resolve(null),
      holdsRecordsUnder: () => Promise.resolve(false),
      keysIn: () => Promise.resolve([]),
      recheckUnderLock: () => {},
      now: () => new Date(STARTED),
    },
  };
}

const KEY = `workflow-runs/${WORKFLOW}/workflow-run-${RUN}.yaml`;

function runPut(kind: "run.create" | "run.update", body: unknown) {
  return putOp({
    intent: createIntent({ kind, run: { workflowId: WORKFLOW, runId: RUN } }),
    key: RecordKey.create(KEY),
    inline: btoa(String.fromCharCode(...yaml(body))),
  });
}

/** `c`, whose stored workflow of this run is `workflow`. */
function withStoredWorkflow(
  c: ContentCheckContext,
  workflow: Workflow,
): ContentCheckContext {
  (c.deps.ctx.repoContext as unknown as { workflowRepo: unknown })
    .workflowRepo = {
      findById: () => Promise.resolve(workflow),
      findByName: () => Promise.resolve(workflow),
    };
  return c;
}

Deno.test("checkRunRecord: a record naming a host log path, or a serve instance, is refused before any decision", async () => {
  for (
    const fields of [{ logFile: "/etc/passwd" }, { instanceId: "serve-1" }]
  ) {
    const { context: c, asked } = context({}, ["run", "approve"]);
    const op = await runPut("run.create", record(fields));
    assert(await checkRunRecord(c, op) !== undefined, JSON.stringify(fields));
    assertEquals(asked, []);
  }
});

Deno.test("checkRunRecord: a record making a decision is refused, whatever the caller holds", async () => {
  const waiting = record({
    status: "suspended",
    jobs: [{
      jobName: "main",
      status: "waiting_approval",
      steps: [{
        stepName: "gate",
        status: "waiting_approval",
        startedAt: STARTED,
      }],
    }],
  });
  const decided = record({
    status: "suspended",
    jobs: [{
      jobName: "main",
      status: "succeeded",
      steps: [{
        stepName: "gate",
        status: "succeeded",
        startedAt: STARTED,
        approvalDecision: { approved: true, decidedAt: STARTED },
      }],
    }],
  });
  const op = await runPut("run.update", decided);
  for (const allowed of [["run"], ["run", "approve"], ["admin", "approve"]]) {
    const held = context({ [KEY]: yaml(waiting) }, allowed);
    assert(await checkRunRecord(held.context, op) !== undefined);
    assert(!held.asked.includes("approve"), "approve decides nothing here");
  }
});

Deno.test("checkRunRecord: what a record adds is decided again under the lock, so a revoked grant refuses the commit", async () => {
  const childWorkflow = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
  const childRun = "88888888-9999-4aaa-8bbb-cccccccccccc";
  const op = await runPut(
    "run.create",
    record({
      jobs: [{
        jobName: "main",
        status: "running",
        steps: [{
          stepName: "call",
          status: "succeeded",
          output: {
            type: "workflow",
            workflowId: childWorkflow,
            runId: childRun,
          },
        }],
      }],
    }),
  );
  const child = yaml({
    ...record({ id: childRun, workflowId: childWorkflow, status: "succeeded" }),
    parentRun: {
      workflowId: WORKFLOW,
      workflowName: "deploy",
      runId: RUN,
      jobName: "main",
      stepName: "call",
      nestingDepth: 1,
      ancestorWorkflowNames: ["deploy"],
    },
  });
  const allowed = ["run", "read"];
  const { context: c } = context(
    { [`workflow-runs/${childWorkflow}/workflow-run-${childRun}.yaml`]: child },
    allowed,
  );
  const rechecks: (() => Promise<boolean>)[] = [];
  c.recheckUnderLock = (check) => rechecks.push(check);
  assertEquals(await checkRunRecord(c, op), undefined);
  // The run id, then what the record adds.
  assertEquals(rechecks.length, 2);
  assertEquals(await rechecks[1](), true);
  allowed.pop();
  assertEquals(await rechecks[1](), false);
});

Deno.test("checkRunRecord: a nested step's decision is its child's, when that child links back", async () => {
  const childWorkflow = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
  const childRun = "88888888-9999-4aaa-8bbb-cccccccccccc";
  const decision = {
    approved: false,
    decidedBy: "user:ana",
    decidedAt: STARTED,
  };
  const nestedRun = {
    workflowId: childWorkflow,
    workflowName: "child",
    runId: childRun,
  };
  const stepOf = (task: StepTask) =>
    Workflow.create({
      id: WORKFLOW,
      name: "deploy",
      jobs: [
        Job.create({
          name: "main",
          steps: [Step.create({ name: "call", task })],
        }),
      ],
    });
  const calling = stepOf(StepTask.workflow("child"));
  const gated = stepOf(StepTask.manualApproval("Go?"));
  const parent = (step: Record<string, unknown>) =>
    record({
      jobs: [{
        jobName: "main",
        status: "running",
        steps: [{ stepName: "call", nestedRun, ...step }],
      }],
    });
  const childRecord = (linksTo: string, approvalDecision: unknown) =>
    yaml({
      ...record({ id: childRun, workflowId: childWorkflow, status: "failed" }),
      parentRun: {
        workflowId: WORKFLOW,
        workflowName: "deploy",
        runId: linksTo,
        jobName: "main",
        stepName: "call",
        nestingDepth: 1,
        ancestorWorkflowNames: ["deploy"],
      },
      jobs: [{
        jobName: "main",
        status: "failed",
        steps: [{ stepName: "gate", status: "failed", approvalDecision }],
      }],
    });
  const op = await runPut(
    "run.update",
    parent({ status: "failed", approvalDecision: decision }),
  );
  const childKey =
    `workflow-runs/${childWorkflow}/workflow-run-${childRun}.yaml`;
  const judged = async (
    child: Uint8Array | undefined,
    stored: Workflow = calling,
  ) =>
    await checkRunRecord(
      withStoredWorkflow(
        context({
          [KEY]: yaml(parent({ status: "waiting_approval" })),
          ...(child === undefined ? {} : { [childKey]: child }),
        }, ["run", "read"]).context,
        stored,
      ),
      op,
    );
  assertEquals(await judged(childRecord(RUN, decision)), undefined);
  assertEquals(
    await judged(childRecord(RUN.toUpperCase(), decision)),
    undefined,
  );
  const other = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
  assert(await judged(childRecord(other, decision)) !== undefined);
  assert(
    await judged(childRecord(RUN, { ...decision, approved: true })) !==
      undefined,
  );
  assert(await judged(undefined) !== undefined);
  // On a step the stored workflow makes a gate, the same decision is refused.
  assert(await judged(childRecord(RUN, decision), gated) !== undefined);
});

Deno.test("checkRunRecord: a first record's parent must be a run that has not finished", async () => {
  const parentId = "55555555-6666-4777-8888-999999999999";
  const parentRun = {
    workflowId: WORKFLOW,
    workflowName: "deploy",
    runId: parentId,
    jobName: "main",
    stepName: "call",
    nestingDepth: 1,
    ancestorWorkflowNames: ["deploy"],
  };
  const parentKey = `workflow-runs/${WORKFLOW}/workflow-run-${parentId}.yaml`;
  const op = await runPut("run.create", record({ parentRun }));
  for (
    const [status, refused] of [["suspended", false], [
      "succeeded",
      true,
    ]] as const
  ) {
    const { context: c } = context(
      { [parentKey]: yaml(record({ id: parentId, status })) },
      ["run"],
    );
    assertEquals((await checkRunRecord(c, op)) !== undefined, refused, status);
  }
  const { context: none } = context({}, ["run"]);
  assert(await checkRunRecord(none, op) !== undefined);
});

Deno.test("checkRunSnapshot: a snapshot declares the workflow its run's intent names", async () => {
  const snapshot = (id: string) =>
    putOp({
      intent: createIntent({
        kind: "run-snapshot.save",
        run: { workflowId: WORKFLOW, runId: RUN },
      }),
      key: RecordKey.create(
        `workflows-evaluated/runs/${RUN}/evaluated-workflow.yaml`,
      ),
      inline: btoa(
        String.fromCharCode(
          ...yaml(
            Workflow.create({
              id,
              name: "deploy",
              jobs: [
                Job.create({
                  name: "main",
                  steps: [
                    Step.create({
                      name: "gate",
                      task: StepTask.manualApproval("Go?"),
                    }),
                  ],
                }),
              ],
            }).toData(),
          ),
        ),
      ),
    });
  const { context: c } = context({}, ["run"]);
  assertEquals(await checkRunSnapshot(c, await snapshot(WORKFLOW)), undefined);
  assert(
    await checkRunSnapshot(
      c,
      await snapshot("66666666-7777-4888-8999-aaaaaaaaaaaa"),
    ) !== undefined,
  );
  // Frozen once written: the same bytes, as a replay holds,
  // land; any others do not.
  const held = await snapshot(WORKFLOW);
  const stored = {
    [held.key.toString()]: Uint8Array.from(
      atob((held.content as { inline: string }).inline),
      (char) => char.charCodeAt(0),
    ),
  };
  assertEquals(
    await checkRunSnapshot(context(stored, ["run"]).context, held),
    undefined,
  );
  const changed = await snapshot(WORKFLOW);
  assert(
    await checkRunSnapshot(
      context({ [held.key.toString()]: new TextEncoder().encode("other") }, [
        "run",
      ]).context,
      changed,
    ) !== undefined,
  );
});

Deno.test("checkRunRecord: a nested workflow output must be a child run whose record links back to this step, and readable", async () => {
  const childWorkflow = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
  const childRun = "88888888-9999-4aaa-8bbb-cccccccccccc";
  const childKey =
    `workflow-runs/${childWorkflow}/workflow-run-${childRun}.yaml`;
  const output = {
    type: "workflow",
    workflowId: childWorkflow,
    runId: childRun,
  };
  const completed = record({
    jobs: [{
      jobName: "main",
      status: "succeeded",
      steps: [{ stepName: "call", status: "succeeded", output }],
    }],
  });
  const child = (parentRunId: string, stepName = "call") =>
    yaml({
      ...record({
        id: childRun,
        workflowId: childWorkflow,
        status: "succeeded",
      }),
      parentRun: {
        workflowId: WORKFLOW,
        workflowName: "deploy",
        runId: parentRunId,
        jobName: "main",
        stepName,
        nestingDepth: 1,
        ancestorWorkflowNames: ["deploy"],
      },
    });
  const op = await runPut("run.create", completed);
  const judged = async (
    stored: Record<string, Uint8Array>,
    allowed = ["run", "read"],
  ) => await checkRunRecord(context(stored, allowed).context, op);
  assertEquals(await judged({ [childKey]: child(RUN) }), undefined);
  assertEquals(
    await judged({ [childKey]: child(RUN.toUpperCase()) }),
    undefined,
  );
  assert(
    await judged({
      [childKey]: child("99999999-aaaa-4bbb-8ccc-dddddddddddd"),
    }) !==
      undefined,
  );
  assert(await judged({ [childKey]: child(RUN, "other") }) !== undefined);
  assert(await judged({}) !== undefined);
  assert(await judged({ [childKey]: child(RUN) }, ["run"]) !== undefined);
});

Deno.test("checkRunRecord: a first record cannot reuse a run id another workflow holds (swamp-club#4245)", async () => {
  const op = await runPut("run.create", record());
  const first = (holderWorkflow: string | null) => {
    const { context: c } = context({}, ["run", "read"]);
    (c.deps.ctx.repoContext as unknown as {
      workflowRunRepo: { findGlobalById: () => Promise<unknown> };
    }).workflowRunRepo = {
      findGlobalById: () =>
        Promise.resolve(
          holderWorkflow === null ? null : { workflowId: holderWorkflow },
        ),
    };
    return checkRunRecord(c, op);
  };
  assertEquals(await first(null), undefined);
  assertEquals(await first(WORKFLOW), undefined);
  assert(
    await first("66666666-7777-4888-8999-aaaaaaaaaaaa") !== undefined,
  );
});

Deno.test("checkRunRecord: a run id taken while a first record waits for the lock refuses the commit (swamp-club#4245)", async () => {
  const op = await runPut("run.create", record());
  const { context: c } = context({}, ["run", "read"]);
  let holder: { workflowId: string } | null = null;
  (c.deps.ctx.repoContext as unknown as {
    workflowRunRepo: { findGlobalById: () => Promise<unknown> };
  }).workflowRunRepo = { findGlobalById: () => Promise.resolve(holder) };
  const rechecks: (() => Promise<boolean>)[] = [];
  c.recheckUnderLock = (check) => rechecks.push(check);
  assertEquals(await checkRunRecord(c, op), undefined);
  assertEquals(await rechecks[0](), true);
  holder = { workflowId: "66666666-7777-4888-8999-aaaaaaaaaaaa" };
  assertEquals(await rechecks[0](), false);
});
