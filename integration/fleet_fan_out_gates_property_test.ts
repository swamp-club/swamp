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
import type { WorkflowRunData } from "../src/domain/workflows/workflow_run.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { Fleet, type FleetWorker } from "./fleet_harness.ts";

await initializeLogging({});

const SANITIZE = { sanitizeOps: false, sanitizeResources: false };
const WEB = { fleet: "web" };

type GateKind = "plan" | "canary";
type LaneState = "pending" | "succeeded" | "failed" | "held";
type GateState = "pending" | "waiting" | "approved" | "rejected" | "held";

type Action =
  | { kind: "approve" }
  | { kind: "reject" }
  | { kind: "retry" }
  | { kind: "retryFrom" }
  | { kind: "fix" }
  | { kind: "break"; worker: number }
  | { kind: "disconnect"; worker: number }
  | { kind: "reconnect"; worker: number };

interface Scenario {
  workers: number;
  batches: (number | string)[];
  maxFailures: number | null;
  approve: GateKind[];
  failing: number[];
  actions: Action[];
}

/** the gate semantics, stated independently: it shares no code with the executor */
class Model {
  readonly lanes = new Map<string, LaneState>();
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
    readonly failing: Set<string>,
  ) {
    for (const worker of batches.flat()) {
      this.lanes.set(worker, "pending");
      this.dispatches.set(worker, 0);
    }
    if (approve.includes("plan")) this.gates.set("plan", "pending");
    if (approve.includes("canary") && batches.length > 1) {
      this.gates.set("canary", "pending");
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
    const rerun = new Set(
      [...this.lanes].filter(([, s]) => s === "pending").map(([w]) => w),
    );
    const failed = new Set(
      [...this.lanes].filter(([w, s]) => s === "failed" && !rerun.has(w))
        .map(([w]) => w),
    );
    // offline fail: a stored plan's lane whose worker is gone fails unstarted
    if (stored) {
      for (const worker of rerun) {
        if (!this.offline.has(worker)) continue;
        this.lanes.set(worker, "failed");
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
        if (this.lanes.get(worker) !== "pending") continue;
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
        this.dispatches.set(worker, this.dispatches.get(worker)! + 1);
        const outcome = this.failing.has(worker) ? "failed" : "succeeded";
        this.lanes.set(worker, outcome);
        if (outcome === "failed") failed.add(worker);
      }
      if (paused) {
        this.gates.set("canary", "waiting");
        this.status = "suspended";
        return;
      }
      if (halted) break;
    }
    const held = order.flat().filter((w) => this.lanes.get(w) === "pending");
    if (held.length > 0) {
      for (const worker of held) this.lanes.set(worker, "held");
      if (this.gates.get("canary") === "pending") {
        this.gates.set("canary", "held");
      }
      this.lastHaltFailed = [...failed];
    }
    this.status = [...this.lanes.values()].some((s) => s !== "succeeded")
      ? "failed"
      : "succeeded";
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
    for (const [worker, state] of this.lanes) {
      if (state === "pending") this.lanes.set(worker, "held");
    }
    for (const [kind, state] of this.gates) {
      if (state === "pending") this.gates.set(kind, "held");
    }
    this.status = "failed";
  }

  /** false when the retry is refused and nothing changes */
  retry(fromStart: boolean): boolean {
    if (this.rejected) return false;
    let kept = 0;
    for (const [worker, state] of this.lanes) {
      if (state === "succeeded") kept++;
      else this.lanes.set(worker, "pending");
    }
    for (const [kind, state] of this.gates) {
      if (state === "held" || (fromStart && kept === 0)) {
        this.gates.set(kind, "pending");
      }
    }
    this.run();
    return true;
  }
}

const LANE: Record<string, LaneState> = {
  pending: "pending",
  succeeded: "succeeded",
  failed: "failed",
  skipped: "held",
};
const GATE: Record<string, GateState> = {
  pending: "pending",
  waiting_approval: "waiting",
  succeeded: "approved",
  failed: "rejected",
  skipped: "held",
};

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
  failing: fc.oneof(
    { weight: 3, arbitrary: fc.subarray([0, 1, 2, 3], { minLength: 1 }) },
    { weight: 1, arbitrary: fc.constant<number[]>([]) },
  ),
  actions: fc.array(
    fc.oneof(
      fc.constant<Action>({ kind: "approve" }),
      fc.constant<Action>({ kind: "approve" }),
      fc.constant<Action>({ kind: "reject" }),
      fc.constant<Action>({ kind: "retry" }),
      fc.constant<Action>({ kind: "retryFrom" }),
      fc.constant<Action>({ kind: "retryFrom" }),
      fc.constant<Action>({ kind: "fix" }),
      fc.integer({ min: 0, max: 3 }).map((worker): Action => ({
        kind: "break",
        worker,
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

function observed(data: WorkflowRunData) {
  const job = data.jobs[0];
  const lanes = new Map<string, LaneState>();
  const gates = new Map<GateKind, GateState>();
  for (const step of job.steps) {
    const gate = /^patch\[approve-(plan|canary)\]$/.exec(step.stepName);
    if (gate) gates.set(gate[1] as GateKind, GATE[step.status]);
    const lane = /^apply\[(.+)\]$/.exec(step.stepName);
    if (lane) lanes.set(lane[1], LANE[step.status]);
  }
  return { status: data.status, lanes, gates };
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
        const failing = new Set(
          scenario.failing.filter((i) => i < names.length).map((i) => names[i]),
        );
        const behave = () => {
          fleetWorkers.forEach((worker) => {
            worker.behavior = failing.has(worker.name)
              ? { kind: "fail", error: "broke" }
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
            steps: [{
              name: "apply",
              task: {
                type: "model_method",
                modelType: fleet.modelType.normalized,
                modelName: "host-patch",
                methodName: "run",
              },
            }],
          }],
        });
        const run = await fleet.runWorkflow("gated");
        const first = await fleet.runRecord(workflow, run.id);
        const batches = first.jobs[0].fanOutPlan!.batches.map((b) => [...b]);
        const model = new Model(
          batches,
          scenario.maxFailures,
          scenario.approve,
          failing,
        );
        model.run();

        const check = async (step: string) => {
          const record = await fleet.runRecord(workflow, run.id);
          const actual = observed(record);
          const context = `${step}: ${JSON.stringify(scenario)}`;
          assertEquals(actual.status, model.status, context);
          assertEquals(actual.lanes, model.lanes, context);
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
            failing.clear();
            behave();
            continue;
          }
          if (action.kind === "break") {
            const name = names[action.worker % names.length];
            failing.add(name);
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
          const fromStart = action.kind === "retryFrom";
          const before = JSON.stringify(
            await fleet.runRecord(workflow, run.id),
          );
          let refused = false;
          try {
            await fleet.retryRun(
              "gated",
              run.id,
              fromStart ? { fromStep: "apply" } : {},
            );
          } catch {
            refused = true;
          }
          const reasked = fromStart &&
            [...model.lanes.values()].every((s) => s !== "succeeded") &&
            [...model.gates.values()].includes("approved");
          const accepted = model.retry(fromStart);
          assertEquals(refused, !accepted, step);
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
        ],
      },
    );
    console.log("fan-out gates model coverage", coverage);
    for (const [branch, hits] of Object.entries(coverage)) {
      assert(hits >= 3, `branch ${branch} hit only ${hits} times`);
    }
  },
});
