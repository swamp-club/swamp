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

import { assert, assertEquals, assertThrows } from "@std/assert";
import fc from "fast-check";
import {
  type CreateWorkflowProps,
  isFilenameSafeName,
  Workflow,
  WorkflowSchema,
} from "./workflow.ts";
import { type CreateJobProps, Job } from "./job.ts";
import { type CreateStepProps, Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import {
  TriggerCondition,
  type TriggerConditionData,
} from "./trigger_condition.ts";
import type { DataOutputOverride } from "../models/data_output_override.ts";
import type { PlacementFields } from "./placement.ts";

const LOWER_ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789".split("");
const KEBAB_CHARS = [...LOWER_ALNUM, "-"];
const SCOPED_CHARS = [...LOWER_ALNUM, "-", "_"];

/** Record keys are drawn from a small safe alphabet so no generated key can
 * collide with `__proto__` or other special object keys. */
const arbKey = fc.stringOf(fc.constantFrom(..."abcdefgh".split("")), {
  minLength: 1,
  maxLength: 6,
});

const arbShortString = fc.stringOf(fc.constantFrom(...KEBAB_CHARS), {
  minLength: 1,
  maxLength: 12,
});

/** JSON-ish values only — `undefined` is deliberately excluded so key presence
 * survives the Zod round-trip unambiguously. */
const arbJsonValue: fc.Arbitrary<unknown> = fc.oneof(
  fc.string({ maxLength: 8 }),
  fc.integer({ min: -1000, max: 1000 }),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.string({ maxLength: 5 }), { maxLength: 3 }),
);

const arbStringRecord = fc.dictionary(arbKey, fc.string({ maxLength: 8 }), {
  maxKeys: 3,
});

const arbUnknownRecord = fc.dictionary(arbKey, arbJsonValue, { maxKeys: 3 });

/** Names that satisfy WORKFLOW_NAME_PATTERN and the 64-char cap. */
const arbStrictWorkflowName = fc
  .tuple(
    fc.constantFrom(...LOWER_ALNUM),
    fc.stringOf(fc.constantFrom(...KEBAB_CHARS), { maxLength: 20 }),
  )
  .map(([head, rest]) => head + rest);

/** Scoped `@collective/name` names — accepted by workflowNameBase but never
 * filename-safe. */
const arbScopedWorkflowName = fc
  .tuple(
    fc.stringOf(fc.constantFrom(...SCOPED_CHARS), {
      minLength: 1,
      maxLength: 12,
    }),
    fc.stringOf(fc.constantFrom(...SCOPED_CHARS), {
      minLength: 1,
      maxLength: 12,
    }),
    fc.array(
      fc.stringOf(fc.constantFrom(...SCOPED_CHARS), {
        minLength: 1,
        maxLength: 8,
      }),
      { maxLength: 2 },
    ),
  )
  .map(([collective, name, extra]) =>
    [`@${collective}`, name, ...extra].join("/")
  );

const arbWorkflowName = fc.oneof(
  { arbitrary: arbStrictWorkflowName, weight: 3 },
  { arbitrary: arbScopedWorkflowName, weight: 1 },
);

const arbPlacementFields: fc.Arbitrary<PlacementFields> = fc.record({
  target: arbShortString,
  labels: arbStringRecord,
  platform: fc.constantFrom("linux/amd64", "linux/arm64", "darwin/arm64"),
  queueTimeout: fc.integer({ min: 0, max: 7200 }),
}, { requiredKeys: [] });

const arbLeafCondition: fc.Arbitrary<TriggerCondition> = fc
  .constantFrom("always", "succeeded", "failed", "completed", "skipped")
  .map((type) => TriggerCondition.fromData({ type } as TriggerConditionData));

const arbTriggerCondition: fc.Arbitrary<TriggerCondition> = fc.oneof(
  { arbitrary: arbLeafCondition, weight: 4 },
  {
    arbitrary: fc
      .array(arbLeafCondition, { minLength: 2, maxLength: 3 })
      .map((cs) => TriggerCondition.and(cs)),
    weight: 1,
  },
  {
    arbitrary: fc
      .array(arbLeafCondition, { minLength: 2, maxLength: 3 })
      .map((cs) => TriggerCondition.or(cs)),
    weight: 1,
  },
  {
    arbitrary: arbLeafCondition.map((c) => TriggerCondition.not(c)),
    weight: 1,
  },
);

const arbLifetime = fc.oneof(
  fc.constantFrom("ephemeral", "infinite", "job", "workflow"),
  fc
    .tuple(
      fc.integer({ min: 1, max: 99 }),
      fc.constantFrom("h", "m", "d", "w", "mo", "y"),
    )
    .map(([n, unit]) => `${n}${unit}`),
);

// `vaultName` is deliberately omitted: Step.fromData/toData drop it (see the
// "step dataOutputOverrides drop vaultName" property below).
const arbDataOutputOverride: fc.Arbitrary<DataOutputOverride> = fc.record({
  specName: arbShortString,
  lifetime: arbLifetime,
  garbageCollection: fc.integer({ min: 1, max: 10 }),
  tags: arbStringRecord,
  vary: fc.array(arbShortString, { minLength: 1, maxLength: 2 }),
}, { requiredKeys: ["specName"] });

const arbStepTask: fc.Arbitrary<StepTask> = fc.oneof(
  fc
    .tuple(
      arbShortString,
      arbShortString,
      fc.option(arbUnknownRecord, { nil: undefined }),
    )
    .map(([model, method, inputs]) =>
      StepTask.modelMethod(model, method, inputs)
    ),
  fc
    .tuple(
      arbShortString,
      arbShortString,
      arbShortString,
      fc.option(arbUnknownRecord, { nil: undefined }),
      fc.option(arbUnknownRecord, { nil: undefined }),
    )
    .map(([type, name, method, inputs, globalArgs]) =>
      StepTask.directExecution(type, name, method, inputs, globalArgs)
    ),
  fc
    .tuple(arbShortString, fc.option(arbUnknownRecord, { nil: undefined }))
    .map(([workflow, inputs]) => StepTask.workflow(workflow, inputs)),
  fc
    .tuple(
      arbShortString,
      fc.option(fc.integer({ min: 1, max: 600 }), { nil: undefined }),
    )
    .map(([prompt, timeout]) => StepTask.manualApproval(prompt, timeout)),
  fc
    .tuple(
      arbShortString,
      arbShortString,
      fc.constantFrom("low" as const, "medium" as const, "high" as const),
    )
    .map(([expr, message, severity]) =>
      StepTask.assert(expr, message, severity)
    ),
);

/** Everything about a step except its name and dependencies, which the
 * assembler fills in so names stay unique and dependencies stay acyclic. */
type StepShape = Omit<CreateStepProps, "name" | "dependsOn">;

const arbStepShape: fc.Arbitrary<StepShape> = fc
  .tuple(
    fc.record({
      description: arbShortString,
      task: arbStepTask,
      forEach: fc.record({ item: arbShortString, in: arbShortString }),
      weight: fc.integer({ min: -5, max: 5 }),
      concurrency: fc.integer({ min: 0, max: 4 }),
      dataOutputOverrides: fc.array(arbDataOutputOverride, {
        minLength: 1,
        maxLength: 2,
      }),
      allowFailure: fc.boolean(),
      guard: arbShortString,
    }, { requiredKeys: ["task"] }),
    arbPlacementFields,
  )
  .map(([shape, placement]) => ({ ...shape, ...placement }));

type JobShape =
  & Omit<CreateJobProps, "name" | "steps" | "dependsOn">
  & { steps: StepShape[] };

const arbJobShape: fc.Arbitrary<JobShape> = fc
  .tuple(
    fc.record({
      description: arbShortString,
      weight: fc.integer({ min: -5, max: 5 }),
      concurrency: fc.integer({ min: 0, max: 4 }),
      affinity: fc.boolean(),
    }, { requiredKeys: [] }),
    arbPlacementFields,
    fc.array(arbStepShape, { minLength: 1, maxLength: 3 }),
  )
  .map(([shape, placement, steps]) => ({ ...shape, ...placement, steps }));

type WorkflowShape = Omit<CreateWorkflowProps, "name" | "jobs"> & {
  jobs: JobShape[];
};

const arbWorkflowShape: fc.Arbitrary<WorkflowShape> = fc
  .tuple(
    fc.record({
      description: arbShortString,
      trigger: fc.record({
        schedule: fc.constantFrom(
          "0 * * * *",
          "*/5 * * * *",
          "0 0 * * 1",
          "30 2 1 * *",
        ),
        inputs: arbUnknownRecord,
      }, { requiredKeys: [] }),
      tags: arbStringRecord,
      inputs: fc.record({
        type: fc.constant("object" as const),
        properties: fc.dictionary(
          arbKey,
          fc.record({
            type: fc.constantFrom(
              "string" as const,
              "number" as const,
              "boolean" as const,
            ),
            description: fc.string({ maxLength: 8 }),
            default: arbJsonValue,
          }, { requiredKeys: ["type"] }),
          { maxKeys: 3 },
        ),
        required: fc.array(arbKey, { maxLength: 2 }),
      }, { requiredKeys: [] }),
      version: fc.integer({ min: 1, max: 50 }),
      concurrency: fc.integer({ min: 0, max: 8 }),
      reports: fc.record({
        require: fc.array(
          fc.oneof(
            arbShortString,
            fc.record({
              name: arbShortString,
              methods: fc.array(arbShortString, { maxLength: 2 }),
            }, { requiredKeys: ["name"] }),
          ),
          { maxLength: 3 },
        ),
        skip: fc.array(arbShortString, { maxLength: 2 }),
      }, { requiredKeys: [] }),
      affinity: fc.boolean(),
    }, { requiredKeys: [] }),
    arbPlacementFields,
    fc.array(arbJobShape, { minLength: 1, maxLength: 3 }),
  )
  .map(([shape, placement, jobs]) => ({ ...shape, ...placement, jobs }));

function buildSteps(
  shapes: StepShape[],
  conditions: TriggerCondition[],
): Step[] {
  return shapes.map((shape, index) =>
    Step.create({
      ...shape,
      name: `step-${index}`,
      dependsOn: index === 0 ? [] : [{
        step: `step-${index - 1}`,
        condition: conditions[index % conditions.length],
      }],
    })
  );
}

function buildJobs(
  shapes: JobShape[],
  conditions: TriggerCondition[],
): Job[] {
  return shapes.map((shape, index) => {
    const { steps, ...jobProps } = shape;
    return Job.create({
      ...jobProps,
      name: `job-${index}`,
      steps: buildSteps(steps, conditions),
      dependsOn: index === 0 ? [] : [{
        job: `job-${index - 1}`,
        condition: conditions[index % conditions.length],
      }],
    });
  });
}

function buildWorkflow(
  name: string,
  shape: WorkflowShape,
  conditions: TriggerCondition[],
): Workflow {
  const { jobs, ...workflowProps } = shape;
  return Workflow.create({
    ...workflowProps,
    name,
    jobs: buildJobs(jobs, conditions),
  });
}

function makeStep(name: string): Step {
  return Step.create({
    name,
    task: StepTask.modelMethod("test/model", "run"),
  });
}

function makeJob(name: string): Job {
  return Job.create({
    name,
    steps: [makeStep("step-1")],
  });
}

Deno.test("property: schema rejects empty jobs array", () => {
  fc.assert(
    fc.property(arbStrictWorkflowName, (name) => {
      assertThrows(() => {
        WorkflowSchema.parse({
          id: crypto.randomUUID(),
          name,
          jobs: [],
          version: 1,
        });
      });
    }),
    { numRuns: 50 },
  );
});

Deno.test("property: duplicate job names cause rejection", () => {
  fc.assert(
    fc.property(
      arbWorkflowName,
      fc.string({ minLength: 1, maxLength: 20 }),
      (wfName, jobName) => {
        const wf = Workflow.create({
          name: wfName,
          jobs: [makeJob(jobName)],
        });
        assertThrows(
          () => wf.addJob(makeJob(jobName)),
          Error,
          "already exists",
        );
      },
    ),
    { numRuns: 50 },
  );
});

Deno.test("property: serialization round-trips every workflow field", () => {
  fc.assert(
    fc.property(
      arbWorkflowName,
      arbWorkflowShape,
      fc.array(arbTriggerCondition, { minLength: 1, maxLength: 4 }),
      (name, shape, conditions) => {
        const original = buildWorkflow(name, shape, conditions);
        const data = original.toData();
        // Full structural equality so fields added to WorkflowSchema in the
        // future are covered without touching this assertion.
        assertEquals(Workflow.fromData(data).toData(), data);
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("property: round-tripped workflow exposes the same accessors", () => {
  fc.assert(
    fc.property(
      arbWorkflowName,
      arbWorkflowShape,
      fc.array(arbTriggerCondition, { minLength: 1, maxLength: 4 }),
      (name, shape, conditions) => {
        const original = buildWorkflow(name, shape, conditions);
        const restored = Workflow.fromData(original.toData());
        assertEquals(restored.id, original.id);
        assertEquals(restored.name, original.name);
        assertEquals(restored.schedule, original.schedule);
        assertEquals(restored.triggerInputs, original.triggerInputs);
        assertEquals(restored.placementFields, original.placementFields);
        assertEquals(
          restored.jobs.map((j) => j.name),
          original.jobs.map((j) => j.name),
        );
        assertEquals(
          restored.jobs.map((j) => j.placementFields),
          original.jobs.map((j) => j.placementFields),
        );
      },
    ),
    { numRuns: 100 },
  );
});

Deno.test("property: getJob finds jobs by name", () => {
  fc.assert(
    fc.property(
      arbWorkflowName,
      fc.string({ minLength: 1, maxLength: 20 }),
      (wfName, jobName) => {
        const wf = Workflow.create({
          name: wfName,
          jobs: [makeJob(jobName)],
        });
        const found = wf.getJob(jobName);
        assert(found !== undefined);
        assertEquals(found!.name, jobName);
        assertEquals(wf.getJob("nonexistent-" + jobName), undefined);
      },
    ),
    { numRuns: 50 },
  );
});

Deno.test("property: scoped @collective/name workflows are accepted", () => {
  fc.assert(
    fc.property(arbScopedWorkflowName, (name) => {
      const wf = Workflow.create({ name, jobs: [makeJob("job-1")] });
      assertEquals(wf.name, name);
      assertEquals(Workflow.fromData(wf.toData()).name, name);
    }),
    { numRuns: 100 },
  );
});

Deno.test("property: isFilenameSafeName accepts strict names within the length cap", () => {
  fc.assert(
    fc.property(arbStrictWorkflowName, (name) => {
      assert(name.length <= 64);
      assert(isFilenameSafeName(name));
      // A strict name is also creatable, so filename-safe implies creatable.
      Workflow.create({ name, jobs: [makeJob("job-1")] });
    }),
    { numRuns: 200 },
  );
});

Deno.test("property: isFilenameSafeName rejects scoped names that workflowNameBase accepts", () => {
  fc.assert(
    fc.property(arbScopedWorkflowName, (name) => {
      // Scoped names pass the base name validation (Workflow.create succeeds)
      // but are never filename-safe — they carry '@' and '/'.
      Workflow.create({ name, jobs: [makeJob("job-1")] });
      assertEquals(isFilenameSafeName(name), false);
    }),
    { numRuns: 200 },
  );
});

Deno.test("property: isFilenameSafeName rejects over-long names", () => {
  fc.assert(
    fc.property(
      fc
        .tuple(
          fc.constantFrom(...LOWER_ALNUM),
          fc.stringOf(fc.constantFrom(...KEBAB_CHARS), {
            minLength: 64,
            maxLength: 90,
          }),
        )
        .map(([head, rest]) => head + rest),
      (name) => {
        assert(name.length > 64);
        assertEquals(isFilenameSafeName(name), false);
        // Unscoped names also fail the strict schema above the cap.
        assertThrows(() => Workflow.create({ name, jobs: [makeJob("job-1")] }));
      },
    ),
    { numRuns: 100 },
  );
});

Deno.test("property: step dataOutputOverrides drop vaultName (current behavior)", () => {
  // BUG CANDIDATE: DataOutputOverrideSchema accepts `vaultName` and
  // data_writer.ts consumes it, but Step.fromData (step.ts ~L228) and
  // Step.toData (~L305) rebuild overrides field-by-field without vaultName,
  // so a step-level vault override is silently discarded. This property
  // encodes today's lossy behavior rather than the intended one.
  fc.assert(
    fc.property(arbShortString, arbShortString, (specName, vaultName) => {
      const step = Step.create({
        name: "step-0",
        task: StepTask.modelMethod("test/model", "run"),
        dataOutputOverrides: [{ specName, vaultName }],
      });
      assertEquals(step.dataOutputOverrides[0].vaultName, undefined);
      assertEquals(step.toData().dataOutputOverrides?.[0].vaultName, undefined);
    }),
    { numRuns: 50 },
  );
});
