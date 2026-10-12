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

// Position and value provenance (swamp-club#3205), as a property: text that
// enters a run as data — through any data source — reaches the method
// byte-identical and never resolves anything, whatever it contains, while
// the expression the author wrote beside it keeps resolving. The generator
// labels each value with its true origin, so the oracle never consults the
// implementation's own provenance maps.

import { assertEquals } from "@std/assert";
import fc from "fast-check";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  consumer,
  type Harness,
  oneStepWorkflow,
  runModel,
  runWorkflow,
  saveData,
  TEXT_INPUT,
  withRepo,
  workflowOf,
} from "./expression_provenance_harness.ts";

await initializeLogging({});

/** Expression text the workflows and definitions below author. */
const AUTHORED_RAWS = [
  "${{ env.SECRET }}",
  "${{ inputs.text }}",
  "${{ inputs.value }}",
  "${{ inputs.token }}",
  "${{ self.item }}",
];

/** Text built from fragments that matter at a splice boundary. */
const dataText = fc.array(
  fc.oneof(
    fc.constantFrom(
      ...AUTHORED_RAWS,
      "${{",
      "}}",
      "{{",
      "$",
      " env.SECRET ",
      // Halves of authored expressions, so adjacent splices can join them.
      "${{ env.SECRET",
      "${{ env.SECRET ",
      " }}",
      "${{ inputs.text",
      "env.OTHER",
      "${{ env.OTHER }}",
      "${{ 1 + 2 }}",
      "\\",
      "'",
      '"',
      "\n",
      "é",
      "ü",
    ),
    fc.string({ minLength: 0, maxLength: 4 }),
  ),
  { maxLength: 8 },
).map((parts) => parts.join(""));

type Path = (h: Harness, text: string) => Promise<void>;

/** Every path runs `value` from data and `authored` from authored source. */
const PATHS: Record<string, Path> = {
  "workflow input": async (h, text) => {
    await h.repo.definitionRepo.save(
      h.type,
      consumer({
        value: "${{ inputs.value }}",
        authored: "${{ inputs.token }}",
      }),
    );
    await runWorkflow(
      h,
      oneStepWorkflow(
        StepTask.modelMethod("consumer", "run", {
          value: "${{ inputs.text }}",
          token: "${{ env.SECRET }}",
        }),
        TEXT_INPUT,
      ),
      { text },
    );
  },
  "data content": async (h, text) => {
    await saveData(h, { value: text });
    await h.repo.definitionRepo.save(
      h.type,
      consumer({
        value: '${{ data.latest("producer", "notes").attributes.value }}',
        authored: "${{ env.SECRET }}",
      }),
    );
    await runModel(h.dir);
  },
  "literal input": async (h, text) => {
    await h.repo.definitionRepo.save(
      h.type,
      consumer({
        value: "${{ inputs.value }}",
        authored: "${{ env.SECRET }}",
      }),
    );
    await runModel(h.dir, { value: text }, { literalInputs: true });
  },
  "forEach item": async (h, text) => {
    await h.repo.definitionRepo.save(
      h.type,
      consumer({
        value: "${{ inputs.value }}",
        authored: "${{ inputs.token }}",
      }),
    );
    await runWorkflow(
      h,
      workflowOf("loop", [
        Step.create({
          name: "capture-${{ self._index }}",
          forEach: { item: "item", in: "${{ inputs.items }}" },
          task: StepTask.modelMethod("consumer", "run", {
            value: "${{ self.item }}",
            token: "${{ env.SECRET }}",
          }),
        }),
      ], { type: "object", properties: { items: { type: "array" } } }),
      { items: [text] },
    );
  },
  "child workflow input": async (h, text) => {
    await h.repo.definitionRepo.save(
      h.type,
      consumer({
        value: "${{ inputs.value }}",
        authored: "${{ inputs.token }}",
      }),
    );
    await h.repo.workflowRepo.save(
      workflowOf("child", [
        Step.create({
          name: "capture",
          task: StepTask.modelMethod("consumer", "run", {
            value: "${{ inputs.text }}",
            token: "${{ env.SECRET }}",
          }),
        }),
      ], TEXT_INPUT),
    );
    await runWorkflow(
      h,
      workflowOf("parent", [
        Step.create({
          name: "call",
          task: StepTask.workflow("child", { text: "${{ inputs.text }}" }),
        }),
      ], TEXT_INPUT),
      { text },
    );
  },
};

Deno.test("provenance property: adjacent data splices reach the method verbatim and resolve nothing", async () => {
  await fc.assert(
    fc.asyncProperty(
      // `a` ends with the first half of an authored expression and `b`
      // starts with a closing half, so the splices meet mid-expression.
      fc.tuple(
        dataText,
        fc.constantFrom("${{ env.SECRET", "${{ env.SECRET ", "${{ inputs.text"),
      ).map(([text, half]) => text + half),
      fc.tuple(fc.constantFrom(" }}", "}}", " ", ""), dataText).map((
        [half, text],
      ) => half + text),
      async (a, b) => {
        await withRepo(async (h) => {
          await h.repo.definitionRepo.save(
            h.type,
            consumer({
              value: "${{ inputs.value }}",
              authored: "${{ inputs.token }}",
            }),
          );
          await runWorkflow(
            h,
            oneStepWorkflow(
              StepTask.modelMethod("consumer", "run", {
                value: "${{ inputs.a }}${{ inputs.b }}}}",
                token: "${{ env.SECRET }}",
              }),
              {
                type: "object",
                properties: { a: { type: "string" }, b: { type: "string" } },
              },
            ),
            { a, b },
          );
          assertEquals(h.executions, [{
            value: `${a}${b}}}`,
            authored: "runtime-secret",
          }]);
        });
      },
    ),
    { numRuns: 40 },
  );
});

for (const [name, path] of Object.entries(PATHS)) {
  Deno.test(`provenance property: ${name} text reaches the method verbatim and resolves nothing`, async () => {
    await fc.assert(
      fc.asyncProperty(dataText, async (text) => {
        await withRepo(async (h) => {
          await path(h, text);
          assertEquals(h.executions, [{
            value: text,
            authored: "runtime-secret",
          }]);
        });
      }),
      { numRuns: 40 },
    );
  });
}
