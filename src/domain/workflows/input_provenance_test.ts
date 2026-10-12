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
import { keyPath } from "../expressions/provenance_map.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { Workflow } from "./workflow.ts";
import type { InputsSchema } from "../definitions/definition.ts";
import {
  vouchInherited,
  workflowInputsProvenance,
} from "./input_provenance.ts";

const T = "${{ env.X }}";

function workflow(
  properties: NonNullable<InputsSchema["properties"]>,
  triggerInputs?: Record<string, unknown>,
): Workflow {
  return Workflow.create({
    name: "w",
    inputs: { type: "object", properties },
    ...(triggerInputs ? { trigger: { inputs: triggerInputs } } : {}),
    jobs: [Job.create({
      name: "main",
      steps: [
        Step.create({ name: "s", task: StepTask.modelMethod("m", "run") }),
      ],
    })],
  });
}

Deno.test("workflowInputsProvenance: a value equal to its default is authored, any other is data", () => {
  const wf = workflow({
    a: { type: "string", default: T },
    b: { type: "string", default: "x" },
  });
  const map = workflowInputsProvenance({ a: T, b: T, c: "plain" }, wf);
  assertEquals(map.hasDataAtOrBelow("a"), false);
  assertEquals(map.isWholeDataAt("b"), true);
  assertEquals(map.isWholeDataAt("c"), true);
});

Deno.test("workflowInputsProvenance: a value equal to a static trigger literal is authored", () => {
  const wf = workflow({ a: { type: "string" } }, { a: T });
  assertEquals(workflowInputsProvenance({ a: T }, wf).isAuthored, true);
});

Deno.test("workflowInputsProvenance: nested defaults are matched property by property", () => {
  const wf = workflow({
    cfg: {
      type: "object",
      properties: { token: { type: "string", default: T } },
    },
  });
  const map = workflowInputsProvenance(
    { cfg: { token: T, note: "caller" } },
    wf,
  );
  assertEquals(map.hasDataAtOrBelow("cfg.token"), false);
  assertEquals(map.isWholeDataAt("cfg.note"), true);
});

Deno.test("workflowInputsProvenance: a key that is not a plain segment is quoted", () => {
  const map = workflowInputsProvenance({ "a.b": T }, workflow({}));
  assertEquals(map.isWholeDataAt(keyPath("", "a.b")), true);
  assertEquals(map.hasDataAtOrBelow("a"), false);
});

Deno.test("vouchInherited: inherited occurrences inside data are authored", () => {
  const inputs = { text: `x ${T} y` };
  const map = vouchInherited(
    workflowInputsProvenance(inputs, workflow({})),
    inputs,
    new Set([T]),
  );
  const start = inputs.text.indexOf(T);
  assertEquals(map.overlapsData("text", start, start + T.length), false);
  assertEquals(map.overlapsData("text", 0, 2), true);
});

Deno.test("workflowInputsProvenance: on a webhook run a trigger template does not vouch for an equal caller value", () => {
  const template = "${{ webhook.body.x }}";
  const wf = workflow({ a: { type: "string" } }, { a: template });
  assertEquals(
    workflowInputsProvenance({ a: template }, wf, { webhook: true })
      .isWholeDataAt("a"),
    true,
  );
  // A scheduled or manual run keeps its static literal authored.
  assertEquals(workflowInputsProvenance({ a: template }, wf).isAuthored, true);
  // A webhook run's expression-free literal is still authored text.
  const plain = workflow({ a: { type: "string" } }, { a: "fixed" });
  assertEquals(
    workflowInputsProvenance({ a: "fixed" }, plain, { webhook: true })
      .isAuthored,
    true,
  );
});
