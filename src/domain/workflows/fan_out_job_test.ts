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

import { assertEquals, assertThrows } from "@std/assert";
import { UserError } from "../errors.ts";
import {
  fanOutJobRefusals,
  fanOutPlanMissing,
  refuseFanOutRun,
} from "./fan_out_job.ts";
import { Workflow, type WorkflowInput } from "./workflow.ts";

const DIRECT = {
  type: "behavior",
  behaviorType: "command/shell",
  behaviorName: "patch",
  methodName: "execute",
};

function fanOutWorkflow(
  job: Record<string, unknown> = {},
  workflow: Record<string, unknown> = {},
): WorkflowInput {
  return {
    id: crypto.randomUUID(),
    name: "fleet",
    ...workflow,
    jobs: [{
      name: "patch",
      fanOut: "all",
      labels: { role: "web" },
      steps: [{ name: "apply", task: DIRECT }],
      ...job,
    }],
  } as unknown as WorkflowInput;
}

function refusalsOf(data: WorkflowInput): string[] {
  try {
    Workflow.fromData(data);
    return [];
  } catch (error) {
    const issues = (error as { issues?: { message: string }[] }).issues;
    if (issues === undefined) throw error;
    return issues.map((issue) => issue.message);
  }
}

Deno.test("validateWorkflow: a fan-out job with labels and a behaviorType task is accepted", () => {
  assertEquals(refusalsOf(fanOutWorkflow()), []);
});

Deno.test("validateWorkflow: a fan-out job with a target is refused", () => {
  assertEquals(refusalsOf(fanOutWorkflow({ target: "host-a" })), [
    "Fan-out job 'patch' sets target, which names one worker. Remove target and select the workers with labels or platform.",
  ]);
});

Deno.test("validateWorkflow: a workflow-level target a fan-out job inherits is refused", () => {
  assertEquals(refusalsOf(fanOutWorkflow({}, { target: "host-a" })), [
    "The workflow sets target, which fan-out job 'patch' would inherit and which names one worker. Remove target from the workflow, or set it on the jobs that need it.",
  ]);
});

Deno.test("validateWorkflow: a fan-out job with no labels or platform in effect is refused", () => {
  const message =
    "Fan-out job 'patch' has no labels or platform in effect. Set labels or platform on the job or the workflow; to reach every worker, give them a shared label and select it.";
  assertEquals(refusalsOf(fanOutWorkflow({ labels: undefined })), [message]);
  assertEquals(refusalsOf(fanOutWorkflow({ labels: {} })), [message]);
});

Deno.test("validateWorkflow: a fan-out job inherits its selector from the workflow", () => {
  assertEquals(
    refusalsOf(
      fanOutWorkflow({ labels: undefined }, { labels: { role: "web" } }),
    ),
    [],
  );
  assertEquals(
    refusalsOf(fanOutWorkflow({ labels: undefined }, { platform: "linux" })),
    [],
  );
});

Deno.test("validateWorkflow: empty job labels override the workflow's and count as none", () => {
  assertEquals(
    refusalsOf(fanOutWorkflow({ labels: {} }, { labels: { role: "web" } })),
    [
      "Fan-out job 'patch' has no labels or platform in effect. Set labels or platform on the job or the workflow; to reach every worker, give them a shared label and select it.",
    ],
  );
});

Deno.test("validateWorkflow: a step in a fan-out job that sets placement is refused, queueTimeout allowed", () => {
  assertEquals(
    refusalsOf(fanOutWorkflow({
      steps: [{
        name: "apply",
        task: DIRECT,
        target: "host-a",
        labels: { role: "db" },
        platform: "linux",
        queueTimeout: 30,
      }],
    })),
    [
      "Step 'apply' in fan-out job 'patch' sets target, but each lane runs on one worker. Remove target from the step and set placement on the job.",
      "Step 'apply' in fan-out job 'patch' sets labels, but each lane runs on one worker. Remove labels from the step and set placement on the job.",
      "Step 'apply' in fan-out job 'patch' sets platform, but each lane runs on one worker. Remove platform from the step and set placement on the job.",
    ],
  );
  assertEquals(
    refusalsOf(fanOutWorkflow({
      steps: [{ name: "apply", task: DIRECT, queueTimeout: 30 }],
    })),
    [],
  );
});

Deno.test("validateWorkflow: affinity true on a fan-out job is refused", () => {
  assertEquals(refusalsOf(fanOutWorkflow({ affinity: true })), [
    "Fan-out job 'patch' sets affinity: true, but each lane already stays on its own worker. Remove affinity from the job.",
  ]);
});

Deno.test("validateWorkflow: workflow affinity true is refused unless the fan-out job opts out", () => {
  assertEquals(refusalsOf(fanOutWorkflow({}, { affinity: true })), [
    "The workflow sets affinity: true, which would pin fan-out job 'patch' to one worker. Set affinity: false on job 'patch' or remove affinity from the workflow.",
  ]);
  assertEquals(
    refusalsOf(fanOutWorkflow({ affinity: false }, { affinity: true })),
    [],
  );
});

Deno.test("validateWorkflow: forEach on a step in a fan-out job is refused", () => {
  assertEquals(
    refusalsOf(fanOutWorkflow({
      steps: [{
        name: "apply",
        task: DIRECT,
        forEach: { item: "pkg", in: "${{ inputs.pkgs }}" },
      }],
    })),
    [
      "Step 'apply' in fan-out job 'patch' uses forEach, which fan-out jobs do not support yet. Move the loop into a job without fanOut.",
    ],
  );
});

Deno.test("validateWorkflow: a task naming one definition in a fan-out job is refused", () => {
  const message = (name: string) =>
    `Step 'apply' in fan-out job 'patch' runs the named definition '${name}', which every lane would share. Use behaviorType and behaviorName so each worker gets its own instance.`;
  for (
    const task of [
      { type: "behavior", behavior: "web", methodName: "run" },
      { type: "model_method", modelIdOrName: "web", methodName: "run" },
    ]
  ) {
    assertEquals(
      refusalsOf(fanOutWorkflow({ steps: [{ name: "apply", task }] })),
      [message("web")],
    );
  }
  assertEquals(
    refusalsOf(fanOutWorkflow({
      steps: [{
        name: "apply",
        task: {
          type: "model_method",
          modelType: "command/shell",
          modelName: "patch",
          methodName: "execute",
        },
      }],
    })),
    [],
  );
});

Deno.test("validateWorkflow: an assert step in a fan-out job is accepted", () => {
  assertEquals(
    refusalsOf(fanOutWorkflow({
      steps: [
        { name: "apply", task: DIRECT },
        {
          name: "check",
          task: { type: "assert", expr: "true", message: "ok" },
        },
      ],
    })),
    [],
  );
});

Deno.test("validateWorkflow: nested workflow, manual_approval and wait_for_signal steps in a fan-out job are refused", () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ type: "workflow", workflowIdOrName: "child" }, "a nested workflow"],
    [{ type: "manual_approval", prompt: "go?" }, "a manual_approval"],
    [
      {
        type: "wait_for_signal",
        timeout: 60,
        schema: {
          type: "object",
          properties: { verdict: { type: "string" } },
        },
      },
      "a wait_for_signal",
    ],
  ];
  for (const [task, kind] of cases) {
    assertEquals(
      refusalsOf(fanOutWorkflow({ steps: [{ name: "gate", task }] })),
      [
        `Step 'gate' in fan-out job 'patch' is ${kind} step, which fan-out jobs do not support yet. Move it into a job without fanOut.`,
      ],
    );
  }
});

Deno.test("validateWorkflow: the refusals leave a job without fanOut alone", () => {
  assertEquals(
    fanOutJobRefusals({
      affinity: true,
      jobs: [{
        name: "plain",
        steps: [],
        dependsOn: [],
        weight: 0,
        target: "host-a",
      }],
    }),
    [],
  );
});

Deno.test("fanOutPlanMissing: a started fan-out job run without a plan is reported", () => {
  assertEquals(
    fanOutPlanMissing({ fanOut: "all" }, {
      status: "running",
      startedAt: new Date(),
    }),
    true,
  );
  assertEquals(
    fanOutPlanMissing({ fanOut: "all" }, {
      status: "failed",
      startedAt: new Date(),
    }),
    true,
  );
});

Deno.test("fanOutPlanMissing: a fan-out job run that has not started, or holds a plan, is not reported", () => {
  for (const status of ["pending", "skipped", "failed"]) {
    assertEquals(fanOutPlanMissing({ fanOut: "all" }, { status }), false);
  }
  assertEquals(
    fanOutPlanMissing({ fanOut: "all" }, {
      status: "running",
      startedAt: new Date(),
      fanOutPlan: { lanes: [] },
    }),
    false,
  );
});

Deno.test("fanOutPlanMissing: a plain job run is not reported", () => {
  assertEquals(
    fanOutPlanMissing({}, { status: "succeeded", startedAt: new Date() }),
    false,
  );
});

function runWorkflow(
  jobs: {
    name: string;
    fanOut?: string;
    rollout?: unknown;
    steps?: [string, string][];
  }[],
) {
  return {
    name: "fleet",
    jobs: jobs.map((job) => ({
      name: job.name,
      fanOut: job.fanOut,
      fanOutPolicy: job.fanOut === undefined
        ? undefined
        : { rollout: job.rollout },
      steps: (job.steps ?? [["apply", "model_method"]]).map(([name, type]) => ({
        name,
        task: { data: { type } },
      })),
    })),
  };
}

Deno.test("refuseFanOutRun: without a worker pool a workflow with a fan-out job is refused with the --server message", () => {
  assertThrows(
    () =>
      refuseFanOutRun(
        runWorkflow([{ name: "prep" }, { name: "patch", fanOut: "all" }]),
        false,
      ),
    UserError,
    "Workflow 'fleet' has fan-out job 'patch': fanOut needs the worker pool of swamp serve; run it with --server.",
  );
});

Deno.test("refuseFanOutRun: a fan-out workflow holding a step that can suspend in another job runs with a pool", () => {
  for (const kind of ["manual_approval", "wait_for_signal", "workflow"]) {
    refuseFanOutRun(
      runWorkflow([
        { name: "gate", steps: [["hold", kind]] },
        { name: "patch", fanOut: "all" },
      ]),
      true,
    );
  }
});

Deno.test("refuseFanOutRun: a plain workflow passes with or without a pool, and a fan-out one passes with a pool", () => {
  refuseFanOutRun(
    runWorkflow([{ name: "gate", steps: [["hold", "manual_approval"]] }]),
    false,
  );
  refuseFanOutRun(runWorkflow([{ name: "patch", fanOut: "all" }]), true);
});

Deno.test("refuseFanOutRun: a fan-out job that sets rollout is refused until rollouts act on it", () => {
  assertThrows(
    () =>
      refuseFanOutRun(
        runWorkflow([{
          name: "patch",
          fanOut: "all",
          rollout: { batches: [1, "100%"], maxFailures: 0 },
        }]),
        true,
      ),
    UserError,
    "Fan-out job 'patch' in workflow 'fleet' sets rollout",
  );
});
