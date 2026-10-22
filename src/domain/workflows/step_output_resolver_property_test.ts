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

import { assertEquals } from "@std/assert";
import fc from "fast-check";
import type { StepOutputRecord } from "../expressions/step_output_sources.ts";
import {
  liveStepOutputs,
  mergeStepOutputs,
  StepOutputResolver,
  type StepResourceRef,
} from "./step_output_resolver.ts";
import { Workflow } from "./workflow.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { WorkflowRun } from "./workflow_run.ts";

interface Resource {
  name: string;
  version: number;
  namespace: string | undefined;
  attributes: Record<string, string>;
  tagged: boolean;
}

const resourceArb: fc.Arbitrary<Resource> = fc.record({
  name: fc.stringMatching(/^[a-z][a-z0-9]{0,7}$/),
  version: fc.integer({ min: 1, max: 9 }),
  namespace: fc.option(fc.constantFrom("", "acme", "ops"), {
    nil: undefined,
  }),
  attributes: fc.dictionary(
    fc.constantFrom("a", "b", "c", "d"),
    fc.string(),
    { minKeys: 1, maxKeys: 4 },
  ),
  tagged: fc.boolean(),
});

/** Resources with distinct names, as one step's output records them. */
const resourcesArb = fc.uniqueArray(resourceArb, {
  selector: (r) => r.name,
  minLength: 1,
  maxLength: 5,
});

function recordOf(
  resource: Resource,
  attributes: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    id: `id-${resource.name}-${resource.version}`,
    name: resource.name,
    version: resource.version,
    modelType: "test/model",
    modelId: "model-1",
    modelName: "writer",
    specName: "result",
    contentType: "application/json",
    tags: resource.tagged
      ? { "_swamp.sensitiveFields": JSON.stringify(["a"]) }
      : {},
    ...(resource.namespace === undefined
      ? {}
      : { namespace: resource.namespace }),
    attributes,
    content: attributes,
  };
}

function outputOf(
  resources: readonly Resource[],
  attributes: (r: Resource) => Record<string, unknown> | null,
): Record<string, unknown> {
  const records: Record<string, unknown> = {};
  for (const resource of resources) {
    records[resource.name] = recordOf(resource, attributes(resource));
  }
  return {
    type: "model_method",
    model: "writer",
    method: "execute",
    resources: { result: records },
    files: {},
    dataArtifacts: [],
    dataHandles: [],
  };
}

const expectedSources = (
  resources: readonly Resource[],
  readerNamespace: string,
) => [{
  path: [] as string[],
  records: resources.map((r): StepOutputRecord => ({
    id: `id-${r.name}-${r.version}`,
    name: r.name,
    version: r.version,
    namespace: r.namespace ?? readerNamespace,
    modelName: "writer",
    tags: r.tagged ? { "_swamp.sensitiveFields": JSON.stringify(["a"]) } : {},
    attributes: r.attributes,
  })),
}];

Deno.test("liveStepOutputs and StepOutputResolver: for any records, the sources keep write order and each record's identity, namespace (the reader's when it names none), tags and attributes, and the flat outputs are their merge", async () => {
  await fc.assert(
    fc.asyncProperty(
      resourcesArb,
      fc.constantFrom("", "reader"),
      async (resources, readerNamespace) => {
        const merged = mergeStepOutputs(resources.map((r) => r.attributes));
        const expected = expectedSources(resources, readerNamespace);

        const live = liveStepOutputs(
          outputOf(resources, (r) => r.attributes),
          readerNamespace,
        );
        assertEquals(live.outputs, merged);
        assertEquals(live.sources, expected);

        // The same output stripped for the run record, read back.
        const workflow = Workflow.create({
          name: "wf",
          jobs: [Job.create({
            name: "main",
            steps: [Step.create({
              name: "write",
              task: StepTask.model("writer", "execute"),
            })],
          })],
        });
        const run = WorkflowRun.create(workflow);
        run.start();
        const job = run.getJob("main")!;
        job.start();
        const step = job.getStep("write")!;
        step.start();
        step.succeed(outputOf(resources, () => null));
        const byRef = new Map(
          resources.map((r) => [`${r.name}@${r.version}`, r.attributes]),
        );
        const resolver = new StepOutputResolver({
          readAttributes: (ref: StepResourceRef) =>
            Promise.resolve(byRef.get(`${ref.name}@${ref.version}`)),
          namespace: readerNamespace,
        });
        const resolved = await resolver.resolve(step);
        assertEquals(resolved.outputs, merged);
        assertEquals(resolved.sources, expected);
      },
    ),
  );
});
