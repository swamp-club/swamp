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
import type { Step } from "../workflows/step.ts";
import type { WaitOutcome } from "../workflows/signal_wait_records.ts";
import {
  StepRun,
  type StepRunData,
  type WorkflowRunData,
} from "../workflows/workflow_run.ts";
import {
  identityRefusal,
  isCanonicalRunLogFile,
  judgeRunRecord,
  omittedWait,
  runIdentityRefusal,
  type RunRecordContext,
  type StepKind,
  storedStepOf,
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
    maySkip: () => true,
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

Deno.test("judgeRunRecord: reaching a gate is reported; deciding or completing it without a held decision is refused", () => {
  const reached = judge(
    run([step("gate", { status: "running" })]),
    run([step("gate", { status: "waiting_approval", startedAt: STARTED })]),
  );
  assertEquals(reached.refusal, undefined);
  const waiting = run([
    step("gate", { status: "waiting_approval", startedAt: STARTED }),
  ]);
  assert(
    judge(
      waiting,
      run([step("gate", { status: "succeeded", startedAt: STARTED })]),
    ).refusal !== undefined,
  );
  assert(
    judge(
      waiting,
      run([
        step("gate", {
          status: "waiting_approval",
          startedAt: STARTED,
          approvalDecision: DECIDED,
        }),
      ]),
    ).refusal !== undefined,
  );
});

Deno.test("judgeRunRecord: a gate decided before, settled by a cancel, or past its deadline completes on the record alone", () => {
  const decided = run([
    step("gate", {
      status: "waiting_approval",
      startedAt: STARTED,
      approvalDecision: DECIDED,
    }),
  ]);
  assertEquals(
    judge(
      decided,
      run([
        step("gate", {
          status: "succeeded",
          startedAt: STARTED,
          approvalDecision: DECIDED,
        }),
      ]),
    ).refusal,
    undefined,
  );
  const waiting = run([
    step("gate", { status: "waiting_approval", startedAt: STARTED }),
  ], { status: "suspended" });
  assertEquals(
    judge(
      waiting,
      run([
        step("gate", {
          status: "failed",
          startedAt: STARTED,
          settledByAbort: true,
        }),
      ], { status: "cancelled" }),
    ).refusal,
    undefined,
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
  assertEquals(timedOut(60).refusal, undefined);
  assert(timedOut(86_400).refusal !== undefined);
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

Deno.test("judgeRunRecord: a nested-call step's wait ends as succeeded only when its stored child did", () => {
  const nestedRun = { workflowId: OTHER, workflowName: "child", runId: ID };
  const end = (status: WorkflowRunData["status"] | undefined) =>
    judge(
      run([step("call", { status: "waiting_approval", nestedRun })]),
      run([step("call", { status: "succeeded", nestedRun })]),
      { call: "unknown" },
      {
        heldChild: () =>
          status === undefined ? undefined : { status, decisions: [] },
      },
    );
  assertEquals(end("succeeded").refusal, undefined);
  assert(end("suspended").refusal !== undefined);
  assert(end(undefined).refusal !== undefined);
});

Deno.test("judgeRunRecord: a wait's outcome is refused without a stored outcome; registering it is reported", () => {
  const registered = judge(
    run([step("wait", { status: "running" })]),
    run([step("wait", { status: "waiting_signal", wait: { key: "k" } })]),
  );
  assertEquals(registered.refusal, undefined);
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
  assert(signalled.refusal !== undefined);
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
  assertEquals(same.refusal, undefined);
});

Deno.test("judgeRunRecord: a gate the stored workflow no longer names cannot be reopened, or have its prompt dropped, to settle it undecided", () => {
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
  assert(judge(waiting, reopened, { gate: "unknown" }).refusal !== undefined);
  // Dropping the prompt in the same move is refused outright.
  assert(
    judge(
      waiting,
      run([step("gate", { status: "running", startedAt: STARTED })]),
      { gate: "unknown" },
    ).refusal !== undefined,
  );
  // Second commit: still a gate by its prompt, so completing it is refused.
  assert(
    judge(
      reopened,
      run([
        step("gate", {
          status: "succeeded",
          startedAt: STARTED,
          approvalPrompt: "Deploy?",
        }),
      ]),
      { gate: "unknown" },
    ).refusal !== undefined,
  );
});

Deno.test("judgeRunRecord: a gate the run skips without waiting on it is reported; skipping a waiting or decided gate is refused", () => {
  assertEquals(
    judge(
      run([step("gate", { status: "pending" })]),
      run([step("gate", { status: "skipped" })]),
    ).refusal,
    undefined,
  );
  assertEquals(
    judge(undefined, run([step("gate", { status: "skipped" })])).refusal,
    undefined,
  );
  assert(
    judge(
      run([step("gate", { status: "waiting_approval", startedAt: STARTED })]),
      run([step("gate", { status: "skipped", startedAt: STARTED })]),
    ).refusal !== undefined,
  );
  assert(
    judge(
      run([step("gate", { status: "pending", approvalDecision: DECIDED })]),
      run([step("gate", { status: "skipped", approvalDecision: DECIDED })]),
    ).refusal !== undefined,
  );
});

Deno.test("judgeRunRecord: a waiting gate or wait retyped in the stored workflow still cannot settle", () => {
  assert(
    judge(
      run([step("gate", { status: "waiting_approval", startedAt: STARTED })]),
      run([step("gate", { status: "succeeded", startedAt: STARTED })]),
      { gate: "other" },
    ).refusal !== undefined,
  );
  assert(
    judge(
      run([step("wait", { status: "waiting_signal", wait: { key: "k" } })]),
      run([step("wait", { status: "succeeded", wait: { key: "k" } })]),
      { wait: "other" },
    ).refusal !== undefined,
  );
});

Deno.test("judgeRunRecord: a waiting step cannot be dropped, renamed, or given a child run to end its wait unjudged", () => {
  const waiting = run([
    step("gate", { status: "waiting_approval", startedAt: STARTED }),
  ]);
  assert(judge(waiting, run([])).refusal !== undefined);
  assert(
    judge(
      waiting,
      run([step("renamed", { status: "succeeded", startedAt: STARTED })]),
    ).refusal !== undefined,
  );
  const nestedRun = { workflowId: OTHER, workflowName: "child", runId: ID };
  // Retyped, then given a child run while it waits.
  assert(
    judge(
      waiting,
      run([
        step("gate", {
          status: "waiting_approval",
          startedAt: STARTED,
          nestedRun,
        }),
      ]),
      { gate: "other" },
    ).refusal !== undefined,
  );
  // Nor in the record that completes it.
  assert(
    judge(
      waiting,
      run([
        step("gate", { status: "succeeded", startedAt: STARTED, nestedRun }),
      ]),
      { gate: "other" },
    ).refusal !== undefined,
  );
});

Deno.test("judgeRunRecord: a signal wait moved back out of waiting is refused, and an approval gate never waits on a child run", () => {
  assert(
    judge(
      run([step("wait", { status: "waiting_signal", wait: { key: "k" } })]),
      run([step("wait", { status: "pending", wait: { key: "k" } })]),
    ).refusal !== undefined,
  );
  const nestedRun = { workflowId: OTHER, workflowName: "child", runId: ID };
  assert(
    judge(
      run([step("gate", { status: "running", startedAt: STARTED })]),
      run([
        step("gate", {
          status: "waiting_approval",
          startedAt: STARTED,
          nestedRun,
        }),
      ]),
    ).refusal !== undefined,
  );
});

const DENIED = { ...DECIDED, approved: false };

Deno.test("judgeRunRecord: a denial fails its gate; skipping or completing a denied gate, waiting or settled, is refused", () => {
  const denied = (status: StepRunData["status"]) =>
    run([
      step("gate", {
        status,
        startedAt: STARTED,
        approvalPrompt: "Deploy?",
        approvalDecision: DENIED,
      }),
    ]);
  for (
    const [from, to] of [
      ["waiting_approval", "skipped"],
      ["failed", "skipped"],
      ["failed", "succeeded"],
      // Re-opened with its decision kept, then settled.
      ["pending", "skipped"],
      ["running", "skipped"],
      ["running", "succeeded"],
    ] as const
  ) {
    assert(
      judge(denied(from), denied(to)).refusal !== undefined,
      `${from} -> ${to}`,
    );
  }
  // What a run does with a denial is reported.
  assertEquals(
    judge(denied("waiting_approval"), denied("failed")).refusal,
    undefined,
  );
  assertEquals(
    judge(denied("failed"), denied("waiting_approval")).refusal,
    undefined,
  );
});

Deno.test("judgeRunRecord: a decided gate retyped in the stored workflow, or linked to a child run, still cannot settle against its decision", () => {
  const nestedRun = { workflowId: OTHER, workflowName: "child", runId: ID };
  const denied = (
    status: StepRunData["status"],
    fields: Partial<StepRunData> = {},
  ) =>
    run([
      step("gate", {
        status,
        startedAt: STARTED,
        approvalPrompt: "Deploy?",
        approvalDecision: DENIED,
        ...fields,
      }),
    ]);
  for (const to of ["succeeded", "skipped"] as const) {
    assert(
      judge(denied("failed"), denied(to), { gate: "other" }).refusal !==
        undefined,
      `retyped: failed -> ${to}`,
    );
    assert(
      judge(
        denied("failed", { nestedRun }),
        denied(to, { nestedRun }),
        { gate: "other" },
      ).refusal !== undefined,
      `retyped and linked: failed -> ${to}`,
    );
  }
  // The link itself decides nothing, and a denied gate still fails with run.
  const linked = judge(denied("failed"), denied("failed", { nestedRun }), {
    gate: "other",
  });
  assertEquals(linked.refusal, undefined);
  assertEquals(
    judge(
      denied("waiting_approval", { nestedRun }),
      denied("failed", { nestedRun }),
      { gate: "other" },
    ).refusal,
    undefined,
  );
});

Deno.test("judgeRunRecord: a decided step cannot be dropped or renamed, so a later record cannot re-add it undecided", () => {
  const decided = run([
    step("gate", {
      status: "failed",
      startedAt: STARTED,
      approvalPrompt: "Deploy?",
      approvalDecision: DENIED,
    }),
  ]);
  assert(judge(decided, run([])).refusal !== undefined);
  assert(
    judge(
      decided,
      run([
        step("renamed", {
          status: "failed",
          startedAt: STARTED,
          approvalDecision: DENIED,
        }),
      ]),
    ).refusal !== undefined,
  );
  // An undecided settled step may still leave the record.
  assertEquals(
    judge(
      run([step("gate", { status: "failed", startedAt: STARTED })]),
      run([]),
    )
      .refusal,
    undefined,
  );
});

Deno.test("judgeRunRecord: a job or run succeeded over a waiting or denied step is refused (swamp-club#4044)", () => {
  const denied = step("gate", {
    status: "failed",
    startedAt: STARTED,
    approvalDecision: DENIED,
  });
  const waiting = step("gate", {
    status: "waiting_approval",
    startedAt: STARTED,
  });
  for (const held of [denied, waiting]) {
    assert(
      judge(
        run([held]),
        {
          ...run([held]),
          jobs: [{ jobName: "main", status: "succeeded", steps: [held] }],
        },
      ).refusal !== undefined,
    );
    assert(
      judge(run([held]), run([held], { status: "succeeded" })).refusal !==
        undefined,
    );
  }
  // A denial the stored step allows does not hold its job back.
  const allowed = { ...denied, allowedFailure: true };
  assertEquals(
    judge(
      run([allowed]),
      {
        ...run([allowed]),
        status: "succeeded",
        jobs: [{ jobName: "main", status: "succeeded", steps: [allowed] }],
      },
    ).refusal,
    undefined,
  );
});

Deno.test("judgeRunRecord: allowing a denial's failure is the stored step's to say", () => {
  const denied = step("gate", {
    status: "failed",
    startedAt: STARTED,
    approvalDecision: DENIED,
  });
  const allowed = { ...denied, allowedFailure: true };
  assert(judge(run([denied]), run([allowed])).refusal !== undefined);
  assertEquals(
    judge(run([denied]), run([allowed]), undefined, {
      definitionSteps: () =>
        [{ name: "gate", allowFailure: true }] as unknown as ReadonlyArray<
          Step
        >,
    }).refusal,
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
  const judged = (decisions: readonly unknown[] | undefined) =>
    judge(waiting, rejected, { call: "other" }, {
      heldChild: () =>
        decisions === undefined ? undefined : { status: "failed", decisions },
    });
  assertEquals(judged([DENIED]).refusal, undefined);
  assert(judged([DECIDED]).refusal !== undefined);
  assert(judged([]).refusal !== undefined);
  assert(judged(undefined).refusal !== undefined);
});

Deno.test("judgeRunRecord: a duplicate step key is refused, so it cannot shadow a waiting or decided step (swamp-club#4046)", () => {
  const waiting = step("gate", {
    status: "waiting_approval",
    startedAt: STARTED,
  });
  assert(
    judge(
      run([waiting]),
      run([waiting, step("gate", { status: "succeeded" })]),
    ).refusal !== undefined,
  );
  // The same step name in another job is another step.
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

Deno.test("judgeRunRecord: a decided gate's status never changes outside a retry ", () => {
  const decided = (status: StepRunData["status"]) =>
    run([
      step("gate", {
        status,
        startedAt: STARTED,
        approvalDecision: DENIED,
      }),
    ]);
  assert(judge(decided("failed"), decided("unknown")).refusal !== undefined);
  assert(judge(decided("failed"), decided("running")).refusal !== undefined);
});

Deno.test("judgeRunRecord: only a retry of an ended run clears a decision, and the re-opened gate must wait again", () => {
  const denied = run([
    step("gate", {
      status: "failed",
      startedAt: STARTED,
      approvalDecision: DENIED,
    }),
  ], { status: "failed" });
  const reopened = run([
    step("gate", { status: "pending", resetByResume: true }),
  ]);
  assert(
    judge(denied, run([step("gate", { status: "failed" })])).refusal !==
      undefined,
  );
  assert(
    judge(denied, run([step("gate", { status: "pending" })])).refusal !==
      undefined,
  );
  assertEquals(judge(denied, reopened).refusal, undefined);
  // A run still going has nothing to retry.
  assert(
    judge({ ...denied, status: "running" }, reopened).refusal !== undefined,
  );
  // It may wait again, but neither skip the denial nor lose its mark.
  assertEquals(
    judge(reopened, run([step("gate", { status: "running" })])).refusal,
    undefined,
  );
  assert(
    judge(reopened, run([step("gate", { status: "skipped" })]), undefined, {
      maySkip: () => false,
    }).refusal !== undefined,
  );
  assert(
    judge(reopened, run([step("gate", { status: "pending" })])).refusal !==
      undefined,
  );
  // Nor shed it by going back through running.
  assert(
    judge(
      run([step("gate", { status: "running" })]),
      run([step("gate", { status: "pending" })]),
    ).refusal !== undefined,
  );
  assert(
    judge(
      run([step("gate", { status: "running" })]),
      run([step("gate", { status: "succeeded" })]),
    ).refusal !== undefined,
  );
});

Deno.test("judgeRunRecord: a gate or signal wait is skipped only when its stored workflow gives it something to skip it", () => {
  const noGuard = { maySkip: () => false };
  for (const name of ["gate", "wait"]) {
    assert(
      judge(
        run([step(name)]),
        run([step(name, { status: "skipped" })]),
        undefined,
        noGuard,
      ).refusal !== undefined,
      name,
    );
    assertEquals(
      judge(run([step(name)]), run([step(name, { status: "skipped" })]))
        .refusal,
      undefined,
      name,
    );
  }
  // A cancel settles a gate it never started.
  assertEquals(
    judge(
      run([step("gate")]),
      run([step("gate", { status: "skipped", settledByAbort: true })], {
        status: "cancelled",
      }),
      undefined,
      noGuard,
    ).refusal,
    undefined,
  );
});

Deno.test("judgeRunRecord: a job or run cannot succeed over what an abort settled", () => {
  const settled = step("gate", { status: "skipped", settledByAbort: true });
  assert(
    judge(run([settled]), run([settled], { status: "succeeded" })).refusal !==
      undefined,
  );
});

Deno.test("judgeRunRecord: a nested step succeeds only as its child did, whichever way it left its wait or whatever it holds", () => {
  const nestedRun = { workflowId: OTHER, workflowName: "child", runId: ID };
  const waiting = run([
    step("call", { status: "waiting_approval", nestedRun }),
  ]);
  const suspended = {
    heldChild: () => ({ status: "suspended" as const, decisions: [DECIDED] }),
  };
  const kinds = { call: "nested" as StepKind };
  // Out of the wait in a first commit.
  for (const status of ["running", "pending", "unknown"] as const) {
    assert(
      judge(
        waiting,
        run([step("call", { status, nestedRun })]),
        kinds,
        suspended,
      ).refusal !== undefined,
      status,
    );
  }
  // From anywhere else, and with no link at all.
  assert(
    judge(
      run([step("call", { status: "running", nestedRun })]),
      run([step("call", { status: "succeeded", nestedRun })]),
      kinds,
      suspended,
    ).refusal !== undefined,
  );
  assert(
    judge(
      run([step("call", { status: "running" })]),
      run([step("call", { status: "succeeded" })]),
      kinds,
    ).refusal !== undefined,
  );
  // Copying an approval from a child with another gate waiting.
  assert(
    judge(
      waiting,
      run([
        step("call", {
          status: "succeeded",
          nestedRun,
          approvalDecision: DECIDED,
        }),
      ]),
      kinds,
      suspended,
    ).refusal !== undefined,
  );
});

Deno.test("judgeRunRecord: a signal step reaches succeeded only by its stored outcome, whichever way it got there", () => {
  for (
    const before of [
      step("wait", { status: "running" }),
      step("wait", { status: "pending", resetByResume: true }),
    ]
  ) {
    assert(
      judge(run([before]), run([step("wait", { status: "succeeded" })]))
        .refusal !== undefined,
    );
  }
  assert(
    judge(undefined, run([step("wait", { status: "succeeded" })])).refusal !==
      undefined,
  );
});

Deno.test("judgeRunRecord: a re-opened gate with a guard or dependency reports its skip; without one it must wait", () => {
  const marked = run([step("gate", { resetByResume: true })]);
  const skipped = run([step("gate", { status: "skipped" })]);
  assert(
    judge(marked, skipped, undefined, { maySkip: () => false }).refusal !==
      undefined,
  );
  assertEquals(
    judge(marked, skipped, undefined, { maySkip: () => true }).refusal,
    undefined,
  );
  assertEquals(
    judge(marked, run([step("gate", { status: "failed" })])).refusal,
    undefined,
  );
});

Deno.test("judgeRunRecord: an allowance is the stored step's to set at any status, so setting it before a failure gains nothing", () => {
  const waiting = { status: "waiting_approval" as const, startedAt: STARTED };
  assert(
    judge(
      run([step("gate", waiting)]),
      run([step("gate", { ...waiting, allowedFailure: true })]),
    ).refusal !== undefined,
  );
  assert(
    judge(
      run([step("deploy", { status: "running" })]),
      run([step("deploy", { status: "running", allowedFailure: true })]),
    ).refusal !== undefined,
  );
});

Deno.test("judgeRunRecord: a job or run succeeds only once every step has finished", () => {
  for (const status of ["pending", "running", "unknown"] as const) {
    const left = run([step("gate", { status })]);
    left.jobs[0].status = "succeeded";
    assert(judge(undefined, left).refusal !== undefined, status);
    assert(
      judge(undefined, run([step("gate", { status })], { status: "succeeded" }))
        .refusal !== undefined,
      status,
    );
  }
});

Deno.test("judgeRunRecord: a record cannot open a wait serve already holds an outcome for", () => {
  const held = {
    heldOutcome: () =>
      ({ kind: "accepted", waitId: WAIT_ID }) as unknown as WaitOutcome,
  };
  const opening = run([
    step("wait", { status: "waiting_signal", wait: openWait }),
  ]);
  const before = run([step("wait", { status: "running" })]);
  assert(judge(before, opening, undefined, held).refusal !== undefined);
  assertEquals(judge(before, opening).refusal, undefined);
  // A wait already open stays open once its signal arrives.
  assertEquals(judge(opening, opening, undefined, held).refusal, undefined);
});

Deno.test("judgeRunRecord: what a step expands from is frozen, and never overrides its stored name", () => {
  assert(
    judge(
      run([step("gate")]),
      run([step("gate", { forEachTemplate: "build" })]),
    ).refusal !== undefined,
  );
  const stored = [
    { name: "gate" },
    { name: "build", allowFailure: true },
    { name: "each", forEach: { in: "x" } },
  ] as unknown as Step[];
  assertEquals(
    storedStepOf(stored, { stepName: "gate", forEachTemplate: "build" })?.name,
    "gate",
  );
  assertEquals(
    storedStepOf(stored, { stepName: "x", forEachTemplate: "build" }),
    undefined,
  );
  assertEquals(
    storedStepOf(stored, { stepName: "each-0", forEachTemplate: "each" })?.name,
    "each",
  );
});

Deno.test("judgeRunRecord: a job or run cannot succeed by leaving a stored gate out", () => {
  const storedWaits = [
    { jobName: "main", stepName: "gate", expands: false },
    { jobName: "main", stepName: "each", expands: true },
  ];
  const left = {
    ...run([step("deploy", { status: "succeeded" })], { status: "succeeded" }),
  };
  assert(
    judge(undefined, left, undefined, { storedWaits }).refusal !== undefined,
  );
  const job = run([step("deploy", { status: "succeeded" })]);
  job.jobs[0].status = "succeeded";
  assert(
    judge(undefined, job, undefined, { storedWaits }).refusal !== undefined,
  );
  assertEquals(
    omittedWait(run([step("gate", { status: "succeeded" })]), storedWaits),
    undefined,
  );
});

Deno.test("judgeRunRecord: a held outcome applies only to the wait the prior record shows open on that step", () => {
  const output = { type: "wait_for_signal", payload: { ok: true } };
  const held = {
    heldOutcome: () =>
      ({
        kind: "accepted",
        waitId: WAIT_ID,
        payload: { ok: true },
      }) as unknown as WaitOutcome,
  };
  for (const prior of ["pending", "running"] as const) {
    assert(
      judge(
        run([step("wait", { status: prior })]),
        run([step("wait", { status: "succeeded", wait: openWait, output })]),
        undefined,
        held,
      ).refusal !== undefined,
      prior,
    );
  }
});

const WAIT_ID = "55555555-6666-4777-8888-999999999999";
const openWait = {
  kind: "signal",
  id: WAIT_ID,
  schema: { type: "object", properties: {} },
  deadline: "2026-10-27T00:00:00.000Z",
};

Deno.test("judgeRunRecord: a signal's outcome must be the one serve stores, applied as a run applies it", () => {
  const outcome: WaitOutcome = {
    kind: "accepted",
    waitId: WAIT_ID,
    workflowId: WORKFLOW,
    runId: RUN,
    deadline: openWait.deadline,
    settledAt: STARTED,
    receipt: {
      id: "66666666-7777-4888-8999-aaaaaaaaaaaa",
      waitId: WAIT_ID,
      receivedAt: STARTED,
      submittedBy: "user:ana",
    },
    payload: { ok: true },
  } as unknown as WaitOutcome;
  const waiting = StepRun.fromData(
    step("wait", { status: "waiting_signal", wait: openWait }),
  );
  assert(waiting.applyWaitOutcome(outcome));
  const settled = waiting.toData();
  const before = run([
    step("wait", { status: "waiting_signal", wait: openWait }),
  ]);
  const judged = (held: WaitOutcome | undefined, after: StepRunData) =>
    judge(before, run([after]), undefined, { heldOutcome: () => held });
  assertEquals(judged(outcome, settled).refusal, undefined);
  assert(judged(undefined, settled).refusal !== undefined);
  assert(
    judged(outcome, {
      ...settled,
      output: { type: "wait_for_signal", payload: { ok: false } },
    }).refusal !== undefined,
  );
});

Deno.test("judgeRunRecord: a signal wait fails on its record's deadline, a stored non-signal outcome or a cancel only", () => {
  const before = (deadline: string) =>
    run([
      step("wait", {
        status: "waiting_signal",
        wait: { ...openWait, deadline },
      }),
    ]);
  const failed = (deadline: string) =>
    run([
      step("wait", {
        status: "failed",
        error: "timed out",
        wait: { ...openWait, deadline },
      }),
    ]);
  const past = "2026-10-26T11:00:00.000Z";
  const ahead = "2026-10-27T00:00:00.000Z";
  assertEquals(judge(before(past), failed(past)).refusal, undefined);
  assert(judge(before(ahead), failed(ahead)).refusal !== undefined);
  assertEquals(
    judge(before(ahead), failed(ahead), undefined, {
      heldOutcome: () =>
        ({ kind: "timed_out", waitId: WAIT_ID }) as unknown as WaitOutcome,
    }).refusal,
    undefined,
  );
  // The deadline is frozen while the step waits.
  assert(
    judge(
      before(ahead),
      run([
        step("wait", {
          status: "waiting_signal",
          wait: { ...openWait, deadline: past },
        }),
      ]),
    ).refusal !== undefined,
  );
});
