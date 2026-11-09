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
import type {
  StepRunData,
  WorkflowRunData,
} from "../workflows/workflow_run.ts";
import {
  identityRefusal,
  isCanonicalRunLogFile,
  judgeRunRecord,
  judgeRunStart,
  runIdentityRefusal,
  runInitiatorRefusal,
  type RunRecordContext,
  type RunStartContext,
} from "./content_bindings.ts";
import type { Intent } from "./intent.ts";
import { StepStart, type StepStartData } from "../workflows/step_start.ts";

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
      "stored type",
      identityRefusal(create, {}, declared, {
        id: ID,
        name: "web",
        type: "acme/admin",
      }),
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

const STARTED = "2026-10-26T11:00:00.000Z";

function judge(
  before: WorkflowRunData | undefined,
  after: WorkflowRunData,
  extra: Partial<RunRecordContext> = {},
) {
  return judgeRunRecord({
    workflowId: WORKFLOW,
    runId: RUN,
    before,
    after,
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
    judge(undefined, run([], { allowedVaults: ["prod"] }), {
      workflowVaults: ["dev"],
    }).refusal !== undefined,
  );
  assertEquals(
    judge(undefined, run([], { allowedVaults: ["dev"] }), {
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
        pid: 41,
      }),
    ).refusal,
    undefined,
  );
});

Deno.test("judgeRunRecord: a run serve drives takes no forwarded record, whichever team node holds it (swamp-club#4245)", () => {
  const principal = {
    kind: "user",
    id: "ana",
    membership: { localGroups: [], idpGroups: [], collectives: [] },
  } as WorkflowRunData["triggeringPrincipal"];
  const steps = [step("deploy", { status: "running" })];
  const forged = [step("deploy", { status: "succeeded" })];
  assert(
    judge(
      run(steps, { triggeringPrincipal: principal }),
      run(forged, { triggeringPrincipal: principal }),
    ).refusal !== undefined,
  );
  assert(
    judge(
      run(steps, { instanceId: "old-leader" }),
      run(forged, { instanceId: "old-leader" }),
    ).refusal !== undefined,
  );
  assert(
    judge(run(steps), run(forged, { instanceId: "old-leader" })).refusal !==
      undefined,
  );
  assertEquals(judge(run(steps), run(forged)).refusal, undefined);
  assertEquals(
    judge(run(steps, { pid: 1 }), run(forged, { pid: 2 })).refusal,
    undefined,
  );
});

Deno.test("judgeRunRecord: a waiting gate's prompt, timeout, start and child link are frozen", () => {
  const nestedRun = { workflowId: OTHER, workflowName: "child", runId: ID };
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
      { nestedRun },
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
  const same = judge(before, before);
  assert(!same.inputsChanged);
  assertEquals(same.addedOutputs, []);
});

const DENIED = { ...DECIDED, approved: false };

Deno.test("judgeRunRecord: a record never creates or changes a decision, whatever the step or its status", () => {
  const gate = (fields: Partial<StepRunData>) =>
    run([step("gate", { startedAt: STARTED, ...fields })]);
  const waiting = gate({ status: "waiting_approval" });
  for (const status of ["waiting_approval", "succeeded", "failed"] as const) {
    assert(
      judge(waiting, gate({ status, approvalDecision: DECIDED })).refusal !==
        undefined,
      status,
    );
  }
  assert(
    judge(undefined, gate({ status: "succeeded", approvalDecision: DECIDED }))
      .refusal !== undefined,
  );
  assert(
    judge(
      gate({ status: "failed", approvalDecision: DENIED }),
      gate({ status: "failed", approvalDecision: DECIDED }),
    ).refusal !== undefined,
  );
  assertEquals(
    judge(
      gate({ status: "waiting_approval", approvalDecision: DECIDED }),
      gate({ status: "succeeded", approvalDecision: DECIDED }),
    ).refusal,
    undefined,
  );
});

Deno.test("judgeRunRecord: only a retry clears a decision, and a decided step stays in the record", () => {
  const denied = run([
    step("gate", {
      status: "failed",
      startedAt: STARTED,
      approvalDecision: DENIED,
    }),
  ]);
  assert(
    judge(denied, run([step("gate", { status: "failed" })])).refusal !==
      undefined,
  );
  assert(
    judge(denied, run([step("gate", { status: "succeeded" })])).refusal !==
      undefined,
  );
  assertEquals(
    judge(denied, run([step("gate", { status: "pending" })])).refusal,
    undefined,
  );
  assert(judge(denied, run([])).refusal !== undefined);
  assert(
    judge(
      denied,
      run([step("renamed", { status: "failed", approvalDecision: DENIED })]),
    ).refusal !== undefined,
  );
  assertEquals(
    judge(
      run([step("gate", { status: "failed", startedAt: STARTED })]),
      run([]),
    ).refusal,
    undefined,
  );
});

Deno.test("judgeRunRecord: a nested step may hold only a decision its linked child holds (swamp-club#4045)", () => {
  const nestedRun = { workflowId: OTHER, workflowName: "child", runId: ID };
  const waiting = run([
    step("call", { status: "waiting_approval", nestedRun }),
  ]);
  const rejected = run([
    step("call", { status: "failed", nestedRun, approvalDecision: DENIED }),
  ]);
  const judged = (decisions: readonly typeof DENIED[] | undefined) =>
    judge(waiting, rejected, {
      storedStepIsNested: () => true,
      heldChild: () => decisions === undefined ? undefined : { decisions },
    });
  assertEquals(judged([DENIED]).refusal, undefined);
  assert(judged([DECIDED]).refusal !== undefined);
  assert(judged([]).refusal !== undefined);
  assert(judged(undefined).refusal !== undefined);
});

Deno.test("judgeRunRecord: a duplicate step key is refused, so a record has one reading (swamp-club#4046)", () => {
  const decided = step("gate", {
    status: "failed",
    startedAt: STARTED,
    approvalDecision: DENIED,
  });
  assert(
    judge(
      run([decided]),
      run([decided, step("gate", { status: "succeeded" })]),
    ).refusal !== undefined,
  );
  assertEquals(
    judge(undefined, {
      ...run([]),
      jobs: [
        { jobName: "a", status: "running", steps: [step("s")] },
        { jobName: "b", status: "running", steps: [step("s")] },
      ],
    }).refusal,
    undefined,
  );
});

Deno.test("judgeRunRecord: what a member reports of a run they drive is out of scope (access-control.md, the threat model)", () => {
  const reports: [StepRunData, StepRunData, Partial<WorkflowRunData>][] = [
    [step("gate"), step("gate", { status: "skipped" }), {}],
    [
      step("gate", { status: "waiting_approval", startedAt: STARTED }),
      step("gate", { status: "succeeded", startedAt: STARTED }),
      { status: "succeeded" },
    ],
    [
      step("deploy", { status: "running" }),
      step("deploy", { status: "failed", allowedFailure: true }),
      { status: "succeeded" },
    ],
  ];
  for (const [from, to, fields] of reports) {
    assertEquals(
      judge(run([from]), run([to], fields)).refusal,
      undefined,
      to.stepName,
    );
  }
});

const OPEN_WAIT = {
  kind: "signal",
  id: "55555555-6666-4777-8888-999999999999",
  schema: { type: "object", properties: {} },
  deadline: "2026-10-27T00:00:00.000Z",
};

Deno.test("judgeRunRecord: a run a member drives names no signal wait and carries no signal's outcome (swamp-club#4245)", () => {
  const running = run([step("wait", { status: "running" })]);
  assert(
    judge(
      running,
      run([step("wait", { status: "waiting_signal", wait: OPEN_WAIT })]),
    ).refusal !== undefined,
  );
  assert(
    judge(
      undefined,
      run([step("wait", { status: "waiting_signal", wait: OPEN_WAIT })]),
    ).refusal !== undefined,
  );
  const held = run([
    step("wait", { status: "waiting_signal", wait: OPEN_WAIT }),
  ]);
  assert(
    judge(
      held,
      run([
        step("wait", {
          status: "waiting_signal",
          wait: { ...OPEN_WAIT, id: "66666666-7777-4888-8999-aaaaaaaaaaaa" },
        }),
      ]),
    ).refusal !== undefined,
  );
  assert(
    judge(
      running,
      run([
        step("wait", {
          status: "succeeded",
          output: { type: "wait_for_signal", payload: { ok: true } },
        }),
      ]),
    ).refusal !== undefined,
  );
  assertEquals(judge(held, held).refusal, undefined);
  assertEquals(
    judge(held, run([step("wait", { status: "pending" })])).refusal,
    undefined,
  );
});

Deno.test("judgeRunRecord: a child's decision is accepted only on a step the stored workflow calls a child from, and a link cannot change on the way back to pending (swamp-club#4245)", () => {
  const nestedRun = { workflowId: OTHER, workflowName: "child", runId: ID };
  const held = { heldChild: () => ({ decisions: [DENIED] }) };
  const waiting = run([
    step("gate", { status: "waiting_approval", nestedRun }),
  ]);
  const decided = run([
    step("gate", { status: "failed", nestedRun, approvalDecision: DENIED }),
  ]);
  assert(
    judge(waiting, decided, { ...held, storedStepIsNested: () => false })
      .refusal !== undefined,
  );
  assertEquals(
    judge(waiting, decided, { ...held, storedStepIsNested: () => true })
      .refusal,
    undefined,
  );
  const gate = run([
    step("gate", { status: "waiting_approval", startedAt: STARTED }),
  ]);
  assert(
    judge(gate, run([step("gate", { status: "pending", nestedRun })]))
      .refusal !== undefined,
  );
  assertEquals(
    judge(gate, run([step("gate", { status: "pending" })])).refusal,
    undefined,
  );
});

Deno.test("judgeRunRecord: a record cannot name a prior owner that is a serve instance", () => {
  const owner = { pid: 1, instanceId: "old-leader" };
  assert(
    judge(run([]), run([], { ownerBeforeResume: owner })).refusal !== undefined,
  );
});

Deno.test("judgeRunRecord: deferred expressions and workflow artifacts a record adds are handed to serve to authorise", () => {
  const before = run([]);
  const judged = judge(
    before,
    run([], {
      deferredExpressions: [{ expression: "e" }],
      workflowDataArtifacts: [{ name: "a" }],
    } as unknown as Partial<WorkflowRunData>),
  );
  assertEquals(judged.refusal, undefined);
  assertEquals(judged.addedDeferred, [{ expression: "e" }]);
  assertEquals(judged.addedOutputs[0].dataArtifacts, [{ name: "a" }]);
});

function startOf(fields: Partial<StepStartData> = {}): StepStart {
  return StepStart.create({
    workflowId: WORKFLOW,
    runId: RUN,
    jobName: "main",
    stepName: "deploy",
    startedAt: Date.parse(STARTED),
    ...fields,
  });
}

function judgeStart(
  start: StepStart,
  record: WorkflowRunData | undefined,
  extra: Partial<RunStartContext> = {},
) {
  return judgeRunStart({
    workflowId: WORKFLOW,
    runId: RUN,
    fileName: start.fileName,
    content: start.toData(),
    record,
    ...extra,
  });
}

Deno.test("judgeRunStart: a member's start of its own member-driven run is taken", () => {
  assertEquals(judgeStart(startOf(), run([step("deploy")])), undefined);
});

Deno.test("judgeRunStart: a start carrying anything beyond a start, such as a decision, is refused", () => {
  const start = startOf();
  assert(
    judgeStart(start, run([step("deploy")]), {
      content: { ...start.toData(), approvalDecision: { approved: true } },
    }) !== undefined,
  );
  assert(
    judgeStart(start, run([step("deploy")]), { content: "deploy" }) !==
      undefined,
  );
});

Deno.test("judgeRunStart: a start naming another run or workflow, or held under another start's key, is refused", () => {
  const record = run([step("deploy")]);
  assert(judgeStart(startOf({ runId: OTHER }), record) !== undefined);
  assert(judgeStart(startOf({ workflowId: OTHER }), record) !== undefined);
  assert(
    judgeStart(startOf(), record, {
      fileName: startOf({ stepName: "other" }).fileName,
    }) !== undefined,
  );
});

Deno.test("judgeRunStart: a run with no stored record, or one serve drives, takes no forwarded start", () => {
  const principal = {
    kind: "user",
    id: "ana",
    membership: { localGroups: [], idpGroups: [], collectives: [] },
  } as WorkflowRunData["triggeringPrincipal"];
  assert(judgeStart(startOf(), undefined) !== undefined);
  assert(
    judgeStart(
      startOf(),
      run([step("deploy")], { triggeringPrincipal: principal }),
    ) !== undefined,
  );
  assert(
    judgeStart(startOf(), run([step("deploy")], { instanceId: "leader" })) !==
      undefined,
  );
});

Deno.test("runInitiatorRefusal: a new run names its creator's authenticated principal", () => {
  assertEquals(
    runInitiatorRefusal({ initiatedBy: "user:alice", caller: "user:alice" }),
    undefined,
  );
  for (const initiatedBy of ["user:bob", "ghost", undefined]) {
    const refusal = runInitiatorRefusal({ initiatedBy, caller: "user:alice" });
    assert(refusal !== undefined, String(initiatedBy));
    assertStringIncludes(refusal, "user:alice");
  }
});

Deno.test("runInitiatorRefusal: a child run keeps its parent's initiator, whoever creates it", () => {
  const parent = { initiatedBy: "user:alice" };
  assertEquals(
    runInitiatorRefusal({
      initiatedBy: "user:alice",
      caller: "user:bob",
      parent,
    }),
    undefined,
  );
  assert(
    runInitiatorRefusal({
      initiatedBy: "user:bob",
      caller: "user:bob",
      parent,
    }) !== undefined,
  );
});

Deno.test("runInitiatorRefusal: a serve with no authenticated caller checks nothing", () => {
  assertEquals(
    runInitiatorRefusal({ initiatedBy: "ghost", caller: undefined }),
    undefined,
  );
});

Deno.test("judgeRunRecord: a forwarded first record cannot set a client", () => {
  assert(
    judge(undefined, run([], { client: "integration:ops-slack" })).refusal !==
      undefined,
  );
  assertEquals(judge(undefined, run([])).refusal, undefined);
});

Deno.test("judgeRunRecord: a forwarded record cannot add or change a client", () => {
  assert(
    judge(run([]), run([], { client: "direct:cli" })).refusal !== undefined,
  );
  assert(
    judge(
      run([], { client: "direct:cli" }),
      run([], {
        client: "integration:ops-slack",
      }),
    ).refusal !== undefined,
  );
});

const gateOf = (fields: Partial<StepRunData>) =>
  run([step("gate", { startedAt: STARTED, ...fields })]);
const DECIDED_VIA = { ...DECIDED, client: "integration:ops-slack" };

Deno.test("judgeRunRecord: an older CLI that strips a decision's client can still resume", () => {
  assertEquals(
    judge(
      gateOf({ status: "waiting_approval", approvalDecision: DECIDED_VIA }),
      gateOf({ status: "succeeded", approvalDecision: DECIDED }),
    ).refusal,
    undefined,
  );
});

Deno.test("judgeRunRecord: only a missing client is tolerated on a decision", () => {
  const held = gateOf({
    status: "waiting_approval",
    approvalDecision: DECIDED_VIA,
  });
  for (
    const forwarded of [
      { ...DECIDED, client: "direct:cli" },
      DENIED,
      { ...DECIDED, decidedBy: "user:someone-else" },
      { ...DECIDED, reason: "changed" },
    ]
  ) {
    assert(
      judge(held, gateOf({ status: "succeeded", approvalDecision: forwarded }))
        .refusal !== undefined,
      JSON.stringify(forwarded),
    );
  }
  assert(
    judge(
      gateOf({ status: "waiting_approval", approvalDecision: DECIDED }),
      gateOf({ status: "succeeded", approvalDecision: DECIDED_VIA }),
    ).refusal !== undefined,
  );
});

Deno.test("judgeRunRecord: a nested step may hold its child's decision without the client an older CLI stripped", () => {
  const nestedRun = { workflowId: OTHER, workflowName: "child", runId: ID };
  const judged = (forwarded: StepRunData["approvalDecision"]) =>
    judge(
      run([step("call", { status: "waiting_approval", nestedRun })]),
      run([
        step("call", {
          status: "failed",
          nestedRun,
          approvalDecision: forwarded,
        }),
      ]),
      {
        storedStepIsNested: () => true,
        heldChild: () => ({
          decisions: [{ ...DENIED, client: "direct:cli" }],
        }),
      },
    );
  assertEquals(judged(DENIED).refusal, undefined);
  assert(judged({ ...DENIED, reason: "changed" }).refusal !== undefined);
});

const FAN_OUT_PLAN = {
  members: [{
    worker: "w-a",
    instanceUuid: "u-a",
    disposition: "dispatch" as const,
    batch: 0,
  }],
  plannedLanes: 1,
  maxFailures: null,
  batches: [["w-a"]],
  lanes: [{
    name: "patch[w-a]",
    worker: "w-a",
    instanceUuid: "u-a",
    steps: [],
  }],
};

const FAN_OUT_SNAPSHOT = {
  selector: { labels: { role: "web" }, platform: "linux" },
  workers: [{
    name: "w-a",
    labels: { role: "web" },
    platform: "linux",
    arch: "x86_64",
  }],
};

function fanOutRun(
  steps: StepRunData[],
  plan?: typeof FAN_OUT_PLAN,
  snapshot?: unknown,
): WorkflowRunData {
  return run([], {
    jobs: [{
      jobName: "patch",
      status: "running",
      steps,
      ...(plan ? { fanOutPlan: plan } : {}),
      ...(snapshot ? { fanOutSnapshot: snapshot } : {}),
    }],
  } as Partial<WorkflowRunData>);
}

Deno.test("judgeRunRecord: a fan-out plan is added once, while its job's steps are all pending, and the lanes then progress", () => {
  const planned = fanOutRun([step("apply[w-a]")], FAN_OUT_PLAN);
  assertEquals(judge(fanOutRun([step("apply")]), planned).refusal, undefined);
  assertEquals(
    judge(
      planned,
      fanOutRun([step("apply[w-a]", { status: "succeeded" })], FAN_OUT_PLAN),
    ).refusal,
    undefined,
  );
});

Deno.test("judgeRunRecord: a fan-out plan in a run's first record, or added after its job's steps began, is refused", () => {
  assertStringIncludes(
    judge(undefined, fanOutRun([step("apply[w-a]")], FAN_OUT_PLAN)).refusal ??
      "",
    "earlier record does not hold",
  );
  assertStringIncludes(
    judge(
      fanOutRun([step("apply", { status: "running" })]),
      fanOutRun([step("apply[w-a]")], FAN_OUT_PLAN),
    ).refusal ?? "",
    "after its steps began",
  );
});

Deno.test("judgeRunRecord: a recorded fan-out plan cannot be changed, dropped, or its job removed", () => {
  const planned = fanOutRun([step("apply[w-a]")], FAN_OUT_PLAN);
  assertStringIncludes(
    judge(
      planned,
      fanOutRun(
        [step("apply[w-a]")],
        { ...FAN_OUT_PLAN, maxFailures: 3 } as never,
      ),
    ).refusal ?? "",
    "changes the fan-out plan",
  );
  assertStringIncludes(
    judge(planned, fanOutRun([step("apply[w-a]")])).refusal ?? "",
    "changes the fan-out plan",
  );
  assertStringIncludes(
    judge(planned, run([])).refusal ?? "",
    "drops job 'patch'",
  );
});

Deno.test("judgeRunRecord: a fan-out plan whose lanes hold steps of their own is refused", () => {
  const withLaneSteps = {
    ...FAN_OUT_PLAN,
    lanes: [{
      ...FAN_OUT_PLAN.lanes[0],
      steps: [step("apply", { status: "succeeded" })] as never[],
    }],
  };
  assertStringIncludes(
    judge(
      fanOutRun([step("apply")]),
      fanOutRun([step("apply[w-a]")], withLaneSteps),
    ).refusal ?? "",
    "holds lane steps",
  );
});

Deno.test("judgeRunRecord: a fan-out snapshot written with its plan is accepted, and the lanes then progress", () => {
  const planned = fanOutRun(
    [step("apply[w-a]")],
    FAN_OUT_PLAN,
    FAN_OUT_SNAPSHOT,
  );
  assertEquals(judge(fanOutRun([step("apply")]), planned).refusal, undefined);
  assertEquals(
    judge(
      planned,
      fanOutRun(
        [step("apply[w-a]", { status: "succeeded" })],
        FAN_OUT_PLAN,
        FAN_OUT_SNAPSHOT,
      ),
    ).refusal,
    undefined,
  );
});

Deno.test("judgeRunRecord: a recorded fan-out snapshot cannot change its selector or a worker scope, or be dropped", () => {
  const planned = fanOutRun(
    [step("apply[w-a]")],
    FAN_OUT_PLAN,
    FAN_OUT_SNAPSHOT,
  );
  const changed = [
    { ...FAN_OUT_SNAPSHOT, selector: { labels: { role: "db" } } },
    {
      ...FAN_OUT_SNAPSHOT,
      workers: [{ ...FAN_OUT_SNAPSHOT.workers[0], arch: "arm64" }],
    },
    undefined,
  ];
  for (const snapshot of changed) {
    assertStringIncludes(
      judge(planned, fanOutRun([step("apply[w-a]")], FAN_OUT_PLAN, snapshot))
        .refusal ?? "",
      "changes the fan-out snapshot of job 'patch'",
    );
  }
});

Deno.test("judgeRunRecord: a fan-out snapshot added after its plan, or without a plan, is refused", () => {
  assertStringIncludes(
    judge(
      fanOutRun([step("apply[w-a]")], FAN_OUT_PLAN),
      fanOutRun([step("apply[w-a]")], FAN_OUT_PLAN, FAN_OUT_SNAPSHOT),
    ).refusal ?? "",
    "changes the fan-out snapshot of job 'patch'",
  );
  assertStringIncludes(
    judge(
      fanOutRun([step("apply")]),
      fanOutRun([step("apply")], undefined, FAN_OUT_SNAPSHOT),
    ).refusal ?? "",
    "adds a fan-out snapshot to job 'patch' without a fan-out plan",
  );
  assertStringIncludes(
    judge(undefined, fanOutRun([step("apply")], undefined, FAN_OUT_SNAPSHOT))
      .refusal ?? "",
    "adds a fan-out snapshot to job 'patch' without a fan-out plan",
  );
});

Deno.test("judgeRunRecord: a plan recorded without a snapshot, saved again unchanged, is accepted", () => {
  const planned = fanOutRun([step("apply[w-a]")], FAN_OUT_PLAN);
  assertEquals(judge(planned, planned).refusal, undefined);
  assertEquals(
    judge(
      planned,
      fanOutRun([step("apply[w-a]", { status: "succeeded" })], FAN_OUT_PLAN),
    ).refusal,
    undefined,
  );
});

const ROLLOUT_PLAN = {
  members: ["w-a", "w-b", "w-c"].map((worker, index) => ({
    worker,
    instanceUuid: `u-${worker}`,
    disposition: "dispatch" as const,
    batch: index === 0 ? 0 : 1,
  })),
  plannedLanes: 3,
  maxFailures: 0,
  batches: [["w-a"], ["w-b", "w-c"]],
  lanes: ["w-a", "w-b", "w-c"].map((worker) => ({
    name: `patch[${worker}]`,
    worker,
    instanceUuid: `u-${worker}`,
    steps: [],
  })),
};

const CANARY_HALT = {
  batch: 1,
  maxFailures: 0,
  failed: ["w-a"],
  held: ["w-b", "w-c"],
};

const HELD = { status: "skipped" as const, settledByAbort: true };

function rolloutRun(
  status: "running" | "failed",
  steps: StepRunData[],
  halts?: unknown[],
): WorkflowRunData {
  return run([], {
    jobs: [{
      jobName: "patch",
      status,
      steps,
      fanOutPlan: ROLLOUT_PLAN,
      ...(halts ? { fanOutHalts: halts } : {}),
    }],
  } as Partial<WorkflowRunData>);
}

const CANARY_FAILED = [
  step("apply[w-a]", { status: "failed" }),
  step("apply[w-b]"),
  step("apply[w-c]"),
];

const CANARY_HALTED = [
  step("apply[w-a]", { status: "failed" }),
  step("apply[w-b]", HELD),
  step("apply[w-c]", HELD),
];

Deno.test("judgeRunRecord: a fan-out halt is accepted once, in the record where its job fails", () => {
  const halted = rolloutRun("failed", CANARY_HALTED, [CANARY_HALT]);
  assertEquals(
    judge(rolloutRun("running", CANARY_FAILED), halted).refusal,
    undefined,
  );
  assertEquals(judge(halted, halted).refusal, undefined);
});

Deno.test("judgeRunRecord: a fan-out halt added while the job runs, or to a job that already ended, is refused", () => {
  assertStringIncludes(
    judge(
      rolloutRun("running", CANARY_FAILED),
      rolloutRun("running", CANARY_HALTED, [CANARY_HALT]),
    ).refusal ?? "",
    "other than in the record where the job fails",
  );
  assertStringIncludes(
    judge(
      rolloutRun("failed", CANARY_HALTED),
      rolloutRun("failed", CANARY_HALTED, [CANARY_HALT]),
    ).refusal ?? "",
    "other than in the record where the job fails",
  );
});

Deno.test("judgeRunRecord: a recorded fan-out halt cannot be changed or dropped, and only one is added at a time", () => {
  const halted = rolloutRun("failed", CANARY_HALTED, [CANARY_HALT]);
  for (
    const halts of [[{ ...CANARY_HALT, held: ["w-b"] }], [], undefined]
  ) {
    assertStringIncludes(
      judge(halted, rolloutRun("failed", CANARY_HALTED, halts)).refusal ?? "",
      "changes or drops a fan-out halt of job 'patch'",
    );
  }
  assertStringIncludes(
    judge(
      rolloutRun("running", CANARY_FAILED),
      rolloutRun("failed", CANARY_HALTED, [CANARY_HALT, CANARY_HALT]),
    ).refusal ?? "",
    "adds more than one fan-out halt",
  );
});

Deno.test("judgeRunRecord: a fan-out halt that does not match the plan or the lanes is refused", () => {
  const cases: [unknown, StepRunData[], string][] = [
    [{ ...CANARY_HALT, maxFailures: 1 }, CANARY_HALTED, "failure budget"],
    [
      { ...CANARY_HALT, failed: [] },
      CANARY_HALTED,
      "no more failed lanes than the budget",
    ],
    [
      { ...CANARY_HALT, batch: 2 },
      CANARY_HALTED,
      "names a batch the plan lacks",
    ],
    [
      { ...CANARY_HALT, held: ["w-b", "w-a"] },
      CANARY_HALTED,
      "names a lane more than once",
    ],
    [
      { ...CANARY_HALT, held: ["w-b", "w-z"] },
      CANARY_HALTED,
      "'w-z', not a lane of the plan",
    ],
    [
      CANARY_HALT,
      [
        step("apply[w-a]", { status: "failed" }),
        step("apply[w-b]", { status: "succeeded" }),
        step("apply[w-c]", HELD),
      ],
      "holds lane 'w-b', which started",
    ],
    [
      CANARY_HALT,
      [
        step("apply[w-a]", { status: "failed", allowedFailure: true }),
        step("apply[w-b]", HELD),
        step("apply[w-c]", HELD),
      ],
      "names lane 'w-a' as failed, and it did not fail",
    ],
  ];
  for (const [halt, steps, refusal] of cases) {
    assertStringIncludes(
      judge(
        rolloutRun("running", CANARY_FAILED),
        rolloutRun("failed", steps, [halt]),
      ).refusal ?? "",
      refusal,
    );
  }
});

Deno.test("judgeRunRecord: a fan-out halt on a job without a plan is refused", () => {
  const plain = (status: string, halts?: unknown[]) =>
    run([], {
      jobs: [{
        jobName: "patch",
        status,
        steps: [step("apply", { status: "failed" })],
        ...(halts ? { fanOutHalts: halts } : {}),
      }],
    } as Partial<WorkflowRunData>);
  assertStringIncludes(
    judge(plain("running"), plain("failed", [CANARY_HALT])).refusal ?? "",
    "has no fan-out plan",
  );
});

Deno.test("judgeRunRecord: a resumed attempt may append a second halt after the first", () => {
  const second = { ...CANARY_HALT, failed: ["w-a"], held: ["w-b", "w-c"] };
  assertEquals(
    judge(
      rolloutRun("running", CANARY_FAILED, [CANARY_HALT]),
      rolloutRun("failed", CANARY_HALTED, [CANARY_HALT, second]),
    ).refusal,
    undefined,
  );
});

Deno.test("judgeRunRecord: a held lane may keep a step it finished in an earlier attempt, but not one that failed, runs or waits", () => {
  const withW_B = (wb: StepRunData[]) =>
    rolloutRun("failed", [
      step("apply[w-a]", { status: "failed" }),
      ...wb,
      step("verify[w-c]", HELD),
    ], [CANARY_HALT]);
  const before = rolloutRun("running", [
    step("apply[w-a]", { status: "failed" }),
    step("apply[w-b]", { status: "succeeded" }),
    step("verify[w-b]"),
    step("verify[w-c]"),
  ]);
  assertEquals(
    judge(
      before,
      withW_B([
        step("apply[w-b]", { status: "succeeded" }),
        step("verify[w-b]", HELD),
      ]),
    ).refusal,
    undefined,
  );
  for (const other of ["failed", "running", "pending"] as const) {
    assertStringIncludes(
      judge(
        before,
        withW_B([
          step("apply[w-b]", { status: "succeeded" }),
          step("verify[w-b]", HELD),
          step("check[w-b]", { status: other }),
        ]),
      ).refusal ?? "",
      "holds lane 'w-b', which started",
    );
  }
});
