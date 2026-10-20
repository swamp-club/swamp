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
import { generateConfig as trigger } from "../evals/promptfoo/generate_config.ts";
import { generateConfig as routing } from "../evals/promptfoo/generate_routing_config.ts";
import { generateConfig as sufficiency } from "../evals/promptfoo/generate_sufficiency_config.ts";
import { InputValidationService } from "../src/domain/inputs/input_validation_service.ts";
import type { InputsSchema } from "../src/domain/definitions/definition.ts";
import { CelEvaluator } from "../src/infrastructure/cel/cel_evaluator.ts";
import {
  extractExpressions,
  replaceExpressions,
} from "../src/domain/expressions/expression_parser.ts";

Deno.test("skill evals: all three generators wire both CLI providers with real routing choices", async () => {
  for (const generate of [trigger, routing, sufficiency]) {
    for (const model of ["opus", "gpt-6-astra"]) {
      const result = await generate(["--model", model, "--route", "cli"]);
      const providers = result.providers as Array<
        {
          id: string;
          config: { model: string; toolNames: string[]; tools?: unknown[] };
        }
      >;
      assertEquals(providers.length, 1);
      assertEquals(
        providers[0].id,
        `file://${model === "opus" ? "claude" : "codex"}_cli_provider.mjs`,
      );
      assertEquals(providers[0].config.model, model);
      assertEquals(providers[0].config.toolNames.length > 1, true);
      assertEquals((result.tests as unknown[]).length > 0, true);
      if (model === "gpt-6-astra") {
        assertEquals(
          providers[0].config.tools?.length,
          providers[0].config.toolNames.length,
        );
        assertStringIncludes(
          JSON.stringify(providers[0].config.tools),
          '"description"',
        );
      }
    }
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
      `deno task eval-skill-triggers --route cli --model ${model}`,
    );
  }
});
