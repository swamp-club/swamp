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
import type {
  StepRunData,
  WorkflowRunData,
} from "../workflows/workflow_run.ts";
import {
  identityRefusal,
  isCanonicalRunLogFile,
  judgeRunRecord,
  runIdentityRefusal,
  type RunRecordContext,
  type StepKind,
} from "./content_bindings.ts";
import type { Intent } from "./intent.ts";

const ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER = "11111111-2222-4333-8444-555555555555";
const WORKFLOW = "22222222-3333-4444-8555-666666666666";
const RUN = "33333333-4444-4555-8666-777777777777";

const create: Intent = {
  kind: "definition.create",
  definition: { kind: "model", name: "web" },
};

Deno.test("identityRefusal: a definition declaring the name, type and id its intent and key name passes", () => {
  assertEquals(
    identityRefusal(create, { type: "acme/web" }, {
      id: ID,
      name: "web",
      type: "acme/web",
    }),
    undefined,
  );
  assertEquals(
    identityRefusal(create, { fileId: ID, type: "acme/web" }, {
      id: ID.toUpperCase(),
      name: "web",
      type: "acme/web",
    }),
    undefined,
  );
});

Deno.test("identityRefusal: each declared field that differs from its intent, key or stored definition refuses", () => {
  const declared = { id: ID, name: "web", type: "acme/web" };
  const cases: [string, ReturnType<typeof identityRefusal>][] = [
    ["name", identityRefusal(create, {}, { ...declared, name: "prod" })],
    [
      "type",
      identityRefusal(create, { type: "acme/web" }, {
        ...declared,
        type: "acme/db",
      }),
    ],
    ["file id", identityRefusal(create, { fileId: OTHER }, declared)],
    [
      "stored id",
      identityRefusal(create, {}, declared, { id: OTHER, name: "web" }),
    ],
    [
      "auto-definition id",
      identityRefusal(
        { kind: "auto-definition.save", autoDefinition: { id: OTHER } },
        {},
        declared,
      ),
    ],
    [
      "file name",
      identityRefusal(
        { kind: "auto-definition.save", autoDefinition: { id: ID } },
        { fileName: "other" },
        declared,
      ),
    ],
    [
      "evaluated behavior",
      identityRefusal(
        {
          kind: "evaluated-definition.save",
          model: { type: "acme/web", id: OTHER },
        },
        {},
        declared,
      ),
    ],
    [
      "evaluated type",
      identityRefusal(
        {
          kind: "evaluated-definition.save",
          model: { type: "acme/db", id: ID },
        },
        {},
        declared,
      ),
    ],
  ];
  for (const [field, refusal] of cases) {
    assert(refusal !== undefined, `${field} should refuse`);
    // A refusal names the field, never the caller's value.
    assert(!refusal.includes("prod") && !refusal.includes(OTHER), field);
  }
});

Deno.test("identityRefusal: a rename-to declares the new name", () => {
  const rename: Intent = {
    kind: "definition.rename-to",
    definition: { kind: "workflow", name: "new" },
    from: "old",
  };
  assertEquals(identityRefusal(rename, {}, { id: ID, name: "new" }), undefined);
  assert(identityRefusal(rename, {}, { id: ID, name: "old" }) !== undefined);
});

Deno.test("runIdentityRefusal: a run record or snapshot must declare its intent's workflow and run", () => {
  const intent: Intent = {
    kind: "run.update",
    run: { workflowId: WORKFLOW, runId: RUN },
  };
  assertEquals(
    runIdentityRefusal(intent, { workflowId: WORKFLOW, runId: RUN }),
    undefined,
  );
  assertEquals(runIdentityRefusal(intent, { workflowId: WORKFLOW }), undefined);
  assert(runIdentityRefusal(intent, { workflowId: OTHER }) !== undefined);
  assert(
    runIdentityRefusal(intent, { workflowId: WORKFLOW, runId: OTHER }) !==
      undefined,
  );
});

Deno.test("isCanonicalRunLogFile: only the run's own log, relative, in either separator", () => {
  const canonical = `.swamp/workflow-runs/${WORKFLOW}/workflow-run-${RUN}.log`;
  assert(isCanonicalRunLogFile(canonical, WORKFLOW, RUN));
  assert(
    isCanonicalRunLogFile(canonical.replaceAll("/", "\\"), WORKFLOW, RUN),
  );
  for (
    const path of [
      `/home/serve/${canonical}`,
      "/etc/passwd",
      `.swamp/workflow-runs/${WORKFLOW}/../../serve.yaml`,
      `.swamp/workflow-runs/${WORKFLOW}/workflow-run-${OTHER}.log`,
      `.swamp/workflow-runs/${OTHER}/workflow-run-${RUN}.log`,
    ]
  ) {
    assert(!isCanonicalRunLogFile(path, WORKFLOW, RUN), path);
  }
});

function step(
  stepName: string,
  fields: Partial<StepRunData> = {},
): StepRunData {
  return { stepName, status: "pending", ...fields } as StepRunData;
}

function run(
  steps: StepRunData[],
  fields: Partial<WorkflowRunData> = {},
): WorkflowRunData {
  return {
    id: RUN,
    workflowId: WORKFLOW,
    workflowName: "deploy",
    status: "running",
    tags: {},
    jobs: [{ jobName: "main", status: "running", steps }],
    ...fields,
  } as WorkflowRunData;
}

const NOW = new Date("2026-10-26T12:00:00.000Z");
const STARTED = "2026-10-26T11:00:00.000Z";

function judge(
  before: WorkflowRunData | undefined,
  after: WorkflowRunData,
  kinds: Record<string, StepKind> = { gate: "approval", wait: "signal" },
  extra: Partial<RunRecordContext> = {},
) {
  return judgeRunRecord({
    workflowId: WORKFLOW,
    runId: RUN,
    before,
    after,
    stepKind: (_job, s) => kinds[s.stepName] ?? "other",
    definitionSteps: () => undefined,
    isServeInstance: (id) => id === "serve-1",
    now: NOW,
    ...extra,
  });
}

const DECIDED = {
  approved: true,
  decidedBy: "user:ana",
  decidedAt: STARTED,
};

Deno.test("judgeRunRecord: a run's first record may not claim a triggering principal or widen its vaults", () => {
  assert(
    judge(
      undefined,
      run([], {
        triggeringPrincipal: {
          kind: "user",
          id: "admin",
          membership: {
            localGroups: [],
            idpGroups: ["admins"],
            collectives: [],
          },
        },
      }),
    ).refusal !== undefined,
  );
  assert(
    judge(undefined, run([], { allowedVaults: ["prod"] }), {}, {
      workflowVaults: ["dev"],
    }).refusal !== undefined,
  );
  assertEquals(
    judge(undefined, run([], { allowedVaults: ["dev"] }), {}, {
      workflowVaults: ["dev", "prod"],
    }).refusal,
    undefined,
  );
});

Deno.test("judgeRunRecord: an update may not change who triggered the run, its parent, vaults, initiator, plan or inherited expressions", () => {
  const before = run([], {
    initiatedBy: "user:ana",
    runPlan: { fingerprint: "a" },
    inheritedExpressions: ["e1"],
    allowedVaults: ["dev"],
  });
  for (
    const change of [
      { initiatedBy: "user:root" },
      { runPlan: { fingerprint: "b" } },
      { inheritedExpressions: ["e1", "e2"] },
      { allowedVaults: ["dev", "prod"] },
      { parentRun: { workflowId: OTHER } },
    ] as Partial<WorkflowRunData>[]
  ) {
    assert(
      judge(before, { ...before, ...change }).refusal !== undefined,
      JSON.stringify(change),
    );
  }
});

Deno.test("judgeRunRecord: a log file outside the run's own, or a serve instance as owner, is refused", () => {
  assert(
    judge(undefined, run([], { logFile: "/etc/passwd" })).refusal !==
      undefined,
  );
  assert(
    judge(undefined, run([], { instanceId: "serve-1" })).refusal !== undefined,
  );
  assertEquals(
    judge(
      undefined,
      run([], {
        logFile: `.swamp/workflow-runs/${WORKFLOW}/workflow-run-${RUN}.log`,
        instanceId: "laptop-7",
        pid: 41,
      }),
    ).refusal,
    undefined,
  );
});

Deno.test("judgeRunRecord: a run serve started keeps its process and instance, a local run's may change", () => {
  const principal = {
    kind: "user" as const,
    id: "ana",
    membership: { localGroups: [], idpGroups: [], collectives: [] },
  };
  const served = run([], { pid: 10, triggeringPrincipal: principal });
  assert(judge(served, { ...served, pid: 11 }).refusal !== undefined);
  const local = run([], { pid: 10 });
  assertEquals(judge(local, { ...local, pid: 11 }).refusal, undefined);
});

Deno.test("judgeRunRecord: reaching a gate needs only run; deciding or completing it needs approve", () => {
  const reached = judge(
    run([step("gate", { status: "running" })]),
    run([step("gate", { status: "waiting_approval", startedAt: STARTED })]),
  );
  assertEquals([...reached.actions], []);
  const waiting = run([
    step("gate", { status: "waiting_approval", startedAt: STARTED }),
  ]);
  assertEquals(
    [
      ...judge(
        waiting,
        run([step("gate", { status: "succeeded", startedAt: STARTED })]),
      ).actions,
    ],
    ["approve"],
  );
  assertEquals(
    [
      ...judge(
        waiting,
        run([
          step("gate", {
            status: "waiting_approval",
            startedAt: STARTED,
            approvalDecision: DECIDED,
          }),
        ]),
      ).actions,
    ],
    ["approve"],
  );
});

Deno.test("judgeRunRecord: a gate decided before, settled by a cancel, or past its deadline completes with run", () => {
  const decided = run([
    step("gate", {
      status: "waiting_approval",
      startedAt: STARTED,
      approvalDecision: DECIDED,
    }),
  ]);
  assertEquals(
    [
      ...judge(
        decided,
        run([
          step("gate", {
            status: "succeeded",
            startedAt: STARTED,
            approvalDecision: DECIDED,
          }),
        ]),
      ).actions,
    ],
    [],
  );
  const waiting = run([
    step("gate", { status: "waiting_approval", startedAt: STARTED }),
  ], { status: "suspended" });
  assertEquals(
    [
      ...judge(
        waiting,
        run([
          step("gate", {
            status: "failed",
            startedAt: STARTED,
            settledByAbort: true,
          }),
        ], { status: "cancelled" }),
      ).actions,
    ],
    [],
  );
  const timedOut = (timeout: number) =>
    judge(
      run([
        step("gate", {
          status: "waiting_approval",
          startedAt: STARTED,
          approvalTimeout: timeout,
        }),
      ]),
      run([
        step("gate", {
          status: "failed",
          startedAt: STARTED,
          approvalTimeout: timeout,
        }),
      ]),
    );
  // An hour waited: a 60s deadline has passed, a day's has not.
  assertEquals([...timedOut(60).actions], []);
  assertEquals([...timedOut(86_400).actions], ["approve"]);
});

Deno.test("judgeRunRecord: a waiting gate's prompt, timeout and start are frozen", () => {
  const waiting = run([
    step("gate", {
      status: "waiting_approval",
      startedAt: STARTED,
      approvalPrompt: "Deploy to staging?",
      approvalTimeout: 600,
    }),
  ]);
  for (
    const change of [
      { approvalPrompt: "Deploy to production?" },
      { approvalTimeout: 6 },
      { startedAt: "2026-10-26T11:59:00.000Z" },
    ]
  ) {
    const after = run([
      step("gate", {
        status: "waiting_approval",
        startedAt: STARTED,
        approvalPrompt: "Deploy to staging?",
        approvalTimeout: 600,
        ...change,
      }),
    ]);
    assert(judge(waiting, after).refusal !== undefined, JSON.stringify(change));
  }
});

Deno.test("judgeRunRecord: a nested-call step waiting on its child ends with run", () => {
  const nestedRun = { workflowId: OTHER, workflowName: "child", runId: ID };
  assertEquals(
    [
      ...judge(
        run([
          step("call", { status: "waiting_approval", nestedRun }),
        ]),
        run([step("call", { status: "succeeded", nestedRun })]),
        { call: "unknown" },
      ).actions,
    ],
    [],
  );
});

Deno.test("judgeRunRecord: a wait's outcome needs signal, registering it needs run", () => {
  const registered = judge(
    run([step("wait", { status: "running" })]),
    run([step("wait", { status: "waiting_signal", wait: { key: "k" } })]),
  );
  assertEquals([...registered.actions], []);
  const signalled = judge(
    run([step("wait", { status: "waiting_signal", wait: { key: "k" } })]),
    run([
      step("wait", {
        status: "succeeded",
        wait: { key: "k" },
        output: { type: "wait_for_signal", payload: { ok: true } },
      }),
    ]),
  );
  assertEquals([...signalled.actions], ["signal"]);
});

Deno.test("judgeRunRecord: what the record adds for serve to authorise is returned", () => {
  const before = run([], { inputs: { region: "eu" } });
  const ref = {
    path: ["token"],
    occurrence: 0,
    vaultName: "prod",
    key: "api",
    encoding: "string",
    dataOrigin: false,
  };
  const output = {
    type: "model_method",
    resources: [],
  };
  const judged = judge(
    before,
    run([step("deploy", { status: "succeeded", output })], {
      inputs: { region: "us" },
      writtenReferences: [ref] as WorkflowRunData["writtenReferences"],
    }),
  );
  assertEquals(judged.refusal, undefined);
  assert(judged.inputsChanged);
  assertEquals(judged.addedReferences, [ref]);
  assertEquals(judged.addedOutputs.map((o) => o.stepName), ["deploy"]);
  // An unchanged record adds nothing.
  const same = judge(before, before);
  assert(!same.inputsChanged);
  assertEquals(same.addedOutputs, []);
  assertEquals([...same.actions], []);
});

Deno.test("judgeRunRecord: a gate the stored workflow no longer names cannot be reopened, or have its prompt dropped, to settle it without approve", () => {
  const waiting = run([
    step("gate", {
      status: "waiting_approval",
      startedAt: STARTED,
      approvalPrompt: "Deploy?",
    }),
  ]);
  // First commit of the attack: move the gate back to running.
  const reopened = run([
    step("gate", {
      status: "running",
      startedAt: STARTED,
      approvalPrompt: "Deploy?",
    }),
  ]);
  assertEquals(
    [...judge(waiting, reopened, { gate: "unknown" }).actions],
    ["approve"],
  );
  // Dropping the prompt in the same move is refused outright.
  assert(
    judge(
      waiting,
      run([step("gate", { status: "running", startedAt: STARTED })]),
      { gate: "unknown" },
    ).refusal !== undefined,
  );
  // Second commit: still a gate by its prompt, so completing it needs approve.
  assertEquals(
    [
      ...judge(
        reopened,
        run([
          step("gate", {
            status: "succeeded",
            startedAt: STARTED,
            approvalPrompt: "Deploy?",
          }),
        ]),
        { gate: "unknown" },
      ).actions,
    ],
    ["approve"],
  );
});
