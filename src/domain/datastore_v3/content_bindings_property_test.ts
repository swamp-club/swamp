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
  type DeclaredIdentity,
  identityRefusal,
  isCanonicalRunLogFile,
  judgeRunRecord,
  type KeyFacts,
} from "./content_bindings.ts";
import type { WorkflowRunData } from "../workflows/workflow_run.ts";
import type { Intent } from "./intent.ts";

const name = fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/);
const type = fc.stringMatching(/^[a-z]{1,6}\/[a-z]{1,6}$/);

const bound = fc.record({
  id: fc.uuid(),
  name,
  type,
  uuidKey: fc.boolean(),
  edit: fc.boolean(),
});

function scenario(b: {
  id: string;
  name: string;
  type: string;
  uuidKey: boolean;
  edit: boolean;
}): {
  intent: Intent;
  key: KeyFacts;
  declared: DeclaredIdentity;
  stored?: DeclaredIdentity;
} {
  const declared = { id: b.id, name: b.name, type: b.type };
  return {
    intent: {
      kind: b.edit ? "definition.edit" : "definition.create",
      definition: { kind: "model", name: b.name },
    },
    key: { type: b.type, ...(b.uuidKey ? { fileId: b.id.toLowerCase() } : {}) },
    declared,
    ...(b.edit ? { stored: declared } : {}),
  };
}

Deno.test("identityRefusal (property): content declaring its own identity always passes", () => {
  fc.assert(
    fc.property(bound, (b) => {
      const s = scenario(b);
      assertEquals(
        identityRefusal(s.intent, s.key, s.declared, s.stored),
        undefined,
      );
    }),
  );
});

Deno.test("identityRefusal (property): changing any one declared field away from its binding refuses", () => {
  fc.assert(
    fc.property(
      bound,
      fc.constantFrom("id" as const, "name" as const, "type" as const),
      fc.uuid(),
      name,
      type,
      (b, field, otherId, otherName, otherType) => {
        const s = scenario(b);
        const changed = { ...s.declared };
        if (field === "id") changed.id = otherId;
        if (field === "name") changed.name = otherName;
        if (field === "type") changed.type = otherType;
        fc.pre(changed[field] !== s.declared[field]);
        // An id is only bound by a uuid key or a stored definition.
        fc.pre(field !== "id" || b.uuidKey || b.edit);
        assert(
          identityRefusal(s.intent, s.key, changed, s.stored) !== undefined,
          `${field} changed`,
        );
      },
    ),
  );
});

Deno.test("isCanonicalRunLogFile (property): any path but the run's own is refused", () => {
  fc.assert(
    fc.property(
      fc.uuid(),
      fc.uuid(),
      fc.string(),
      (workflowId, runId, path) => {
        const own =
          `.swamp/workflow-runs/${workflowId}/workflow-run-${runId}.log`;
        fc.pre(path.replaceAll("\\", "/") !== own);
        assert(!isCanonicalRunLogFile(path, workflowId, runId));
      },
    ),
  );
});

const FAN_WORKFLOW = "22222222-3333-4444-8555-666666666666";
const FAN_RUN = "33333333-4444-4555-8666-777777777777";

type StepStatus = "pending" | "running" | "succeeded" | "failed";

interface FanJob {
  status: "pending" | "running";
  steps: { stepName: string; status: StepStatus }[];
  plan?: Record<string, unknown>;
}

function fanRecord(job: FanJob | undefined): WorkflowRunData {
  return {
    id: FAN_RUN,
    workflowId: FAN_WORKFLOW,
    workflowName: "fleet",
    status: "running",
    tags: {},
    jobs: job === undefined ? [] : [{
      jobName: "patch",
      status: job.status,
      steps: job.steps.map((step) => ({ ...step })),
      ...(job.plan !== undefined ? { fanOutPlan: job.plan } : {}),
    }],
  } as unknown as WorkflowRunData;
}

function planFor(workers: readonly string[]): Record<string, unknown> {
  return {
    members: workers.map((worker) => ({
      worker,
      instanceUuid: `u-${worker}`,
      disposition: "dispatch",
      batch: 0,
    })),
    plannedLanes: workers.length,
    maxFailures: null,
    batches: [[...workers]],
    lanes: workers.map((worker) => ({
      name: `patch[${worker}]`,
      worker,
      instanceUuid: `u-${worker}`,
      steps: [],
    })),
  };
}

// every lawful record sequence, including a save of the started job before its plan
const honestHistory = fc.record({
  steps: fc.uniqueArray(fc.constantFrom("apply", "verify", "check"), {
    minLength: 1,
    maxLength: 3,
  }),
  workers: fc.uniqueArray(fc.constantFrom("w-a", "w-b", "w-c"), {
    minLength: 1,
    maxLength: 3,
  }),
  runningSave: fc.boolean(),
  progress: fc.array(
    fc.tuple(
      fc.nat(),
      fc.constantFrom<StepStatus>("running", "succeeded", "failed"),
    ),
    { maxLength: 8 },
  ),
}).map(({ steps, workers, runningSave, progress }) => {
  const history: FanJob[] = [{
    status: "pending",
    steps: steps.map((stepName) => ({ stepName, status: "pending" })),
  }];
  if (runningSave) {
    history.push({ ...history[0], status: "running" });
  }
  const laneSteps = workers.flatMap((worker) =>
    steps.map((step) => ({
      stepName: `${step}[${worker}]`,
      status: "pending" as StepStatus,
    }))
  );
  const plan = planFor(workers);
  history.push({ status: "running", steps: laneSteps, plan });
  let current = laneSteps;
  for (const [index, status] of progress) {
    current = current.map((step, i) =>
      i === index % current.length ? { ...step, status } : step
    );
    history.push({ status: "running", steps: current, plan });
  }
  return { history, workers };
});

Deno.test("judgeRunRecord (property): every honest fan-out record history is accepted", () => {
  fc.assert(
    fc.property(honestHistory, ({ history }) => {
      assertEquals(
        judgeRunRecord({
          workflowId: FAN_WORKFLOW,
          runId: FAN_RUN,
          before: undefined,
          after: fanRecord(history[0]),
        }).refusal,
        undefined,
      );
      for (let i = 1; i < history.length; i++) {
        assertEquals(
          judgeRunRecord({
            workflowId: FAN_WORKFLOW,
            runId: FAN_RUN,
            before: fanRecord(history[i - 1]),
            after: fanRecord(history[i]),
          }).refusal,
          undefined,
          `record ${i}`,
        );
      }
    }),
    { numRuns: 1000 },
  );
});

type Forgery =
  | "first-record-plan"
  | "change-plan"
  | "drop-plan"
  | "drop-job"
  | "late-plan"
  | "lane-steps";

Deno.test("judgeRunRecord (property): every forged fan-out plan is refused, wherever it lands in the history", () => {
  fc.assert(
    fc.property(
      honestHistory,
      fc.constantFrom<Forgery>(
        "first-record-plan",
        "change-plan",
        "drop-plan",
        "drop-job",
        "late-plan",
        "lane-steps",
      ),
      fc.nat(),
      fc.constantFrom(
        "maxFailures",
        "members",
        "batches",
        "lanes",
        "plannedLanes",
      ),
      ({ history, workers }, forgery, at, field) => {
        const planned = history.findIndex((job) => job.plan !== undefined);
        const plan = history[planned].plan!;
        let before: FanJob | undefined;
        let after: FanJob | undefined;
        if (forgery === "first-record-plan") {
          before = undefined;
          after = history[planned];
        } else if (forgery === "late-plan") {
          const started = history[0].steps.map((step, i) =>
            i === at % history[0].steps.length
              ? { ...step, status: "running" as StepStatus }
              : step
          );
          before = { status: "running", steps: started };
          after = history[planned];
        } else if (forgery === "lane-steps") {
          before = history[planned - 1];
          const lanes = (plan.lanes as { steps: unknown[] }[]).map((lane) => ({
            ...lane,
            steps: [{ stepName: "apply", status: "succeeded" }],
          }));
          after = { ...history[planned], plan: { ...plan, lanes } };
        } else {
          const from = planned + (at % (history.length - planned));
          before = history[from];
          const next = history[from + 1] ?? history[from];
          if (forgery === "drop-plan") {
            after = { status: next.status, steps: next.steps };
          } else if (forgery === "drop-job") {
            after = undefined;
          } else {
            const altered: Record<string, unknown> = { ...plan };
            if (field === "maxFailures") altered.maxFailures = 5;
            if (field === "plannedLanes") {
              altered.plannedLanes = workers.length + 1;
            }
            if (field === "members") {
              altered.members = [
                ...(plan.members as unknown[]),
                { worker: "w-z", instanceUuid: "u-z", disposition: "excluded" },
              ];
            }
            if (field === "batches") altered.batches = [[...workers, "w-z"]];
            if (field === "lanes") altered.lanes = [];
            after = { ...next, plan: altered };
          }
        }
        assert(
          judgeRunRecord({
            workflowId: FAN_WORKFLOW,
            runId: FAN_RUN,
            before: before === undefined ? undefined : fanRecord(before),
            after: fanRecord(after),
          }).refusal !== undefined,
          forgery,
        );
      },
    ),
    { numRuns: 2000 },
  );
});
