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

import { assert } from "@std/assert";
import fc from "fast-check";
import { Definition } from "../definitions/definition.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { stepOutputRetentionFor } from "./step_output_retention.ts";
import { Workflow } from "./workflow.ts";

const stepName = fc.stringMatching(/^[a-z][a-z0-9_-]{0,10}$/);

type Place = "input" | "guard" | "assert" | "definition";

const reference = fc.record({
  name: stepName,
  bracket: fc.boolean(),
  place: fc.constantFrom<Place>("input", "guard", "assert", "definition"),
});

function cel(name: string, bracket: boolean): string {
  // a hyphen only reads as one name inside a bracket key
  return bracket || name.includes("-")
    ? `steps['${name}'].outputs.v`
    : `steps.${name}.outputs.v`;
}

Deno.test("stepOutputRetentionFor: for any references in any place, every step named is kept", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(reference, { minLength: 1, maxLength: 6 }),
      async (references) => {
        const globalArguments: Record<string, string> = {};
        const steps = references.map((ref, index) => {
          const text = cel(ref.name, ref.bracket);
          const name = `s${index}`;
          if (ref.place === "definition") {
            globalArguments[`a${index}`] = "${{ " + text + " }}";
          }
          return Step.create({
            name,
            task: ref.place === "assert"
              ? StepTask.assert(text, "checked")
              : StepTask.model(
                "target",
                "run",
                ref.place === "input" ? { v: "${{ " + text + " }}" } : {},
              ),
            ...(ref.place === "guard" ? { guard: "${{ " + text + " }}" } : {}),
          });
        });
        const target = Definition.create({ name: "target", globalArguments });
        const retention = await stepOutputRetentionFor(
          Workflow.create({
            name: "wf",
            jobs: [Job.create({ name: "main", steps })],
          }),
          (idOrName) =>
            Promise.resolve(
              idOrName === "target" || idOrName === target.id ? target : null,
            ),
        );
        for (const ref of references) {
          assert(
            retention.keepsStepOutputs(ref.name),
            `${ref.name} read from ${ref.place} is kept`,
          );
        }
      },
    ),
    { numRuns: 200 },
  );
});
