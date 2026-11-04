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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { parse as parseYaml } from "@std/yaml";
import { join } from "@std/path";
import { ROOT } from "./arch_fitness_helpers.ts";
import { InputValidationService } from "../src/domain/inputs/input_validation_service.ts";
import type { InputsSchema } from "../src/domain/definitions/definition.ts";
import { CelEvaluator } from "../src/infrastructure/cel/cel_evaluator.ts";
import {
  extractExpressions,
  replaceExpressions,
} from "../src/domain/expressions/expression_parser.ts";

Deno.test("skill evals: every run builds through the one build script", async () => {
  const deno = JSON.parse(await Deno.readTextFile(join(ROOT, "deno.json"))) as {
    tasks: Record<string, string>;
  };
  assertEquals(deno.tasks["build-eval-tool"], "sh tools/swamp-eval/build.sh");
  assertEquals(
    deno.tasks["eval-skill-triggers"],
    "sh tools/swamp-eval/build.sh && ./.bin/swamp-eval run",
  );
  const workflow = await Deno.readTextFile(
    join(ROOT, "verification/workflow-verify-skills.yaml"),
  );
  assertStringIncludes(workflow, 'run: "sh tools/swamp-eval/build.sh"');
});

Deno.test("verify-skills: an evaluator or toolchain change re-runs the skill checks", async () => {
  const workflow = await Deno.readTextFile(
    join(ROOT, "verification/workflow-verify-skills.yaml"),
  );
  const guards = [...workflow.matchAll(/guard: "(.*)"/g)].map((m) => m[1]);
  assertEquals(guards.length, 3);
  for (const guard of guards) {
    assertStringIncludes(guard, "f.startsWith('tools/swamp-eval/')");
    assertStringIncludes(guard, "f == '.tool-versions'");
  }
});

Deno.test("verify-skills: defaults to Claude and selects Codex only by input", async () => {
  const workflow = parseYaml(
    await Deno.readTextFile(
      join(ROOT, "verification/workflow-verify-skills.yaml"),
    ),
  ) as {
    inputs: InputsSchema;
    jobs: Array<
      { steps: Array<{ name: string; task: { inputs: { run: string } } }> }
    >;
  };
  const validation = new InputValidationService();
  const defaults = validation.applyDefaults(
    { commit: "abc", branch: "branch" },
    workflow.inputs,
  );
  assertEquals(defaults.reviewer, "claude");
  assertEquals(
    validation.validate({ ...defaults, reviewer: "other" }, workflow.inputs)
      .valid,
    false,
  );
  const step = workflow.jobs.flatMap((job) => job.steps).find((step) =>
    step.name === "skill-trigger-eval"
  )!;
  const evaluator = new CelEvaluator();
  for (
    const [reviewer, model] of [[defaults.reviewer, "opus"], [
      "codex",
      "gpt-6-astra",
    ]]
  ) {
    const run = step.task.inputs.run;
    const values = new Map(
      extractExpressions(run).map((
        e,
      ) => [
        e.raw,
        evaluator.evaluate(e.celExpression, {
          inputs: { ...defaults, reviewer },
        }),
      ]),
    );
    assertEquals(
      replaceExpressions(run, values),
      `./.bin/swamp-eval run --route cli --model ${model}`,
    );
  }
});
