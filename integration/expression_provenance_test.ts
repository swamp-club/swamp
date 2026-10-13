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

// Position and value provenance (swamp-club#3205). Characterization tests pin
// re-evaluation paths that work today and must keep working; attack tests pin
// that expression text arriving as data never evaluates, even when it matches
// an expression the author wrote.

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { z } from "zod";
import { literalOccurrence } from "../src/domain/expressions/cel_grammar.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { createWorkflowRunDeps } from "../src/serve/deps.ts";
import { collect } from "../src/libswamp/testing.ts";
import {
  consumer,
  oneStepWorkflow,
  readTree,
  runModel,
  runWorkflow,
  saveData,
  TEXT_INPUT,
  withRepo,
  workflowOf,
} from "./expression_provenance_harness.ts";

await initializeLogging({});

// --- Characterization: authored expressions carried as values keep resolving

Deno.test("provenance: model-run input carrying an env reference resolves through inputs", async () => {
  await withRepo(async (h) => {
    await h.repo.definitionRepo.save(
      h.type,
      consumer({ value: "${{ inputs.value }}" }),
    );
    await runModel(h.dir, { value: "${{ env.SECRET }}" });
    await runModel(h.dir, { value: "Bearer ${{ env.SECRET }}" });
    assertEquals(h.executions, [
      { value: "runtime-secret" },
      { value: "Bearer runtime-secret" },
    ]);
  });
});

Deno.test("provenance: computed concatenation of an authored input reference resolves", async () => {
  await withRepo(async (h) => {
    await h.repo.definitionRepo.save(
      h.type,
      consumer({ value: '${{ "Bearer " + inputs.token }}' }),
    );
    await runModel(h.dir, { token: "${{ env.SECRET }}" });
    assertEquals(h.executions, [{ value: "Bearer runtime-secret" }]);
  });
});

Deno.test("provenance: runtime global copied through self.globalArguments resolves", async () => {
  await withRepo(async (h) => {
    await h.repo.definitionRepo.save(
      h.type,
      consumer(
        { value: "${{ self.globalArguments.label }}" },
        { globalArguments: { label: "${{ env.SECRET }}" } },
      ),
    );
    await runModel(h.dir);
    assertEquals(h.executions, [{ value: "runtime-secret" }]);
  });
});

Deno.test("provenance: definition input-schema default carrying an env reference resolves", async () => {
  await withRepo(async (h) => {
    await h.repo.definitionRepo.save(
      h.type,
      Definition.create({
        name: "consumer",
        inputs: {
          type: "object",
          properties: {
            value: { type: "string", default: "${{ env.SECRET }}" },
          },
        },
        methods: { run: { arguments: { value: "${{ inputs.value }}" } } },
      }),
    );
    await runModel(h.dir);
    assertEquals(h.executions, [{ value: "runtime-secret" }]);
  });
});

Deno.test("provenance: workflow step input carrying an env reference resolves in the definition", async () => {
  await withRepo(async (h) => {
    await h.repo.definitionRepo.save(
      h.type,
      consumer({ value: "${{ inputs.value }}" }),
    );
    await runWorkflow(
      h,
      oneStepWorkflow(
        StepTask.modelMethod("consumer", "run", {
          value: "${{ env.SECRET }}",
        }),
      ),
    );
    assertEquals(h.executions, [{ value: "runtime-secret" }]);
  });
});

Deno.test("provenance: workflow input default carrying an env reference resolves", async () => {
  await withRepo(async (h) => {
    await h.repo.definitionRepo.save(
      h.type,
      consumer({ value: "${{ inputs.value }}" }),
    );
    await runWorkflow(
      h,
      oneStepWorkflow(
        StepTask.modelMethod("consumer", "run", {
          value: "${{ inputs.text }}",
        }),
        {
          type: "object",
          properties: {
            text: { type: "string", default: "${{ env.SECRET }}" },
          },
        },
      ),
    );
    assertEquals(h.executions, [{ value: "runtime-secret" }]);
  });
});

Deno.test("provenance: forEach over an authored default list of env references resolves", async () => {
  await withRepo(async (h) => {
    await h.repo.definitionRepo.save(
      h.type,
      consumer({ value: "${{ inputs.value }}" }),
    );
    await runWorkflow(
      h,
      workflowOf("loop-default", [
        Step.create({
          name: "capture-${{ self.item }}",
          forEach: { item: "item", in: "${{ inputs.items }}" },
          task: StepTask.modelMethod("consumer", "run", {
            value: "${{ self.item }}",
          }),
        }),
      ], {
        type: "object",
        properties: {
          items: {
            type: "array",
            default: ["${{ env.SECRET }}"],
          },
        },
      }),
    );
    assertEquals(h.executions, [{ value: "runtime-secret" }]);
  });
});

Deno.test("provenance: direct execution with a step-input env reference resolves", async () => {
  await withRepo(async (h) => {
    await runWorkflow(
      h,
      oneStepWorkflow(
        StepTask.directExecution(h.type.normalized, "direct-model", "run", {
          value: "${{ env.SECRET }}",
          label: "${{ env.OTHER }}",
        }),
      ),
    );
    assertEquals(h.executions, [{ value: "runtime-secret" }]);
  });
});

// --- Attacks: expression text in data never evaluates, even when authored

Deno.test("provenance: a workflow input quoting its own reference stays literal", async () => {
  await withRepo(async (h) => {
    await h.repo.definitionRepo.save(
      h.type,
      consumer({ value: "${{ inputs.value }}" }),
    );
    await runWorkflow(
      h,
      oneStepWorkflow(
        StepTask.modelMethod("consumer", "run", {
          value: "${{ inputs.text }}",
        }),
        { type: "object", properties: { text: { type: "string" } } },
      ),
      { text: "x ${{ inputs.text }} y" },
    );
    assertEquals(h.executions, [{ value: "x ${{ inputs.text }} y" }]);
  });
});

Deno.test("provenance: a workflow input matching an authored env reference stays literal", async () => {
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
          value: "${{ inputs.text }}",
          token: "${{ env.SECRET }}",
        }),
        { type: "object", properties: { text: { type: "string" } } },
      ),
      { text: "leak ${{ env.SECRET }}" },
    );
    assertEquals(h.executions, [{
      value: "leak ${{ env.SECRET }}",
      authored: "runtime-secret",
    }]);
  });
});

Deno.test("provenance: data content matching an authored env reference stays literal", async () => {
  await withRepo(async (h) => {
    await saveData(h, { value: "leak ${{ env.SECRET }}" });
    await h.repo.definitionRepo.save(
      h.type,
      consumer({
        value: '${{ data.latest("producer", "notes").attributes.value }}',
        authored: "${{ env.SECRET }}",
      }),
    );
    await runModel(h.dir);
    assertEquals(h.executions, [{
      value: "leak ${{ env.SECRET }}",
      authored: "runtime-secret",
    }]);
  });
});

Deno.test("provenance: a forEach over caller items matching an authored env reference stays literal", async () => {
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
      workflowOf("loop-caller", [
        Step.create({
          name: "capture-${{ self._index }}",
          forEach: { item: "item", in: "${{ inputs.items }}" },
          task: StepTask.modelMethod("consumer", "run", {
            value: "${{ self.item }}",
            token: "${{ env.SECRET }}",
          }),
        }),
      ], {
        type: "object",
        properties: { items: { type: "array" } },
      }),
      { items: ["${{ env.SECRET }}"] },
    );
    assertEquals(h.executions, [{
      value: "${{ env.SECRET }}",
      authored: "runtime-secret",
    }]);
  });
});

Deno.test("provenance: direct execution never persists data matching an authored reference", async () => {
  await withRepo(async (h) => {
    await runWorkflow(
      h,
      oneStepWorkflow(
        StepTask.directExecution(h.type.normalized, "direct-model", "run", {
          label: "${{ inputs.text }}",
          value: "${{ env.SECRET }}",
        }),
        TEXT_INPUT,
      ),
      { text: "${{ env.SECRET }}" },
      "failed",
    );
    assertEquals(h.executions, []);
    // No stored definition holds the data as a global argument.
    const stored = await readTree(join(h.dir, ".swamp", "auto-definitions"))
      .catch(() => "") + await readTree(join(h.dir, "models")).catch(() => "");
    assertEquals(stored.includes("${{ env.SECRET }}"), false);
  });
});

Deno.test("provenance: literal() output of another system's text reaches a direct step global argument", async () => {
  await withRepo(async (h) => {
    await runWorkflow(
      h,
      oneStepWorkflow(
        StepTask.directExecution(
          h.type.normalized,
          "literal-model",
          "run",
          { value: "v" },
          { label: "sha ${{ literal('${{ github.sha }}') }}" },
        ),
      ),
    );
    assertEquals(h.globals, [{ label: "sha ${{ github.sha }}" }]);
    // Stored as a literal() call of its own, which no later load sees inside.
    const stored = parseYaml(
      await readTree(join(h.dir, ".swamp", "auto-definitions")),
    ) as { globalArguments: Record<string, unknown> };
    assertEquals(stored.globalArguments, {
      label: `sha ${literalOccurrence("${{ github.sha }}")}`,
    });

    // A later run reads the stored text back as authored and resolves nothing.
    await runWorkflow(
      h,
      oneStepWorkflow(StepTask.modelMethod("literal-model", "run", {
        value: "again",
      })),
    );
    assertEquals(h.globals[1], { label: "sha ${{ github.sha }}" });
  });
});

// literal() is the way to pass text on a root swamp does not list, so its
// output must reach a direct step whichever argument holds it.
for (
  const [name, written, received] of [
    ["whole", "${{ literal('${{ parameters.x }}') }}", "${{ parameters.x }}"],
    [
      "mixed",
      "echo ${{ literal('${{ nonexistent.x }}') }} done",
      "echo ${{ nonexistent.x }} done",
    ],
  ] as const
) {
  Deno.test(`provenance: literal() output on an unlisted root reaches a direct step (${name})`, async () => {
    await withRepo(async (h) => {
      await runWorkflow(
        h,
        oneStepWorkflow(
          StepTask.directExecution(
            h.type.normalized,
            "unlisted-model",
            "run",
            { value: written },
            { label: written },
          ),
        ),
      );
      assertEquals(h.executions, [{ value: received }]);
      assertEquals(h.globals, [{ label: received }]);

      // The stored text survives a later load as authored source.
      await runWorkflow(
        h,
        oneStepWorkflow(StepTask.modelMethod("unlisted-model", "run", {
          value: "again",
        })),
      );
      assertEquals(h.globals[1], { label: received });
    });
  });
}

// The text a direct step stores must not vouch for the same literal() output
// in a step input on a later run.
const UNLISTED = "${{ literal('${{ parameters.x }}') }}";
for (
  const [name, inputs, globalArgs, value] of [
    [
      "both whole",
      { value: UNLISTED },
      { label: UNLISTED },
      "${{ parameters.x }}",
    ],
    [
      "input mixed",
      { value: `say ${UNLISTED}` },
      { label: UNLISTED },
      "say ${{ parameters.x }}",
    ],
    [
      "routed from inputs",
      { label: UNLISTED, value: UNLISTED },
      undefined,
      "${{ parameters.x }}",
    ],
  ] as const
) {
  Deno.test(`provenance: a direct step holding the same literal() output twice runs repeatedly (${name})`, async () => {
    await withRepo(async (h) => {
      const workflow = oneStepWorkflow(
        StepTask.directExecution(
          h.type.normalized,
          "repeat-model",
          "run",
          inputs,
          globalArgs,
        ),
      );
      for (let run = 0; run < 3; run++) await runWorkflow(h, workflow);
      assertEquals(h.executions, Array(3).fill({ value }));
      assertEquals(
        h.globals,
        Array(3).fill({ label: "${{ parameters.x }}" }),
      );

      // Another step on the stored definition, by name, with the same text.
      await runWorkflow(
        h,
        oneStepWorkflow(StepTask.modelMethod("repeat-model", "run", {
          value: UNLISTED,
        })),
      );
      assertEquals(h.executions[3], { value: "${{ parameters.x }}" });
    });
  });
}

Deno.test("provenance: text a definition holds that can never evaluate does not vouch for a step input", async () => {
  await withRepo(async (h) => {
    // Hand-authored, not stored by a run.
    await h.repo.definitionRepo.save(
      h.type,
      Definition.create({
        name: "authored-foreign",
        type: h.type.normalized,
        globalArguments: { label: "${{ parameters.x }}" },
      }),
    );
    await runWorkflow(
      h,
      oneStepWorkflow(StepTask.modelMethod("authored-foreign", "run", {
        value: UNLISTED,
      })),
    );
    assertEquals(h.executions, [{ value: "${{ parameters.x }}" }]);

    // The step author's own unlisted root still fails the run, before the
    // step starts: the run reports an error event, which runWorkflow rejects.
    await assertRejects(() =>
      runWorkflow(
        h,
        oneStepWorkflow(StepTask.modelMethod("authored-foreign", "run", {
          value: "${{ parameters.x }}",
        })),
      )
    );
    assertEquals(h.executions.length, 1);
  });
});

Deno.test("provenance: literal() output on an unlisted root reaches a direct step after a deferred prefix", async () => {
  await withRepo(async (h) => {
    await runWorkflow(
      h,
      workflowOf("deferred-literal", [
        Step.create({
          name: "capture",
          forEach: { item: "h", in: '${{ ["a"] }}' },
          task: StepTask.directExecution(
            h.type.normalized,
            "deferred-model",
            "run",
            { value: "${{ self.h + literal('${{ parameters.x }}') }}" },
          ),
        }),
      ]),
    );
    assertEquals(h.executions, [{ value: "a${{ parameters.x }}" }]);
  });
});

Deno.test("provenance: caller data that can never evaluate reaches a direct step global argument", async () => {
  await withRepo(async (h) => {
    await runWorkflow(
      h,
      oneStepWorkflow(
        StepTask.directExecution(
          h.type.normalized,
          "foreign-model",
          "run",
          { value: "v" },
          { label: "${{ inputs.text }}" },
        ),
        TEXT_INPUT,
      ),
      { text: "${{ github.ref == 'refs/heads/main' }}" },
    );
    assertEquals(h.globals, [{
      label: "${{ github.ref == 'refs/heads/main' }}",
    }]);
  });
});

// Text that would evaluate if stored bare, and hyphenated names whose later
// segment is a swamp namespace, reach the method as text on every run.
for (
  const text of [
    "${{ true || github.sha }}",
    "${{ deferredExpressions == [] ? 1 : github.sha }}",
    "${{ toJSON(matrix) }}",
    "${{ needs.build-env.outputs.url }}",
    "${{ matrix.target-file }}",
  ]
) {
  Deno.test(`provenance: a direct step stores literal() output ${text} as text`, async () => {
    await withRepo(async (h) => {
      await runWorkflow(
        h,
        oneStepWorkflow(
          StepTask.directExecution(
            h.type.normalized,
            "stored-model",
            "run",
            { value: "v" },
            { label: `\${{ literal('${text}') }}` },
          ),
        ),
      );
      await runWorkflow(
        h,
        oneStepWorkflow(StepTask.modelMethod("stored-model", "run", {
          value: "again",
        })),
      );
      assertEquals(h.executions.length, 2);
      assertEquals(h.globals, [{ label: text }, { label: text }]);
    });
  });
}

for (
  const text of [
    "${{ inputs.version }}",
    "${{ github.sha || env.SECRET }}",
    // A run reads the hyphen as subtraction, which reads `vault`.
    "${{ needs.build-vault.outputs.url }}",
  ]
) {
  Deno.test(`provenance: direct execution never persists literal() output ${text}`, async () => {
    await withRepo(async (h) => {
      await runWorkflow(
        h,
        oneStepWorkflow(
          StepTask.directExecution(
            h.type.normalized,
            "refused-model",
            "run",
            { value: "v" },
            { label: `\${{ literal('${text}') }}` },
          ),
        ),
        {},
        "failed",
      );
      assertEquals(h.executions, []);
      const stored =
        await readTree(join(h.dir, ".swamp", "auto-definitions")).catch(() =>
          ""
        ) + await readTree(join(h.dir, "models")).catch(() => "");
      assertEquals(stored.includes(text), false);
    });
  });
}

// literal() output is told apart by where it sits, not by its text: the same
// expression written as an expression elsewhere in the workflow vouches for
// nothing it produced.
for (
  const [name, written, workflowInputs, value] of [
    ["env", "${{ env.SECRET }}", undefined, "runtime-secret"],
    ["inputs", "${{ inputs.text }}", TEXT_INPUT, "1"],
  ] as const
) {
  Deno.test(`provenance: literal() output matching an expression written elsewhere stays literal (${name})`, async () => {
    await withRepo(async (h) => {
      const quoted = `\${{ literal('${written}') }}`;
      await runWorkflow(
        h,
        workflowOf("both-places", [
          Step.create({
            name: "written",
            task: StepTask.directExecution(
              h.type.normalized,
              "written-model",
              "run",
              { value: written },
            ),
          }),
          Step.create({
            name: "quoted",
            dependsOn: [{
              step: "written",
              condition: TriggerCondition.succeeded(),
            }],
            task: StepTask.directExecution(
              h.type.normalized,
              "quoted-model",
              "run",
              { authored: quoted },
              { label: quoted },
            ),
          }),
        ], workflowInputs),
        workflowInputs ? { text: value } : {},
        "failed",
      );
      // The written step resolves its own expression; the quoted step is
      // refused before its method runs.
      assertEquals(h.executions, [{ value }]);
      const stored =
        await readTree(join(h.dir, ".swamp", "auto-definitions")).catch(() =>
          ""
        ) + await readTree(join(h.dir, "models")).catch(() => "");
      assertEquals(stored.includes(written), false);
    });
  });

  Deno.test(`provenance: literal() output matching an expression written elsewhere reaches a method argument as text (${name})`, async () => {
    await withRepo(async (h) => {
      await runWorkflow(
        h,
        workflowOf("both-places-input", [
          Step.create({
            name: "written",
            task: StepTask.directExecution(
              h.type.normalized,
              "written-model",
              "run",
              { value: written },
            ),
          }),
          Step.create({
            name: "quoted",
            dependsOn: [{
              step: "written",
              condition: TriggerCondition.succeeded(),
            }],
            task: StepTask.directExecution(
              h.type.normalized,
              "quoted-model",
              "run",
              { authored: `\${{ literal('${written}') }}` },
            ),
          }),
        ], workflowInputs),
        workflowInputs ? { text: value } : {},
      );
      assertEquals(h.executions, [{ value }, { authored: written }]);
    });
  });
}

Deno.test("provenance: a guard holding data matching an authored reference is refused", async () => {
  await withRepo(async (h) => {
    await h.repo.definitionRepo.save(
      h.type,
      consumer({ value: "${{ inputs.value }}" }),
    );
    await runWorkflow(
      h,
      workflowOf("guarded", [
        Step.create({
          name: "capture",
          guard: "${{ inputs.text }}",
          task: StepTask.modelMethod("consumer", "run", {
            value: "${{ inputs.text }}",
            token: "${{ env.SECRET }}",
          }),
        }),
      ], TEXT_INPUT),
      { text: "${{ env.SECRET }}" },
      "failed",
    );
    assertEquals(h.executions, []);
  });
});

Deno.test("provenance: a child workflow keeps parent data matching an authored reference literal", async () => {
  await withRepo(async (h) => {
    await h.repo.definitionRepo.save(
      h.type,
      consumer({
        value: "${{ inputs.value }}",
        authored: "${{ inputs.token }}",
      }),
    );
    await h.repo.workflowRepo.save(
      workflowOf("child-flow", [
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
      workflowOf("parent-flow", [
        Step.create({
          name: "call",
          task: StepTask.workflow("child-flow", {
            text: "${{ inputs.text }}",
          }),
        }),
      ], TEXT_INPUT),
      { text: "leak ${{ env.SECRET }}" },
    );
    assertEquals(h.executions, [{
      value: "leak ${{ env.SECRET }}",
      authored: "runtime-secret",
    }]);
  });
});

// --- --literal-inputs: the caller's inputs are data

Deno.test("provenance: --literal-inputs keeps input expressions literal", async () => {
  await withRepo(async (h) => {
    await h.repo.definitionRepo.save(
      h.type,
      consumer({
        value: "${{ inputs.value }}",
        authored: "${{ env.SECRET }}",
      }),
    );
    await runModel(h.dir, { value: "leak ${{ env.SECRET }}" }, {
      literalInputs: true,
    });
    await runModel(h.dir, { value: "${{ env.SECRET }}" }, {
      literalInputs: true,
    });
    assertEquals(h.executions, [
      { value: "leak ${{ env.SECRET }}", authored: "runtime-secret" },
      { value: "${{ env.SECRET }}", authored: "runtime-secret" },
    ]);
  });
});

Deno.test("provenance: --literal-inputs keeps a method-argument override literal", async () => {
  await withRepo(async (h) => {
    await h.repo.definitionRepo.save(
      h.type,
      Definition.create({
        name: "consumer",
        methods: {
          run: { arguments: { authored: "${{ env.SECRET }}" } },
        },
      }),
    );
    await runModel(h.dir, { value: "${{ env.SECRET }}" }, {
      literalInputs: true,
    });
    assertEquals(h.executions, [
      { value: "${{ env.SECRET }}", authored: "runtime-secret" },
    ]);
  });
});

Deno.test("provenance: --literal-inputs leaves input-schema defaults authored", async () => {
  await withRepo(async (h) => {
    await h.repo.definitionRepo.save(
      h.type,
      Definition.create({
        name: "consumer",
        inputs: {
          type: "object",
          properties: {
            value: { type: "string", default: "${{ env.SECRET }}" },
            token: { type: "string" },
          },
        },
        methods: {
          run: {
            arguments: {
              value: "${{ inputs.value }}",
              authored: "${{ inputs.token }}",
            },
          },
        },
      }),
    );
    await runModel(h.dir, { token: "${{ env.SECRET }}" }, {
      literalInputs: true,
    });
    assertEquals(h.executions, [
      { value: "runtime-secret", authored: "${{ env.SECRET }}" },
    ]);
  });
});

Deno.test("provenance: --literal-inputs refuses --last-evaluated", async () => {
  await withRepo(async (h) => {
    await h.repo.definitionRepo.save(
      h.type,
      consumer({ value: "${{ inputs.value }}" }),
    );
    await runModel(h.dir, { value: "x" }, {
      literalInputs: true,
      lastEvaluated: true,
      expectError: "--literal-inputs cannot be combined with --last-evaluated",
    });
    assertEquals(h.executions, []);
  });
});

Deno.test("provenance: --literal-inputs refuses to persist a global argument holding an expression", async () => {
  await withRepo(async (h) => {
    await runModel(h.dir, { label: "${{ env.SECRET }}", value: "v" }, {
      literalInputs: true,
      typeArg: h.type.normalized,
      definitionName: "direct-literal",
      expectError: "pass the value as a method argument instead",
    });
    await runModel(h.dir, { label: "plain", value: "${{ env.SECRET }}" }, {
      literalInputs: true,
      typeArg: h.type.normalized,
      definitionName: "direct-literal",
    });
    assertEquals(h.executions, [{ value: "${{ env.SECRET }}" }]);
  });
});

// --- Evaluated caches carry provenance, so replay refuses the same text

Deno.test("provenance: --last-evaluated replay keeps data matching an authored reference literal", async () => {
  await withRepo(async (h) => {
    await saveData(h, { value: "leak ${{ env.SECRET }}" });
    await h.repo.definitionRepo.save(
      h.type,
      consumer({
        value: '${{ data.latest("producer", "notes").attributes.value }}',
        authored: "${{ env.SECRET }}",
      }),
    );
    await runModel(h.dir);
    await runModel(h.dir, {}, { lastEvaluated: true });
    assertEquals(h.executions, [
      { value: "leak ${{ env.SECRET }}", authored: "runtime-secret" },
      { value: "leak ${{ env.SECRET }}", authored: "runtime-secret" },
    ]);
  });
});

Deno.test("provenance: workflow --last-evaluated replay keeps input matching an authored reference literal", async () => {
  await withRepo(async (h) => {
    await h.repo.definitionRepo.save(
      h.type,
      consumer({
        value: "${{ inputs.value }}",
        authored: "${{ inputs.token }}",
      }),
    );
    const workflow = oneStepWorkflow(
      StepTask.modelMethod("consumer", "run", {
        value: "${{ inputs.text }}",
        token: "${{ env.SECRET }}",
      }),
      TEXT_INPUT,
    );
    await runWorkflow(h, workflow, { text: "leak ${{ env.SECRET }}" });
    await runWorkflow(
      h,
      workflow,
      { text: "leak ${{ env.SECRET }}" },
      "succeeded",
      true,
    );
    assertEquals(h.executions, [
      { value: "leak ${{ env.SECRET }}", authored: "runtime-secret" },
      { value: "leak ${{ env.SECRET }}", authored: "runtime-secret" },
    ]);
  });
});

Deno.test("provenance: an unreadable provenance record in an evaluated cache is refused", async () => {
  await withRepo(async (h) => {
    await h.repo.definitionRepo.save(
      h.type,
      consumer({ value: "${{ inputs.value }}" }),
    );
    await runModel(h.dir, { value: "x" });
    const dir = join(h.dir, ".swamp", "definitions-evaluated");
    for await (const entry of walkFiles(dir)) {
      const data = parseYaml(await Deno.readTextFile(entry)) as Record<
        string,
        unknown
      >;
      assertEquals(typeof data.provenance, "object");
      data.provenance = "not-a-map";
      await Deno.writeTextFile(entry, stringifyYaml(data));
    }
    await runModel(h.dir, {}, {
      lastEvaluated: true,
      expectError: "unreadable provenance record",
    });
  });
});

async function* walkFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) yield* walkFiles(path);
    else if (entry.isFile) yield path;
  }
}

Deno.test("provenance: a resumed run keeps its recorded input matching an authored reference literal", async () => {
  await withRepo(async (h) => {
    const workflow = oneStepWorkflow(
      StepTask.modelMethod("consumer", "run", {
        value: "${{ inputs.text }}",
        token: "${{ env.SECRET }}",
      }),
      TEXT_INPUT,
    );
    // The model does not exist yet, so the run fails at its only step.
    await runWorkflow(
      h,
      workflow,
      { text: "leak ${{ env.SECRET }}" },
      "failed",
    );
    const run = await h.repo.workflowRunRepo.findLatestByWorkflowId(
      workflow.id,
    );
    assertEquals(run?.inputsProvenance?.isWholeDataAt("text"), true);
    await h.repo.definitionRepo.save(
      h.type,
      consumer({
        value: "${{ inputs.value }}",
        authored: "${{ inputs.token }}",
      }),
    );
    const deps = await createWorkflowRunDeps(h.dir, h.repo, {
      type: "filesystem",
      path: join(h.dir, ".swamp"),
    });
    const service = deps.createExecutionService(
      h.repo.workflowRepo,
      h.repo.workflowRunRepo,
      h.dir,
      h.repo.catalogStore,
    );
    const resumed = await collect(
      service.resume(workflow.name, run!.id, { fromStep: "capture" }),
    );
    assertEquals(resumed.at(-1)?.kind, "completed");
    assertEquals(h.executions, [{
      value: "leak ${{ env.SECRET }}",
      authored: "runtime-secret",
    }]);
  });
});

Deno.test("provenance: an assert message substitutes every occurrence of a deferred expression", async () => {
  await withRepo(async (h) => {
    const workflow = workflowOf("asserting", [
      Step.create({
        name: "check",
        task: StepTask.assert(
          "true",
          "${{ run.workflowName }}/${{ run.workflowName }}",
        ),
      }),
    ]);
    await runWorkflow(h, workflow);
    const run = await h.repo.workflowRunRepo.findLatestByWorkflowId(
      workflow.id,
    );
    const step = run?.jobs[0].steps.find((s) => s.stepName === "check");
    assertEquals(step?.assertResult?.message, "asserting/asserting");
  });
});

Deno.test("provenance: data fragments in adjacent splices cannot join into an authored expression", async () => {
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
          value: "${{ inputs.a }}${{ inputs.b }}",
          token: "${{ env.SECRET }}",
        }),
        {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "string" } },
        },
      ),
      { a: "${{ env.SECRET", b: " }}" },
    );
    assertEquals(h.executions, [{
      value: "${{ env.SECRET }}",
      authored: "runtime-secret",
    }]);
  });
});

Deno.test("provenance: a caller key containing a dot keeps its data mark beside a sibling key", async () => {
  await withRepo(async (h) => {
    await h.repo.definitionRepo.save(
      h.type,
      consumer({
        value: "${{ inputs.value }}",
        authored: "${{ inputs.token }}",
      }),
    );
    const workflow = oneStepWorkflow(
      StepTask.modelMethod("consumer", "run", {
        value: '${{ inputs.cfg["a.b"] }}',
        token: "${{ env.SECRET }}",
      }),
      { type: "object", properties: { cfg: { type: "object" } } },
    );
    await runWorkflow(h, workflow, {
      cfg: { "a.b": "leak ${{ env.SECRET }}", "a": {} },
    });
    assertEquals(h.executions, [{
      value: "leak ${{ env.SECRET }}",
      authored: "runtime-secret",
    }]);
  });
});

for (const item of ["name", "id", "version", "tags", "globalArguments"]) {
  Deno.test(`provenance: a forEach item named ${item} over caller data stays literal`, async () => {
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
        workflowOf(`loop-${item.toLowerCase()}`, [
          Step.create({
            name: "capture-${{ self._index }}",
            forEach: { item, in: "${{ inputs.items }}" },
            task: StepTask.modelMethod("consumer", "run", {
              value: `\${{ self.${item} }}`,
              token: "${{ env.SECRET }}",
            }),
          }),
        ], { type: "object", properties: { items: { type: "array" } } }),
        { items: ["${{ env.SECRET }}"] },
      );
      assertEquals(h.executions, [{
        value: "${{ env.SECRET }}",
        authored: "runtime-secret",
      }]);
    });
  });
}

Deno.test("provenance: --literal-inputs keeps a routed global argument data in direct execution", async () => {
  await withRepo(async (h) => {
    // An existing definition reads the global argument the caller routes.
    await h.repo.definitionRepo.save(
      h.type,
      Definition.create({
        name: "direct-routed",
        methods: {
          run: {
            arguments: {
              value: "${{ self.globalArguments.label }} }}",
              authored: "${{ env.SECRET }}",
            },
          },
        },
      }),
    );
    await runModel(h.dir, { label: "${{ env.SECRET" }, {
      literalInputs: true,
      typeArg: h.type.normalized,
      definitionName: "direct-routed",
    });
    assertEquals(h.executions, [{
      value: "${{ env.SECRET }}",
      authored: "runtime-secret",
    }]);
  });
});

Deno.test("provenance: context.runModel keeps data matching an authored reference literal", async () => {
  await withRepo(async (h) => {
    const callerType = ModelType.create(`test/caller-${crypto.randomUUID()}`);
    modelRegistry.register({
      type: callerType,
      version: "2026.10.12.1",
      methods: {
        run: {
          description: "Invokes the target through context.runModel",
          arguments: z.object({}),
          execute: async (_args, context) => {
            await context.runModel!({ definition: "target", method: "run" });
            return { dataHandles: [] };
          },
        },
      },
    });
    try {
      await saveData(h, { value: "leak ${{ env.SECRET }}" });
      await h.repo.definitionRepo.save(
        h.type,
        Definition.create({
          name: "target",
          methods: {
            run: {
              arguments: {
                value:
                  '${{ data.latest("producer", "notes").attributes.value }}',
                authored: "${{ env.SECRET }}",
              },
            },
          },
        }),
      );
      await h.repo.definitionRepo.save(
        callerType,
        Definition.create({ name: "consumer" }),
      );
      await runModel(h.dir);
      assertEquals(h.executions, [{
        value: "leak ${{ env.SECRET }}",
        authored: "runtime-secret",
      }]);
    } finally {
      modelRegistry.invalidateType(callerType);
    }
  });
});
