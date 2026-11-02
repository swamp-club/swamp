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
 * A model-based property test of {@link judgeRunRecord} (swamp-club#3922,
 * swamp-club#4245).
 *
 * It generates member-driven and serve-driven runs of plain steps and gates, and drives them through what a real run records and what serve's
 * handlers record. Between them, a member holding only `run` forges the next
 * record from the current one.
 *
 * A member's report of a run they drive is out of scope ("Run records: the
 * threat model" in `design/enablers/access-control.md`), so the oracle states
 * only what serve guarantees, across the history of what landed:
 * - a decision on a record is one serve's handler made, and a record never
 *   creates, changes or drops one, other than a retry clearing it;
 * - a record names no signal wait and carries no signal's outcome;
 * - a run serve drives takes no forwarded record;
 * - who triggered a run, its parent, vaults, initiator, plan and log are frozen;
 * - step keys are unique;
 * - every output a record sets is handed to serve to authorise.
 *
 * Every step a real runner records must still be accepted.
 *
 * @module
 */

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import {
  StepRun,
  type StepRunData,
  type WorkflowRunData,
} from "../workflows/workflow_run.ts";
import {
  canonicalRunLogFile,
  isCanonicalRunLogFile,
  judgeRunRecord,
  type RunRecordJudgement,
} from "./content_bindings.ts";

const WORKFLOW = "44444444-5555-4666-8777-888888888888";
const RUN = "33333333-4444-4555-8666-777777777777";
const T0 = "2026-10-26T00:00:00.000Z";
const FORGED_AT = "2020-01-01T00:00:00.000Z";

type Kind = "plain" | "gate";

interface StepSpec {
  readonly job: string;
  readonly name: string;
  readonly kind: Kind;
}

const workflowSpec = fc.array(
  fc.record({
    kind: fc.constantFrom<Kind>("plain", "gate"),
    job: fc.constantFrom("main", "post"),
  }),
  { minLength: 1, maxLength: 5 },
).map((specs) =>
  specs.map((spec, i): StepSpec => ({ ...spec, name: `s${i}` }))
);

function key(job: string, name: string): string {
  return `${job}/${name}`;
}

function stepsOf(record: WorkflowRunData): Map<string, StepRunData> {
  return new Map(
    record.jobs.flatMap((job) =>
      job.steps.map((step) => [key(job.jobName, step.stepName), step] as const)
    ),
  );
}

function initial(
  specs: readonly StepSpec[],
  fields: Partial<WorkflowRunData>,
): WorkflowRunData {
  const jobs = new Map<string, StepRunData[]>();
  for (const spec of specs) {
    const steps = jobs.get(spec.job) ?? [];
    steps.push({ stepName: spec.name, status: "pending" } as StepRunData);
    jobs.set(spec.job, steps);
  }
  return {
    id: RUN,
    workflowId: WORKFLOW,
    workflowName: "deploy",
    status: "running",
    tags: {},
    logFile: canonicalRunLogFile(WORKFLOW, RUN),
    initiatedBy: "user:ana",
    runPlan: { fingerprint: "plan" },
    jobs: [...jobs].map(([jobName, steps]) => ({
      jobName,
      status: "running",
      steps,
    })),
    ...fields,
  } as WorkflowRunData;
}

function withStep(
  record: WorkflowRunData,
  job: string,
  name: string,
  change: (step: StepRunData) => StepRunData | undefined,
): WorkflowRunData {
  const next = structuredClone(record);
  next.jobs = next.jobs.map((j) =>
    j.jobName !== job ? j : {
      ...j,
      steps: j.steps.flatMap((s) => {
        if (s.stepName !== name) return [s];
        const changed = change(structuredClone(s));
        return changed === undefined ? [] : [changed];
      }),
    }
  );
  return next;
}

function decision(approved: boolean, decidedBy = "user:approver") {
  return { approved, decidedBy, decidedAt: T0 };
}

interface Move {
  readonly label: string;
  readonly record: WorkflowRunData;
  /** Made by serve's handler, so never forwarded or judged. */
  readonly byServe?: boolean;
}

/** What a real run, or serve's handlers on its behalf, can record next. */
function moves(specs: readonly StepSpec[], record: WorkflowRunData): Move[] {
  const out: Move[] = [];
  const steps = stepsOf(record);
  for (const spec of specs) {
    const step = steps.get(key(spec.job, spec.name));
    if (step === undefined) continue;
    const move = (
      label: string,
      change: (s: StepRunData) => StepRunData,
      extra: Partial<Move> = {},
    ) =>
      out.push({
        label,
        record: withStep(record, spec.job, spec.name, change),
        ...extra,
      });
    switch (step.status) {
      case "pending":
        move(
          "step starts",
          (s) => ({ ...s, status: "running", startedAt: T0 }),
        );
        break;
      case "running":
        if (spec.kind === "plain") {
          move("step succeeds", (s) => ({
            ...s,
            status: "succeeded",
            output: { type: "model_method", step: spec.name },
          }));
        } else {
          move("gate waits", (s) => ({
            ...s,
            status: "waiting_approval",
            approvalPrompt: "Deploy?",
          }));
        }
        break;
      case "waiting_approval":
        if (step.approvalDecision === undefined) {
          move(
            "approver decides",
            (s) => ({ ...s, approvalDecision: decision(true) }),
            { byServe: true },
          );
          move(
            "approver denies",
            (s) => ({ ...s, approvalDecision: decision(false) }),
            { byServe: true },
          );
        } else {
          move("run applies a decision", (s) => ({
            ...s,
            status: s.approvalDecision!.approved ? "succeeded" : "failed",
          }));
        }
        break;
      case "failed":
        if (step.approvalDecision !== undefined) {
          move("a retry re-opens a gate", (s) => {
            const applied = StepRun.fromData(s);
            applied.resetToPending();
            return applied.toData();
          });
        }
        break;
    }
  }
  return out;
}

const forgeryChoice = fc.record({
  kind: fc.constantFrom(
    "decide",
    "change-decision",
    "clear-decision",
    "drop-step",
    "rename-step",
    "duplicate-step",
    "forge-signal",
    "forge-wait",
    "gate-fields",
    "frozen-field",
    "log-file",
    "set-output",
    "report-status",
    "take-over",
  ),
  pick: fc.nat(),
  field: fc.nat(),
  approved: fc.boolean(),
  status: fc.constantFrom<StepRunData["status"]>(
    "pending",
    "running",
    "waiting_approval",
    "waiting_signal",
    "succeeded",
    "failed",
    "skipped",
    "unknown",
  ),
});
type ForgeryChoice = typeof forgeryChoice extends fc.Arbitrary<infer T> ? T
  : never;

function forge(record: WorkflowRunData, c: ForgeryChoice): WorkflowRunData {
  const all = [...stepsOf(record).entries()];
  if (all.length === 0) return record;
  const [stepKey] = all[c.pick % all.length];
  const [job, name] = stepKey.split("/");
  const edit = (change: (s: StepRunData) => StepRunData | undefined) =>
    withStep(record, job, name, change);
  switch (c.kind) {
    case "decide":
      return edit((s) => ({
        ...s,
        status: c.status,
        approvalDecision: decision(c.approved, "user:forger"),
      }));
    case "change-decision":
      return edit((s) => ({
        ...s,
        approvalDecision: decision(
          !(s.approvalDecision?.approved ?? c.approved),
          s.approvalDecision?.decidedBy ?? "user:forger",
        ),
      }));
    case "clear-decision":
      return edit((s) => {
        const { approvalDecision: _dropped, ...cleared } = s;
        return { ...cleared, status: c.status };
      });
    case "drop-step":
      return edit(() => undefined);
    case "rename-step":
      return edit((s) => ({ ...s, stepName: `${s.stepName}-renamed` }));
    case "duplicate-step":
      return {
        ...record,
        jobs: record.jobs.map((j) =>
          j.jobName !== job ? j : {
            ...j,
            steps: [
              ...j.steps,
              { ...j.steps[c.field % j.steps.length], status: c.status },
            ],
          }
        ),
      };
    case "forge-signal":
      return edit((s) => ({
        ...s,
        status: "succeeded",
        output: { type: "wait_for_signal", payload: { forged: true } },
      }));
    case "forge-wait":
      return edit((s) => ({
        ...s,
        status: "waiting_signal",
        wait: {
          kind: "signal",
          id: "cccccccc-9999-4aaa-8bbb-000000000000",
          schema: { type: "object", properties: {} },
          deadline: "2030-01-01T00:00:00.000Z",
        },
      }));
    case "gate-fields": {
      const field = c.field % 3;
      return edit((s) => ({
        ...s,
        ...(field === 0 ? { approvalPrompt: "Deploy to prod?" } : {}),
        ...(field === 1 ? { approvalTimeout: 1 } : {}),
        ...(field === 2 ? { startedAt: FORGED_AT } : {}),
      }));
    }
    case "frozen-field": {
      const next = structuredClone(record);
      const field = c.field % 6;
      if (field === 0) {
        next.triggeringPrincipal = {
          kind: "user",
          id: "root",
          membership: { localGroups: [], idpGroups: [], collectives: [] },
        };
      }
      if (field === 1) next.parentRun = { workflowId: "forged" };
      if (field === 2) next.allowedVaults = ["prod"];
      if (field === 3) next.initiatedBy = "user:root";
      if (field === 4) next.runPlan = { fingerprint: "other" };
      if (field === 5) next.inheritedExpressions = ["injected"];
      return next;
    }
    case "log-file":
      return {
        ...record,
        logFile: ["/etc/passwd", "../../.swamp/serve.yaml"][c.field % 2],
      };
    case "set-output":
      return edit((s) => ({
        ...s,
        output: { type: "model_method", forged: c.field },
      }));
    case "report-status":
      return edit((s) => ({ ...s, status: c.status }));
    case "take-over":
      return { ...record, instanceId: "some-team-node" };
  }
  throw new Error("unknown forgery");
}

/** Why a record that landed breaks a guarantee, or undefined. */
function violation(
  before: WorkflowRunData,
  after: WorkflowRunData,
  judged: RunRecordJudgement,
): string | undefined {
  if (before.triggeringPrincipal !== undefined) {
    return "a serve-driven run took a forwarded record";
  }
  if (after.instanceId !== undefined) return "a record took the run over";
  for (
    const field of [
      "triggeringPrincipal",
      "parentRun",
      "allowedVaults",
      "initiatedBy",
      "runPlan",
      "inheritedExpressions",
    ] as const
  ) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
      return `frozen field ${field} changed`;
    }
  }
  if (
    after.logFile !== undefined &&
    !isCanonicalRunLogFile(after.logFile, WORKFLOW, RUN)
  ) {
    return "log file is not the run's own";
  }
  const prior = stepsOf(before);
  const next = stepsOf(after);
  const count = after.jobs.reduce((sum, job) => sum + job.steps.length, 0);
  if (next.size !== count) return "a step key is duplicated";
  for (const [k, was] of prior) {
    const is = next.get(k);
    if (was.approvalDecision !== undefined && is === undefined) {
      return `decided step ${k} dropped`;
    }
    if (is === undefined) continue;
    if (
      JSON.stringify(was.approvalDecision) !==
        JSON.stringify(is.approvalDecision) &&
      !(is.approvalDecision === undefined && is.status === "pending")
    ) {
      return `decision of ${k} made or changed by a record`;
    }
  }
  for (const [k, is] of next) {
    const was = prior.get(k);
    if (is.approvalDecision !== undefined && was === undefined) {
      return `decision of ${k} created by a record`;
    }
    if (
      is.wait !== undefined &&
      JSON.stringify(is.wait) !== JSON.stringify(was?.wait)
    ) {
      return `a record named a signal wait on ${k}`;
    }
    if (
      (is.output as { type?: string } | undefined)?.type ===
        "wait_for_signal" &&
      JSON.stringify(is.output) !== JSON.stringify(was?.output)
    ) {
      return `signal output of ${k} is not one serve holds`;
    }
    if (
      is.output !== undefined &&
      JSON.stringify(is.output) !== JSON.stringify(was?.output) &&
      !judged.addedOutputs.some((o) => key(o.jobName, o.stepName) === k)
    ) {
      return `output of ${k} set without being handed to serve`;
    }
  }
  return undefined;
}

interface Coverage {
  legit: Record<string, number>;
  forged: Record<string, number>;
  refused: number;
  landed: number;
}

function bump(counts: Record<string, number>, label: string): void {
  counts[label] = (counts[label] ?? 0) + 1;
}

const scenarioStep = fc.oneof(
  { weight: 3, arbitrary: fc.record({ legit: fc.nat() }) },
  { weight: 2, arbitrary: fc.record({ forge: forgeryChoice }) },
);

function play(
  specs: readonly StepSpec[],
  fields: Partial<WorkflowRunData>,
  scenario: readonly ({ legit: number } | { forge: ForgeryChoice })[],
  coverage: Coverage,
): string | undefined {
  const judge = (before: WorkflowRunData, after: WorkflowRunData) =>
    judgeRunRecord({
      workflowId: WORKFLOW,
      runId: RUN,
      before,
      after,
    });
  let record = initial(specs, fields);
  const serveDriven = fields.triggeringPrincipal !== undefined;
  for (const next of scenario) {
    if ("legit" in next) {
      const options = moves(specs, record);
      if (options.length === 0) continue;
      const move = options[next.legit % options.length];
      // On a serve-driven run every write is serve's own.
      if (!move.byServe && !serveDriven) {
        const judged = judge(record, move.record);
        if (judged.refusal !== undefined) {
          // Only a forgery that landed earlier can make a real move refused.
          if (coverage.landed === 0) {
            assertEquals(judged.refusal, undefined, move.label);
          }
          continue;
        }
      }
      bump(coverage.legit, move.label);
      record = move.record;
      continue;
    }
    bump(coverage.forged, next.forge.kind);
    const forged = forge(record, next.forge);
    const judged = judge(record, forged);
    if (judged.refusal !== undefined) {
      coverage.refused++;
      continue;
    }
    coverage.landed++;
    const broken = violation(record, forged, judged);
    if (broken !== undefined) return `${next.forge.kind}: ${broken}`;
    record = forged;
  }
  return undefined;
}

function newCoverage(): Coverage {
  return { legit: {}, forged: {}, refused: 0, landed: 0 };
}

const PRINCIPAL = {
  triggeringPrincipal: {
    kind: "user",
    id: "ana",
    membership: { localGroups: [], idpGroups: [], collectives: [] },
  },
} as Partial<WorkflowRunData>;

Deno.test("judgeRunRecord (model): every step a real run records is accepted", () => {
  const coverage = newCoverage();
  fc.assert(
    fc.property(
      workflowSpec,
      fc.array(fc.record({ legit: fc.nat() }), { maxLength: 40 }),
      (specs, scenario) => {
        assertEquals(play(specs, {}, scenario, coverage), undefined);
      },
    ),
    { numRuns: 1000 },
  );
  console.log("real moves tried:", JSON.stringify(coverage.legit));
  for (
    const label of [
      "gate waits",
      "approver decides",
      "approver denies",
      "run applies a decision",
      "a retry re-opens a gate",
    ]
  ) {
    assert((coverage.legit[label] ?? 0) > 0, `never tried: ${label}`);
  }
});

Deno.test("judgeRunRecord (model): no forged record that lands breaks what serve guarantees", () => {
  const coverage = newCoverage();
  fc.assert(
    fc.property(
      workflowSpec,
      fc.array(scenarioStep, { maxLength: 40 }),
      (specs, scenario) => {
        const broken = play(specs, {}, scenario, coverage);
        assertEquals(broken, undefined, broken);
      },
    ),
    { numRuns: 5000 },
  );
  console.log(
    "forgeries tried:",
    JSON.stringify(coverage.forged),
    "refused:",
    coverage.refused,
    "landed:",
    coverage.landed,
  );
  assert(Object.keys(coverage.forged).length === 14, "a forgery was not tried");
  assert(coverage.refused > 0 && coverage.landed > 0);
});

Deno.test("judgeRunRecord (model): no forged record lands on a run serve drives", () => {
  const coverage = newCoverage();
  fc.assert(
    fc.property(
      workflowSpec,
      fc.array(scenarioStep, { maxLength: 20 }),
      (specs, scenario) => {
        const broken = play(specs, PRINCIPAL, scenario, coverage);
        assertEquals(broken, undefined, broken);
      },
    ),
    { numRuns: 1000 },
  );
  assertEquals(coverage.landed, 0);
  assert(coverage.refused > 0);
});
