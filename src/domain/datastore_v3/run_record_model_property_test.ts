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
 * A model-based property test of {@link judgeRunRecord} (swamp-club#3922).
 *
 * It generates workflows of plain steps, approval gates (with and without a
 * guard, with and without a deadline), signal waits, nested workflow steps
 * and forEach expansions, and drives runs of them through the transitions a
 * real run records: a runner holding only `run`, an approver holding
 * `approve`, a signaller holding `signal`, and a cancel. Between them, an
 * attacker holding only `run` forges the next record from the current one,
 * and may also retype a step in the stored workflow (as a caller with write
 * on it can).
 *
 * Two properties, each against an oracle stated from the records alone:
 * - every transition the model makes is accepted with exactly the actions
 *   it needs;
 * - every forged record the judge would let a run-only caller land keeps
 *   the run's guarantees, across the whole history of what landed: a gate
 *   that waited settles without `approve` only by a cancel's settlement or
 *   its deadline (taken from what the record held when the wait began), or
 *   by completing a decision an approver recorded, and its prompt, timeout
 *   and start hold while it waits; a signal wait settles
 *   without `signal` only by a cancel's settlement; a waiting step never
 *   disappears; decisions never change; frozen fields never change; the log
 *   is the run's own; and every output it sets is handed to serve to check.
 *
 * Coverage of what was tried is printed per property.
 *
 * @module
 */

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import type {
  StepRunData,
  WorkflowRunData,
} from "../workflows/workflow_run.ts";
import {
  canonicalRunLogFile,
  isCanonicalRunLogFile,
  judgeRunRecord,
  type RunRecordJudgement,
  type StepKind,
} from "./content_bindings.ts";

const WORKFLOW = "44444444-5555-4666-8777-888888888888";
const RUN = "33333333-4444-4555-8666-777777777777";
const CHILD_WORKFLOW = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
const FOREIGN = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const T0 = "2026-10-26T00:00:00.000Z";
const NOW = new Date("2026-10-26T00:20:00.000Z");
/** Deadlines: one long passed by NOW, one far ahead. */
const SHORT = 60;
const LONG = 864_000;

type Kind = "plain" | "gate" | "guarded" | "signal" | "nested";

interface StepSpec {
  readonly job: string;
  readonly name: string;
  /** The step the definition holds, for a forEach expansion. */
  readonly template?: string;
  readonly kind: Kind;
  readonly timeout?: number;
}

/** What the stored workflow says each step (by job and template) is. */
type StoredKinds = Map<string, StepKind>;

function storedKindOf(kind: Kind): StepKind {
  switch (kind) {
    case "gate":
    case "guarded":
      return "approval";
    case "signal":
      return "signal";
    default:
      return "other";
  }
}

const workflowSpec = fc.array(
  fc.record({
    kind: fc.constantFrom<Kind>("plain", "gate", "guarded", "signal", "nested"),
    expand: fc.integer({ min: 0, max: 2 }),
    timeout: fc.constantFrom<number | undefined>(undefined, SHORT, LONG),
    job: fc.constantFrom("main", "post"),
  }),
  { minLength: 1, maxLength: 5 },
).map((specs) =>
  specs.flatMap((spec, i): StepSpec[] => {
    const name = `s${i}`;
    const timeout = spec.kind === "gate" ? spec.timeout : undefined;
    if (spec.expand === 0) {
      return [{ job: spec.job, name, kind: spec.kind, timeout }];
    }
    return Array.from({ length: spec.expand }, (_, n) => ({
      job: spec.job,
      name: `${name}-${n}`,
      template: name,
      kind: spec.kind,
      timeout,
    }));
  })
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

function clone<T>(value: T): T {
  return structuredClone(value);
}

function initial(specs: readonly StepSpec[]): WorkflowRunData {
  const jobs = new Map<string, StepRunData[]>();
  for (const spec of specs) {
    const steps = jobs.get(spec.job) ?? [];
    steps.push({
      stepName: spec.name,
      status: "pending",
      ...(spec.template === undefined
        ? {}
        : { forEachTemplate: spec.template }),
    } as StepRunData);
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
  } as WorkflowRunData;
}

/** `record` with one step replaced. */
function withStep(
  record: WorkflowRunData,
  job: string,
  name: string,
  change: (step: StepRunData) => StepRunData | undefined,
): WorkflowRunData {
  const next = clone(record);
  next.jobs = next.jobs.map((j) =>
    j.jobName !== job ? j : {
      ...j,
      steps: j.steps.flatMap((s) => {
        if (s.stepName !== name) return [s];
        const changed = change(clone(s));
        return changed === undefined ? [] : [changed];
      }),
    }
  );
  return next;
}

/** The run's status as its steps leave it. */
function settleRunStatus(record: WorkflowRunData): WorkflowRunData {
  if (record.status === "cancelled" || record.status === "failed") {
    return record;
  }
  const waiting = [...stepsOf(record).values()].some((s) =>
    s.status === "waiting_approval" || s.status === "waiting_signal"
  );
  return { ...record, status: waiting ? "suspended" : "running" };
}

type Action = "approve" | "signal";

interface Move {
  readonly label: string;
  readonly record: WorkflowRunData;
  /** The actions the mover holds beyond run, which the move needs. */
  readonly needs: readonly Action[];
}

/** Every transition a real run, approver, signaller or cancel can record next. */
function legitimateMoves(
  specs: readonly StepSpec[],
  record: WorkflowRunData,
): Move[] {
  if (record.status === "cancelled") return [];
  const moves: Move[] = [];
  const steps = stepsOf(record);
  const move = (
    label: string,
    spec: StepSpec,
    change: (step: StepRunData) => StepRunData,
    needs: readonly Action[] = [],
  ) =>
    moves.push({
      label,
      needs,
      record: settleRunStatus(
        withStep(record, spec.job, spec.name, change),
      ),
    });
  for (const spec of specs) {
    const step = steps.get(key(spec.job, spec.name));
    if (step === undefined) continue;
    switch (step.status) {
      case "pending":
        if (spec.kind === "guarded") {
          move(
            "guard skips a gate",
            spec,
            (s) => ({ ...s, status: "skipped" }),
          );
        }
        move("step starts", spec, (s) => ({
          ...s,
          status: "running",
          startedAt: T0,
        }));
        break;
      case "running":
        switch (spec.kind) {
          case "plain":
            move("step succeeds", spec, (s) => ({
              ...s,
              status: "succeeded",
              completedAt: T0,
              output: { type: "model_method", step: spec.name },
            }));
            move("step fails", spec, (s) => ({
              ...s,
              status: "failed",
              error: "boom",
            }));
            break;
          case "gate":
          case "guarded":
            move("gate waits", spec, (s) => ({
              ...s,
              status: "waiting_approval",
              approvalPrompt: "Deploy?",
              ...(spec.timeout === undefined
                ? {}
                : { approvalTimeout: spec.timeout }),
            }));
            break;
          case "signal":
            move("wait opens", spec, (s) => ({
              ...s,
              status: "waiting_signal",
              wait: { key: `k-${spec.name}` },
            }));
            break;
          case "nested":
            move("nested call waits on its child", spec, (s) => ({
              ...s,
              status: "waiting_approval",
              nestedRun: {
                workflowId: CHILD_WORKFLOW,
                workflowName: "child",
                runId: childRunOf(spec),
              },
            }));
            break;
        }
        break;
      case "waiting_approval":
        if (spec.kind === "nested") {
          move("child ends, nested call succeeds", spec, (s) => ({
            ...s,
            status: "succeeded",
            output: {
              type: "workflow",
              workflowId: CHILD_WORKFLOW,
              runId: childRunOf(spec),
            },
          }));
          break;
        }
        if (step.approvalDecision === undefined) {
          move("approver approves", spec, (s) => ({
            ...s,
            status: "succeeded",
            approvalDecision: decision(true),
          }), ["approve"]);
          move("approver rejects", spec, (s) => ({
            ...s,
            status: "failed",
            approvalDecision: decision(false),
          }), ["approve"]);
          move("approver decides, run continues later", spec, (s) => ({
            ...s,
            approvalDecision: decision(true),
          }), ["approve"]);
          if (spec.timeout === SHORT) {
            move("gate times out", spec, (s) => ({
              ...s,
              status: "failed",
              error: "approval timed out",
            }));
          }
        } else {
          move("run completes a decided gate", spec, (s) => ({
            ...s,
            status: s.approvalDecision!.approved ? "succeeded" : "failed",
          }));
        }
        break;
      case "waiting_signal":
        move("signal arrives", spec, (s) => ({
          ...s,
          status: "succeeded",
          output: { type: "wait_for_signal", payload: { ok: true } },
        }), ["signal"]);
        break;
    }
  }
  const waiting = [...steps.values()].filter((s) =>
    s.status === "waiting_approval" || s.status === "waiting_signal"
  );
  if (waiting.length > 0) {
    const cancelled = clone(record);
    cancelled.status = "cancelled";
    for (const job of cancelled.jobs) {
      job.steps = job.steps.map((s) =>
        s.status === "waiting_approval" || s.status === "waiting_signal"
          ? {
            ...s,
            status: "failed",
            settledByAbort: true,
            error: "cancelled",
          }
          : s
      );
    }
    moves.push({ label: "run is cancelled", record: cancelled, needs: [] });
  }
  return moves;
}

function childRunOf(spec: StepSpec): string {
  const n = (spec.name.length * 7919 + spec.job.length) % 0xfff;
  return `88888888-9999-4aaa-8bbb-${n.toString(16).padStart(12, "0")}`;
}

function decision(approved: boolean) {
  return { approved, decidedBy: "user:approver", decidedAt: T0 };
}

/** One forgery's choices, drawn up front so a failure shrinks. */
const forgeryChoice = fc.record({
  kind: fc.constantFrom(
    "settle-gate",
    "settle-signal",
    "drop-step",
    "rename-step",
    "retype",
    "decision",
    "gate-fields",
    "frozen-field",
    "log-file",
    "nested-link",
    "nested-output",
    "reopen",
    "retype-and-link",
  ),
  pick: fc.nat(),
  status: fc.constantFrom<StepRunData["status"]>(
    "succeeded",
    "failed",
    "skipped",
    "pending",
    "running",
    "waiting_approval",
  ),
  abort: fc.boolean(),
  runStatus: fc.constantFrom<WorkflowRunData["status"] | undefined>(
    undefined,
    "cancelled",
    "failed",
    "running",
  ),
  withDecision: fc.constantFrom<boolean | undefined>(undefined, true, false),
  retypeTo: fc.constantFrom<StepKind>("other", "unknown", "signal", "approval"),
  field: fc.nat(),
  /** Leave the step's status as it is: a forgery that keeps a wait open. */
  keepStatus: fc.boolean(),
});
type ForgeryChoice = typeof forgeryChoice extends fc.Arbitrary<infer T> ? T
  : never;

/** The attacker's next record (and stored kinds), from the current one. */
function forge(
  specs: readonly StepSpec[],
  record: WorkflowRunData,
  kinds: StoredKinds,
  choice: ForgeryChoice,
): { record: WorkflowRunData; kinds: StoredKinds } {
  const all = [...stepsOf(record).entries()];
  if (all.length === 0) return { record, kinds };
  const [stepKey, picked] = all[choice.pick % all.length];
  const [job, name] = stepKey.split("/");
  const kindKey = key(job, picked.forEachTemplate ?? name);
  const status = choice.keepStatus ? picked.status : choice.status;
  const runStatus = (r: WorkflowRunData) =>
    choice.runStatus === undefined ? r : { ...r, status: choice.runStatus };
  switch (choice.kind) {
    case "settle-gate":
    case "reopen":
      return {
        kinds,
        record: runStatus(withStep(record, job, name, (s) => ({
          ...s,
          status: choice.kind === "reopen"
            ? (choice.abort ? "pending" : "running")
            : choice.status,
          ...(choice.abort ? { settledByAbort: true } : {}),
          ...(choice.withDecision === undefined
            ? {}
            : { approvalDecision: decision(choice.withDecision) }),
        }))),
      };
    case "settle-signal":
      return {
        kinds,
        record: runStatus(withStep(record, job, name, (s) => ({
          ...s,
          status: choice.status === "waiting_approval"
            ? "succeeded"
            : choice.status,
          output: { type: "wait_for_signal", payload: { forged: true } },
          ...(choice.abort ? { settledByAbort: true } : {}),
        }))),
      };
    case "drop-step":
      return { kinds, record: withStep(record, job, name, () => undefined) };
    case "rename-step":
      return {
        kinds,
        record: withStep(record, job, name, (s) => ({
          ...s,
          stepName: `${s.stepName}-renamed`,
          status,
        })),
      };
    case "retype": {
      const retyped = new Map(kinds);
      retyped.set(kindKey, choice.retypeTo);
      // The retype lands with the settle it is meant to enable.
      return {
        kinds: retyped,
        record: runStatus(withStep(record, job, name, (s) => ({
          ...s,
          status,
        }))),
      };
    }
    case "decision":
      return {
        kinds,
        record: withStep(record, job, name, (s) => ({
          ...s,
          approvalDecision: decision(choice.withDecision ?? true),
        })),
      };
    case "gate-fields": {
      const field = choice.field % 3;
      return {
        kinds,
        record: withStep(record, job, name, (s) => ({
          ...s,
          ...(field === 0 ? { approvalPrompt: "Deploy to prod?" } : {}),
          ...(field === 1 ? { approvalTimeout: 1 } : {}),
          ...(field === 2 ? { startedAt: "2020-01-01T00:00:00.000Z" } : {}),
          status,
        })),
      };
    }
    case "frozen-field": {
      const field = choice.field % 6;
      const next = clone(record);
      if (field === 0) {
        next.triggeringPrincipal = {
          kind: "user",
          id: "root",
          membership: { localGroups: [], idpGroups: [], collectives: [] },
        };
      }
      if (field === 1) next.parentRun = { workflowId: FOREIGN };
      if (field === 2) next.allowedVaults = ["prod"];
      if (field === 3) next.initiatedBy = "user:root";
      if (field === 4) next.runPlan = { fingerprint: "other" };
      if (field === 5) next.inheritedExpressions = ["injected"];
      return { kinds, record: next };
    }
    case "log-file":
      return {
        kinds,
        record: {
          ...record,
          logFile: [
            "/etc/passwd",
            "../../.swamp/serve.yaml",
            `.swamp/workflow-runs/${FOREIGN}/workflow-run-${RUN}.log`,
          ][choice.field % 3],
        },
      };
    case "nested-link":
      return {
        kinds,
        record: withStep(record, job, name, (s) => ({
          ...s,
          status,
          nestedRun: {
            workflowId: FOREIGN,
            workflowName: "foreign",
            runId: FOREIGN,
          },
        })),
      };
    case "retype-and-link": {
      // Retype the step and link a child in one record, so a later record
      // can settle it as a nested call's wait.
      const retyped = new Map(kinds);
      retyped.set(kindKey, choice.retypeTo);
      return {
        kinds: retyped,
        record: withStep(record, job, name, (s) => ({
          ...s,
          status,
          nestedRun: {
            workflowId: FOREIGN,
            workflowName: "foreign",
            runId: FOREIGN,
          },
        })),
      };
    }
    case "nested-output":
      return {
        kinds,
        record: withStep(record, job, name, (s) => ({
          ...s,
          status: "succeeded",
          output: { type: "workflow", workflowId: FOREIGN, runId: FOREIGN },
        })),
      };
  }
  throw new Error("unknown forgery");
}

function judge(
  specs: readonly StepSpec[],
  kinds: StoredKinds,
  before: WorkflowRunData | undefined,
  after: WorkflowRunData,
): RunRecordJudgement {
  return judgeRunRecord({
    workflowId: WORKFLOW,
    runId: RUN,
    before,
    after,
    stepKind: (job, step) =>
      kinds.get(key(job, step.forEachTemplate ?? step.stepName)) ?? "unknown",
    definitionSteps: () => undefined,
    isServeInstance: (id) => id === "serve-1",
    now: NOW,
  });
  void specs;
}

/** What the oracle remembers of a gate that is waiting. */
interface WaitingGate {
  readonly timeout?: number;
  readonly startedAt?: string;
  readonly prompt?: string;
  approved?: boolean;
}

/** The guarantees the history of landed records must keep. */
class Oracle {
  readonly gates = new Map<string, WaitingGate>();
  readonly waits = new Set<string>();

  /** Notes waits that `record` opens; `kinds` is the stored workflow now. */
  observe(
    before: WorkflowRunData | undefined,
    record: WorkflowRunData,
    kinds: StoredKinds,
  ): void {
    const prior = before === undefined ? new Map() : stepsOf(before);
    for (const [k, step] of stepsOf(record)) {
      const was = prior.get(k);
      const [job] = k.split("/");
      const stored = kinds.get(key(job, step.forEachTemplate ?? step.stepName));
      if (
        step.status === "waiting_approval" &&
        was?.status !== "waiting_approval" &&
        (stored === "approval" || step.nestedRun === undefined)
      ) {
        this.gates.set(k, {
          timeout: step.approvalTimeout,
          startedAt: step.startedAt,
          prompt: step.approvalPrompt,
        });
      }
      const gate = this.gates.get(k);
      if (gate !== undefined && step.approvalDecision !== undefined) {
        gate.approved = step.approvalDecision.approved;
      }
      if (step.status === "waiting_signal") this.waits.add(k);
    }
    for (const [k] of this.gates) {
      const step = stepsOf(record).get(k);
      if (step !== undefined && step.status !== "waiting_approval") {
        this.gates.delete(k);
      }
    }
    for (const k of this.waits) {
      const step = stepsOf(record).get(k);
      if (step !== undefined && step.status !== "waiting_signal") {
        this.waits.delete(k);
      }
    }
  }

  /**
   * Why a record a run-only caller landed breaks a guarantee, or undefined.
   */
  violation(
    before: WorkflowRunData,
    after: WorkflowRunData,
    judged: RunRecordJudgement,
  ): string | undefined {
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
    const cancelled = after.status === "cancelled" || after.status === "failed";
    for (const [k, was] of prior) {
      const is = next.get(k);
      if (
        is !== undefined &&
        JSON.stringify(was.approvalDecision) !==
          JSON.stringify(is.approvalDecision)
      ) {
        return `decision of ${k} changed`;
      }
    }
    for (const [k, gate] of this.gates) {
      const is = next.get(k);
      if (is === undefined) return `waiting gate ${k} dropped`;
      if (is.status === "waiting_approval") {
        // What the approver is shown, and the deadline, hold while it waits.
        if (
          is.approvalPrompt !== gate.prompt ||
          is.approvalTimeout !== gate.timeout ||
          is.startedAt !== gate.startedAt
        ) {
          return `waiting gate ${k}'s prompt, timeout or start changed`;
        }
        continue;
      }
      const byCancel = is.status === "failed" && is.settledByAbort === true &&
        cancelled;
      const byDeadline = is.status === "failed" &&
        gate.timeout !== undefined && gate.startedAt !== undefined &&
        NOW.getTime() - new Date(gate.startedAt).getTime() >
          gate.timeout * 1000;
      const byDecision = gate.approved !== undefined &&
        is.status === (gate.approved ? "succeeded" : "failed");
      if (!byCancel && !byDeadline && !byDecision) {
        return `waiting gate ${k} settled to ${is.status} without approve`;
      }
    }
    for (const k of this.waits) {
      const was = prior.get(k)!;
      const is = next.get(k);
      if (is === undefined) return `waiting signal ${k} dropped`;
      const byCancel = is.status === "failed" && is.settledByAbort === true &&
        cancelled;
      if (byCancel) continue;
      if (
        is.status !== "waiting_signal" ||
        JSON.stringify(is.output) !== JSON.stringify(was.output) ||
        JSON.stringify(is.wait) !== JSON.stringify(was.wait)
      ) {
        return `waiting signal ${k} settled without signal`;
      }
    }
    for (const [k, is] of next) {
      const was = prior.get(k);
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
}

/** One step of a scenario: a model move, or a forgery. */
const scenarioStep = fc.oneof(
  { weight: 3, arbitrary: fc.record({ legit: fc.nat() }) },
  { weight: 2, arbitrary: fc.record({ forge: forgeryChoice }) },
);

interface Coverage {
  legit: Record<string, number>;
  forged: Record<string, number>;
  refused: number;
  needed: number;
  landed: number;
}

function bump(counts: Record<string, number>, label: string): void {
  counts[label] = (counts[label] ?? 0) + 1;
}

/**
 * Runs one scenario. Returns a violation message, or undefined. Throws on a
 * legitimate move the judge refuses or judges as needing other actions.
 */
function play(
  specs: readonly StepSpec[],
  scenario: readonly ({ legit: number } | { forge: ForgeryChoice })[],
  coverage: Coverage,
): string | undefined {
  let kinds: StoredKinds = new Map(
    specs.map((s) => [key(s.job, s.template ?? s.name), storedKindOf(s.kind)]),
  );
  let record = initial(specs);
  const created = judge(specs, kinds, undefined, record);
  assertEquals(created.refusal, undefined, "a run's first record");
  assertEquals([...created.actions], []);
  const oracle = new Oracle();
  oracle.observe(undefined, record, kinds);
  let tampered = false;
  for (const next of scenario) {
    if ("legit" in next) {
      const moves = legitimateMoves(specs, record);
      if (moves.length === 0) continue;
      const move = moves[next.legit % moves.length];
      const judged = judge(specs, kinds, record, move.record);
      if (!tampered) {
        bump(coverage.legit, move.label);
        assertEquals(
          judged.refusal,
          undefined,
          `legitimate move refused: ${move.label}`,
        );
        assertEquals(
          [...judged.actions].sort(),
          [...move.needs].sort(),
          `legitimate move judged wrong: ${move.label}`,
        );
      } else if (judged.refusal !== undefined) {
        continue;
      }
      oracle.observe(record, move.record, kinds);
      record = move.record;
      continue;
    }
    bump(coverage.forged, next.forge.kind);
    const forged = forge(specs, record, kinds, next.forge);
    const judged = judge(specs, forged.kinds, record, forged.record);
    if (judged.refusal !== undefined) {
      coverage.refused++;
      continue;
    }
    if (judged.actions.size > 0) {
      // The attacker holds only run: the forgery does not land.
      coverage.needed++;
      continue;
    }
    coverage.landed++;
    const broken = oracle.violation(record, forged.record, judged);
    if (broken !== undefined) return `${next.forge.kind}: ${broken}`;
    oracle.observe(record, forged.record, forged.kinds);
    record = forged.record;
    kinds = forged.kinds;
    tampered = true;
  }
  return undefined;
}

function newCoverage(): Coverage {
  return { legit: {}, forged: {}, refused: 0, needed: 0, landed: 0 };
}

Deno.test("judgeRunRecord (model): every transition a real run records is accepted with exactly the actions it needs", () => {
  const coverage = newCoverage();
  fc.assert(
    fc.property(
      workflowSpec,
      fc.array(fc.record({ legit: fc.nat() }), { maxLength: 40 }),
      (specs, scenario) => {
        assertEquals(play(specs, scenario, coverage), undefined);
      },
    ),
    { numRuns: 1000 },
  );
  console.log("legitimate transitions tried:", JSON.stringify(coverage.legit));
  for (
    const label of [
      "guard skips a gate",
      "gate waits",
      "approver approves",
      "approver rejects",
      "approver decides, run continues later",
      "run completes a decided gate",
      "gate times out",
      "wait opens",
      "signal arrives",
      "nested call waits on its child",
      "child ends, nested call succeeds",
      "run is cancelled",
    ]
  ) {
    assert((coverage.legit[label] ?? 0) > 0, `never tried: ${label}`);
  }
});

Deno.test("judgeRunRecord (model): no forged record a run-only caller can land breaks the run's guarantees", () => {
  const coverage = newCoverage();
  fc.assert(
    fc.property(
      workflowSpec,
      fc.array(scenarioStep, { maxLength: 40 }),
      (specs, scenario) => {
        const broken = play(specs, scenario, coverage);
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
    "needed approve or signal:",
    coverage.needed,
    "landed:",
    coverage.landed,
  );
  for (
    const kind of [
      "settle-gate",
      "settle-signal",
      "drop-step",
      "rename-step",
      "retype",
      "decision",
      "gate-fields",
      "frozen-field",
      "log-file",
      "nested-link",
      "nested-output",
      "reopen",
      "retype-and-link",
    ]
  ) {
    assert((coverage.forged[kind] ?? 0) > 0, `never tried: ${kind}`);
  }
  assert(coverage.refused > 0 && coverage.needed > 0 && coverage.landed > 0);
});
