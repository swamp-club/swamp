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
import "../src/domain/models/models.ts";
import { judgeRunRecord } from "../src/domain/datastore_v3/content_bindings.ts";
import { fanOutGatePrompt } from "../src/domain/workflows/fan_out_gates.ts";
import type {
  StepRunData,
  WorkflowRunData,
} from "../src/domain/workflows/workflow_run.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { Fleet, type FleetWorker } from "./fleet_harness.ts";

await initializeLogging({});

const SANITIZE = { sanitizeOps: false, sanitizeResources: false };
const WEB = { fleet: "web" };

type GateKind = "plan" | "canary";
type LaneState = "pending" | "succeeded" | "failed" | "held";
// allowed: failed under allowFailure; skipped: its dependency did not succeed
type StepState = LaneState | "allowed" | "skipped";
type GateState = "pending" | "waiting" | "approved" | "rejected" | "held";

// a lane of n steps runs the first n; only verify may fail without failing it
const LANE_STEPS = [["apply"], ["prepare", "apply"], [
  "prepare",
  "apply",
  "verify",
]];
const ALLOW_FAILURE = new Set(["verify"]);

type Action =
  | { kind: "approve" }
  | { kind: "reject" }
  | { kind: "retry" }
  | { kind: "retryFrom"; step?: number }
  | { kind: "fix" }
  | { kind: "break"; worker: number }
  | { kind: "breakAt"; worker: number; step: number }
  | { kind: "disconnect"; worker: number }
  | { kind: "reconnect"; worker: number };

interface Scenario {
  workers: number;
  batches: (number | string)[];
  maxFailures: number | null;
  approve: GateKind[];
  failing: number[];
  // absent: one step, and no failure at a single step
  steps?: number;
  failingAt?: { worker: number; step: number }[];
  actions: Action[];
}

function laneStep(step: string, worker: string): string {
  return `${step}[${worker}]`;
}

/** what an accepted retry did, for coverage */
interface RetryOutcome {
  // finished steps a reopened lane kept
  keptSteps: number;
}

/** the gate semantics, stated independently: it shares no code with the executor */
class Model {
  readonly records = new Map<string, StepState>();
  readonly gates = new Map<GateKind, GateState>();
  readonly dispatches = new Map<string, number>();
  readonly offline = new Set<string>();
  // the first pass plans; every later one runs on the stored plan
  private planned = false;
  status: "suspended" | "failed" | "succeeded" = "succeeded";
  rejected = false;
  lastHaltFailed: string[] = [];

  constructor(
    readonly batches: string[][],
    readonly maxFailures: number | null,
    approve: GateKind[],
    readonly steps: string[],
    readonly fails: (worker: string, step: string) => boolean,
  ) {
    for (const worker of batches.flat()) {
      for (const step of steps) {
        this.records.set(laneStep(step, worker), "pending");
      }
      this.dispatches.set(worker, 0);
    }
    if (approve.includes("plan")) this.gates.set("plan", "pending");
    if (approve.includes("canary") && batches.length > 1) {
      this.gates.set("canary", "pending");
    }
  }

  private states(worker: string): StepState[] {
    return this.steps.map((step) => this.records.get(laneStep(step, worker))!);
  }

  lane(worker: string): LaneState {
    const states = this.states(worker);
    if (states.includes("failed")) return "failed";
    if (states.includes("held")) return "held";
    if (states.includes("pending")) return "pending";
    return "succeeded";
  }

  get lanes(): Map<string, LaneState> {
    return new Map(this.batches.flat().map((w) => [w, this.lane(w)]));
  }

  private hasPending(worker: string): boolean {
    return this.states(worker).includes("pending");
  }

  private kept(worker: string): boolean {
    return this.states(worker).every((s) =>
      s === "succeeded" || s === "allowed" || s === "skipped"
    );
  }

  private runLane(worker: string): void {
    let previous: StepState = "succeeded";
    for (const step of this.steps) {
      const name = laneStep(step, worker);
      let state = this.records.get(name)!;
      if (state === "pending") {
        if (previous !== "succeeded") {
          state = "skipped";
        } else {
          this.dispatches.set(worker, this.dispatches.get(worker)! + 1);
          state = !this.fails(worker, step)
            ? "succeeded"
            : ALLOW_FAILURE.has(step)
            ? "allowed"
            : "failed";
        }
        this.records.set(name, state);
      }
      previous = state;
    }
  }

  waitingGate(): GateKind | undefined {
    return [...this.gates].find(([, state]) => state === "waiting")?.[0];
  }

  run(): void {
    const stored = this.planned;
    this.planned = true;
    if (this.gates.has("plan") && this.gates.get("plan") !== "approved") {
      this.gates.set("plan", "waiting");
      this.status = "suspended";
      return;
    }
    const workers = this.batches.flat();
    const rerun = new Set(workers.filter((w) => this.hasPending(w)));
    const failed = new Set(
      workers.filter((w) => !rerun.has(w) && this.lane(w) === "failed"),
    );
    // offline fail: a stored plan's lane whose worker is gone fails its
    // unstarted steps, verify included, without a dispatch
    if (stored) {
      for (const worker of rerun) {
        if (!this.offline.has(worker)) continue;
        for (const step of this.steps) {
          const name = laneStep(step, worker);
          if (this.records.get(name) === "pending") {
            this.records.set(name, "failed");
          }
        }
        failed.add(worker);
      }
    }
    const canaryUndecided = this.gates.has("canary") &&
      this.gates.get("canary") !== "approved";
    const failedFirst = this.lastHaltFailed.filter((w) =>
      !canaryUndecided || this.batches[0].includes(w)
    );
    const rollout = this.batches.length > 1 || this.maxFailures !== null;
    const first = this.batches.flat().filter((w) =>
      rerun.has(w) && failedFirst.includes(w)
    );
    const rest = this.batches.map((b) =>
      b.filter((w) => rerun.has(w) && !failedFirst.includes(w))
    ).filter((b) => b.length > 0);
    const order = rollout
      ? (first.length > 0 ? [first, ...rest] : rest)
      : [this.batches.flat().filter((w) => rerun.has(w))];
    const canary = new Set(this.batches[0]);
    const gated = () =>
      this.gates.has("canary") && this.gates.get("canary") !== "approved";
    for (const batch of order) {
      const started: string[] = [];
      let paused = false;
      let halted = false;
      for (const worker of batch) {
        if (!this.hasPending(worker)) continue;
        if (
          rollout && this.maxFailures !== null &&
          failed.size > this.maxFailures
        ) {
          halted = true;
          break;
        }
        if (gated() && !canary.has(worker)) {
          paused = true;
          break;
        }
        started.push(worker);
      }
      for (const worker of started) {
        this.runLane(worker);
        if (this.lane(worker) === "failed") failed.add(worker);
      }
      if (paused) {
        this.gates.set("canary", "waiting");
        this.status = "suspended";
        return;
      }
      if (halted) break;
    }
    const held = order.flat().filter((w) => this.hasPending(w));
    if (held.length > 0) {
      this.hold();
      this.lastHaltFailed = [...failed];
    }
    // a gate the finished rollout never reached is held, halt or not
    if (this.gates.get("canary") === "pending") {
      this.gates.set("canary", "held");
    }
    this.status = workers.some((w) => this.lane(w) !== "succeeded")
      ? "failed"
      : "succeeded";
  }

  private hold(): void {
    for (const [name, state] of this.records) {
      if (state === "pending") this.records.set(name, "held");
    }
  }

  decide(approved: boolean): void {
    const gate = this.waitingGate()!;
    if (approved) {
      this.gates.set(gate, "approved");
      this.run();
      return;
    }
    this.gates.set(gate, "rejected");
    this.rejected = true;
    this.hold();
    for (const [kind, state] of this.gates) {
      if (state === "pending") this.gates.set(kind, "held");
    }
    this.status = "failed";
  }

  /** undefined when refused; reopens from the entry step in unkept lanes, and every held step */
  retry(from: number | undefined): RetryOutcome | undefined {
    if (this.rejected) return undefined;
    const workers = this.batches.flat();
    const entry = from ?? Math.min(
      ...workers.flatMap((w) =>
        this.states(w).flatMap((s, i) => s === "failed" ? [i] : [])
      ),
    );
    // a plain retry needs a failed step to enter at
    if (entry === Infinity) return undefined;
    const keptLanes = new Set(workers.filter((w) => this.kept(w)));
    let keptSteps = 0;
    let reopened = 0;
    for (const worker of workers) {
      this.steps.forEach((step, i) => {
        const name = laneStep(step, worker);
        const state = this.records.get(name)!;
        if (!keptLanes.has(worker) && i >= entry) {
          this.records.set(name, "pending");
          reopened++;
        } else if (state === "held") {
          this.records.set(name, "pending");
        } else if (!keptLanes.has(worker) && state === "succeeded") {
          keptSteps++;
        }
      });
    }
    // only --from asks an approved gate again, and only when every lane
    // step of the job runs again
    const everyStep = from !== undefined &&
      reopened === workers.length * this.steps.length;
    for (const [kind, state] of this.gates) {
      if (state === "held" || everyStep) this.gates.set(kind, "pending");
    }
    this.run();
    return { keptSteps };
  }
}

const GATE: Record<string, GateState> = {
  pending: "pending",
  waiting_approval: "waiting",
  succeeded: "approved",
  failed: "rejected",
  skipped: "held",
};

function stepState(step: StepRunData): StepState {
  if (step.status === "failed") {
    return step.allowedFailure ? "allowed" : "failed";
  }
  if (step.status === "skipped") {
    return step.settledByAbort ? "held" : "skipped";
  }
  return step.status as StepState;
}

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  workers: fc.integer({ min: 2, max: 4 }),
  batches: fc.constantFrom<(number | string)[]>(
    ["100%"],
    [1, "100%"],
    [1, 1, "100%"],
    [2, "100%"],
  ),
  maxFailures: fc.option(fc.integer({ min: 0, max: 2 }), { nil: null }),
  approveSet: fc.subarray<GateKind>(["plan", "canary"], { minLength: 1 }),
  steps: fc.integer({ min: 1, max: 3 }),
  failing: fc.oneof(
    { weight: 2, arbitrary: fc.subarray([0, 1, 2, 3], { minLength: 1 }) },
    { weight: 2, arbitrary: fc.constant<number[]>([]) },
  ),
  failingAt: fc.array(
    fc.record({
      worker: fc.integer({ min: 0, max: 3 }),
      step: fc.integer({ min: 0, max: 2 }),
    }),
    { maxLength: 3 },
  ),
  actions: fc.array(
    fc.oneof(
      fc.constant<Action>({ kind: "approve" }),
      fc.constant<Action>({ kind: "approve" }),
      fc.constant<Action>({ kind: "reject" }),
      fc.constant<Action>({ kind: "retry" }),
      fc.integer({ min: 0, max: 2 }).map((step): Action => ({
        kind: "retryFrom",
        step,
      })),
      fc.integer({ min: 0, max: 2 }).map((step): Action => ({
        kind: "retryFrom",
        step,
      })),
      fc.constant<Action>({ kind: "fix" }),
      fc.integer({ min: 0, max: 3 }).map((worker): Action => ({
        kind: "break",
        worker,
      })),
      fc.record({
        worker: fc.integer({ min: 0, max: 3 }),
        step: fc.integer({ min: 0, max: 2 }),
      }).map(({ worker, step }): Action => ({
        kind: "breakAt",
        worker,
        step,
      })),
      fc.integer({ min: 0, max: 3 }).map((worker): Action => ({
        kind: "disconnect",
        worker,
      })),
      fc.integer({ min: 0, max: 3 }).map((worker): Action => ({
        kind: "reconnect",
        worker,
      })),
    ),
    { minLength: 2, maxLength: 7 },
  ),
}).map(({ approveSet, ...rest }) => ({
  ...rest,
  // a canary gate needs a batch after the canary
  approve: rest.batches.length > 1 ? approveSet : ["plan"],
}));

function observed(data: WorkflowRunData, workers: readonly string[]) {
  const job = data.jobs[0];
  const records = new Map<string, StepState>();
  const gates = new Map<GateKind, GateState>();
  for (const step of job.steps) {
    const gate = /^patch\[approve-(plan|canary)\]$/.exec(step.stepName);
    if (gate) {
      gates.set(gate[1] as GateKind, GATE[step.status]);
      continue;
    }
    const lane = /^[a-z]+\[(.+)\]$/.exec(step.stepName);
    if (lane && workers.includes(lane[1])) {
      records.set(step.stepName, stepState(step));
    }
  }
  return { status: data.status, records, gates };
}

interface Coverage {
  planWait: number;
  canaryWait: number;
  halted: number;
  rejected: number;
  refused: number;
  reasked: number;
  approvedFailedCanary: number;
  succeeded: number;
  disconnected: number;
  partlyFinishedRetry: number;
  laterFromNoReask: number;
}

Deno.test({
  name:
    "fan-out gates model: random fleets, budgets, gates and operator actions match the model after every step, and every save passes the run-record judge",
  ...SANITIZE,
  fn: async () => {
    const coverage: Coverage = {
      planWait: 0,
      canaryWait: 0,
      halted: 0,
      rejected: 0,
      refused: 0,
      reasked: 0,
      approvedFailedCanary: 0,
      succeeded: 0,
      disconnected: 0,
      partlyFinishedRetry: 0,
      laterFromNoReask: 0,
    };
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        await using fleet = await Fleet.start();
        const names = Array.from(
          { length: scenario.workers },
          (_, i) => `w-${i + 1}`,
        );
        const fleetWorkers: FleetWorker[] = [];
        for (const name of names) {
          fleetWorkers.push(await fleet.addWorker(name, { labels: WEB }));
        }
        const steps = LANE_STEPS[(scenario.steps ?? 1) - 1];
        const failing = new Map<string, Set<string>>(
          names.map((name) => [name, new Set()]),
        );
        const breakAt = (worker: number, at: string[]) => {
          for (const step of at) {
            failing.get(names[worker % names.length])!.add(step);
          }
        };
        for (const worker of scenario.failing) {
          if (worker < names.length) breakAt(worker, steps);
        }
        for (const { worker, step } of scenario.failingAt ?? []) {
          if (worker < names.length) {
            breakAt(worker, [steps[step % steps.length]]);
          }
        }
        // the harness matches a lane step by its dispatched name
        const behave = () => {
          fleetWorkers.forEach((worker) => {
            const at = [...failing.get(worker.name)!];
            worker.behavior = at.length > 0
              ? {
                kind: "fail",
                error: "broke",
                steps: at.map((step) => laneStep(step, worker.name)),
              }
              : { kind: "succeed" };
          });
        };
        behave();

        const repo = fleet.repoContext.workflowRunRepo;
        const saves: { data: WorkflowRunData; decision: boolean }[] = [];
        let deciding = false;
        const save = repo.save.bind(repo);
        repo.save = async (workflowId, run) => {
          const data = structuredClone(run.toData());
          delete data.logFile;
          saves.push({ data, decision: deciding });
          return await save(workflowId, run);
        };

        const workflow = await fleet.saveWorkflow({
          name: "gated",
          inputs: {},
          jobs: [{
            name: "patch",
            fanOut: {
              offline: "fail",
              rollout: {
                batches: scenario.batches,
                ...(scenario.maxFailures !== null
                  ? { maxFailures: scenario.maxFailures }
                  : {}),
                approve: scenario.approve,
              },
            },
            labels: WEB,
            steps: steps.map((name, i) => ({
              name,
              ...(i > 0
                ? {
                  dependsOn: [{
                    step: steps[i - 1],
                    condition: { type: "succeeded" },
                  }],
                }
                : {}),
              ...(ALLOW_FAILURE.has(name) ? { allowFailure: true } : {}),
              task: {
                type: "model_method",
                modelType: fleet.modelType.normalized,
                modelName: "host-patch",
                methodName: "run",
              },
            })),
          }],
        });
        const run = await fleet.runWorkflow("gated");
        const first = await fleet.runRecord(workflow, run.id);
        const batches = first.jobs[0].fanOutPlan!.batches.map((b) => [...b]);
        const model = new Model(
          batches,
          scenario.maxFailures,
          scenario.approve,
          steps,
          (worker, step) => failing.get(worker)!.has(step),
        );
        model.run();

        const check = async (step: string) => {
          const record = await fleet.runRecord(workflow, run.id);
          const actual = observed(record, names);
          const context = `${step}: ${JSON.stringify(scenario)}`;
          assertEquals(actual.status, model.status, context);
          assertEquals(actual.records, model.records, context);
          assertEquals(actual.gates, model.gates, context);
          assertEquals(
            new Map(Object.entries(fleet.dispatchCounts())),
            model.dispatches,
            context,
          );
          if (model.waitingGate() === "plan") coverage.planWait++;
          if (model.waitingGate() === "canary") {
            coverage.canaryWait++;
            // what the approver is shown is what the rollout counts
            const prompt = fanOutGatePrompt(record.jobs[0], "canary")!;
            assertEquals(
              prompt.budget.used,
              [...model.lanes.values()].filter((s) => s === "failed").length,
              context,
            );
            assertEquals(
              prompt.canary!.lanes.map((lane): string => lane.status),
              batches[0].map((w): string => model.lanes.get(w)!),
              context,
            );
          }
          if ([...model.lanes.values()].includes("held") && !model.rejected) {
            coverage.halted++;
          }
          if (model.status === "succeeded") coverage.succeeded++;
        };
        await check("start");

        for (const [index, action] of scenario.actions.entries()) {
          const step = `action ${index} ${JSON.stringify(action)}`;
          if (action.kind === "fix") {
            for (const at of failing.values()) at.clear();
            behave();
            continue;
          }
          if (action.kind === "break" || action.kind === "breakAt") {
            breakAt(
              action.worker,
              action.kind === "break"
                ? steps
                : [steps[action.step % steps.length]],
            );
            behave();
            continue;
          }
          if (action.kind === "disconnect" || action.kind === "reconnect") {
            const worker = fleetWorkers[action.worker % names.length];
            const gone = model.offline.has(worker.name);
            if (action.kind === "disconnect" && !gone) {
              await worker.disconnect();
              model.offline.add(worker.name);
              coverage.disconnected++;
            } else if (action.kind === "reconnect" && gone) {
              await worker.connect();
              model.offline.delete(worker.name);
            }
            continue;
          }
          if (action.kind === "approve" || action.kind === "reject") {
            const gate = model.waitingGate();
            if (model.status !== "suspended" || gate === undefined) continue;
            const approved = action.kind === "approve";
            if (
              approved && gate === "canary" &&
              batches[0].some((w) => model.lanes.get(w) === "failed")
            ) coverage.approvedFailedCanary++;
            deciding = true;
            let decided;
            try {
              decided = await fleet.decideGate(
                "gated",
                run.id,
                `patch[approve-${gate}]`,
                approved,
              );
            } finally {
              deciding = false;
            }
            assertEquals(decided.kind, "completed", step);
            if (approved) await fleet.resumeRun("gated", run.id);
            else coverage.rejected++;
            model.decide(approved);
            await check(step);
            continue;
          }
          if (model.status !== "failed") continue;
          const from = action.kind === "retryFrom"
            ? (action.step ?? 0) % steps.length
            : undefined;
          const before = JSON.stringify(
            await fleet.runRecord(workflow, run.id),
          );
          let refused = false;
          try {
            await fleet.retryRun(
              "gated",
              run.id,
              from !== undefined ? { fromStep: steps[from] } : {},
            );
          } catch {
            refused = true;
          }
          const approvedGate = [...model.gates.values()].includes("approved");
          const reasked = from === 0 &&
            [...model.lanes.values()].every((s) => s !== "succeeded") &&
            approvedGate;
          const accepted = model.retry(from);
          assertEquals(refused, accepted === undefined, step);
          if (accepted !== undefined && accepted.keptSteps > 0) {
            coverage.partlyFinishedRetry++;
          }
          if (
            accepted !== undefined && from !== undefined && from > 0 &&
            approvedGate
          ) {
            coverage.laterFromNoReask++;
          }
          if (refused) {
            coverage.refused++;
            assertEquals(
              JSON.stringify(await fleet.runRecord(workflow, run.id)),
              before,
              step,
            );
          } else if (reasked) coverage.reasked++;
          await check(step);
        }

        for (let i = 1; i < saves.length; i++) {
          if (saves[i].decision) continue;
          if (saves[i].data.id !== saves[i - 1].data.id) continue;
          const verdict = judgeRunRecord({
            workflowId: saves[i].data.workflowId,
            runId: saves[i].data.id,
            before: saves[i - 1].data,
            after: saves[i].data,
          });
          assertEquals(
            verdict.refusal,
            undefined,
            `save ${i}: ${JSON.stringify(scenario)}`,
          );
        }
      }),
      {
        numRuns: 150,
        examples: [
          // a canary failing within the budget, approved, then a later lane fails
          [{
            workers: 3,
            batches: [1, 1, "100%"],
            maxFailures: 1,
            approve: ["canary"],
            failing: [0, 1],
            actions: [{ kind: "approve" }, { kind: "fix" }, {
              kind: "retry",
            }],
          }],
          // a later lane failing unstarted halts; the retry runs the canary first
          [{
            workers: 3,
            batches: [1, "100%"],
            maxFailures: 0,
            approve: ["plan", "canary"],
            failing: [],
            actions: [
              { kind: "disconnect", worker: 2 },
              { kind: "approve" },
              {
                kind: "reconnect",
                worker: 2,
              },
              { kind: "retry" },
              { kind: "approve" },
            ],
          }],
          // a later lane failing unstarted is budget the canary gate shows
          [{
            workers: 3,
            batches: [1, "100%"],
            maxFailures: 1,
            approve: ["plan", "canary"],
            failing: [],
            actions: [{ kind: "disconnect", worker: 2 }, { kind: "approve" }, {
              kind: "approve",
            }],
          }],
          // --from with no lane kept asks both approved gates again
          [{
            workers: 2,
            batches: [1, "100%"],
            maxFailures: 0,
            approve: ["plan", "canary"],
            failing: [0, 1],
            actions: [
              { kind: "approve" },
              { kind: "retryFrom" },
              {
                kind: "approve",
              },
              { kind: "fix" },
              { kind: "approve" },
            ],
          }],
          // a lane failing at apply keeps its prepare on every retry
          [{
            workers: 2,
            batches: ["100%"],
            maxFailures: null,
            approve: ["plan"],
            steps: 3,
            failing: [],
            failingAt: [{ worker: 0, step: 1 }],
            actions: [
              { kind: "approve" },
              { kind: "retry" },
              { kind: "retry" },
              { kind: "fix" },
              { kind: "retry" },
            ],
          }],
          // --from a later step re-runs it without asking the approved gates
          [{
            workers: 2,
            batches: [1, "100%"],
            maxFailures: 1,
            approve: ["plan", "canary"],
            steps: 2,
            failing: [],
            failingAt: [{ worker: 1, step: 1 }],
            actions: [
              { kind: "approve" },
              { kind: "approve" },
              { kind: "retryFrom", step: 1 },
              { kind: "retryFrom", step: 1 },
              { kind: "fix" },
              { kind: "retryFrom", step: 1 },
            ],
          }],
          // --from the first step with no lane kept asks the plan gate each time
          [{
            workers: 2,
            batches: ["100%"],
            maxFailures: null,
            approve: ["plan"],
            steps: 2,
            failing: [0, 1],
            actions: [
              { kind: "approve" },
              { kind: "retryFrom", step: 0 },
              { kind: "approve" },
              { kind: "retryFrom", step: 0 },
              { kind: "approve" },
              { kind: "retryFrom", step: 0 },
            ],
          }],
          // --from leaves no later lane to start, so the canary gate is held unasked
          [{
            workers: 2,
            batches: [1, "100%"],
            maxFailures: null,
            approve: ["canary"],
            steps: 1,
            failing: [0, 1],
            failingAt: [],
            actions: [
              { kind: "approve" },
              { kind: "disconnect", worker: 1 },
              { kind: "retryFrom", step: 0 },
              { kind: "retry" },
              { kind: "fix" },
            ],
          }],
          // --from apply reopens a lane that kept its failed prepare; an offline
          // lane halts the rollout before it starts, so the halt holds it once
          [{
            workers: 2,
            batches: [1, 1, "100%"],
            maxFailures: 0,
            approve: ["canary"],
            steps: 2,
            failing: [],
            failingAt: [{ worker: 0, step: 0 }],
            actions: [
              { kind: "disconnect", worker: 1 },
              { kind: "retryFrom", step: 1 },
            ],
          }],
          // a plain retry after --from asks the canary gate it never reached
          [{
            workers: 3,
            batches: [2, "100%"],
            maxFailures: null,
            approve: ["canary"],
            failing: [0, 1, 3],
            actions: [
              { kind: "disconnect", worker: 2 },
              { kind: "approve" },
              { kind: "retryFrom" },
              { kind: "retry" },
            ],
          }],
          // a retry that halts again with no lane left to hold
          [{
            workers: 3,
            batches: [2, "100%"],
            maxFailures: 1,
            approve: ["canary"],
            failing: [0, 1],
            actions: [
              { kind: "disconnect", worker: 2 },
              { kind: "retry" },
              { kind: "retry" },
            ],
          }],
        ],
      },
    );
    console.log("fan-out gates model coverage", coverage);
    for (const [branch, hits] of Object.entries(coverage)) {
      assert(hits >= 3, `branch ${branch} hit only ${hits} times`);
    }
  },
});
