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

import type { Definition } from "../definitions/definition.ts";
import { containsExpression } from "../expressions/expression_parser.ts";
import {
  analyzeContentExpressions,
  type ExpressionReferences,
} from "../expressions/expression_references.ts";
import type { Workflow } from "./workflow.ts";

export type RetentionDefinitionFinder = (
  idOrName: string,
) => Promise<Definition | null>;

/**
 * which step outputs and model data maps a run must keep in its expression
 * context: only what some expression it can evaluate names, and everything
 * once any of them reads a computed key or cannot be analysed
 */
export class StepOutputRetention {
  static readonly ALL = new StepOutputRetention(undefined, undefined);

  private constructor(
    private readonly steps: ReadonlySet<string> | undefined,
    private readonly models: ReadonlySet<string> | undefined,
  ) {}

  static of(
    steps: ReadonlySet<string> | undefined,
    models: ReadonlySet<string> | undefined,
  ): StepOutputRetention {
    return new StepOutputRetention(steps, models);
  }

  /** the key the run stores: a forEach's expanded name, a lane's authored one */
  keepsStepOutputs(stepKey: string): boolean {
    return this.steps === undefined || this.steps.has(stepKey);
  }

  /** a model's resource and file maps, by any name or id it is reached by */
  readsModelData(modelRef: string): boolean {
    return this.models === undefined || this.models.has(modelRef);
  }
}

function assertsOf(workflow: Workflow) {
  // a workflow assert's bare predicate is evaluated without the expression marks
  const asserts: { raw: string; celExpression: string; path: string }[] = [];
  workflow.jobs.forEach((job, j) =>
    job.steps.forEach((step, k) => {
      const task = step.task.data;
      if (task.type === "assert") {
        asserts.push({
          raw: task.expr,
          celExpression: task.expr,
          path: `jobs[${j}].steps[${k}].task.expr`,
        });
      }
    })
  );
  return asserts;
}

/**
 * reads the workflow's own expressions and those of every definition its
 * steps run or call through model.method, since a definition's expressions
 * are evaluated in the step's context; another model's definition reaches the
 * context unevaluated, so its text reads nothing
 */
export async function stepOutputRetentionFor(
  workflow: Workflow,
  findDefinition: RetentionDefinitionFinder,
  inherited: Iterable<string> = [],
): Promise<StepOutputRetention> {
  // a parent's expressions passed down in inputs are evaluated in this run
  const references: ExpressionReferences[] = [
    ...analyzeContentExpressions(workflow.toData(), assertsOf(workflow)),
    ...analyzeContentExpressions([...inherited]),
  ].map((analysed) => analysed.references);
  const definitions = new Map<string, Definition | null>();
  const find = async (idOrName: string) => {
    if (!definitions.has(idOrName)) {
      definitions.set(idOrName, await findDefinition(idOrName));
    }
    return definitions.get(idOrName) ?? null;
  };
  const pending = references.flatMap((read) =>
    read.runTargets.map((run) => run.model)
  );
  for (const job of workflow.jobs) {
    for (const step of job.steps) {
      const task = step.task.data;
      if (task.type !== "model_method") continue;
      const target = task.modelIdOrName ?? task.modelName;
      if (target === undefined || containsExpression(target)) {
        return StepOutputRetention.ALL;
      }
      // a direct execution's definition is built from the step's own
      // arguments, which the workflow's expressions already cover
      if (task.modelIdOrName !== undefined) pending.push(target);
    }
  }
  const analysed = new Set<string>();
  while (pending.length > 0) {
    const ref = pending.pop()!;
    if (analysed.has(ref)) continue;
    analysed.add(ref);
    const definition = await find(ref);
    // created by an earlier step, or gone: nothing says what it reads
    if (!definition) return StepOutputRetention.ALL;
    for (
      const { references: read } of analyzeContentExpressions(
        definition.toData(),
      )
    ) {
      references.push(read);
      for (const { model } of read.runTargets) pending.push(model);
    }
  }

  if (references.some((read) => read.stepsWide || read.runsComputed)) {
    return StepOutputRetention.ALL;
  }
  const steps = new Set<string>();
  for (const read of references) {
    for (const name of read.stepTargets) steps.add(name);
  }
  if (references.some((read) => read.dataWide)) {
    return StepOutputRetention.of(steps, undefined);
  }
  const models = new Set<string>();
  for (const read of references) {
    for (const ref of read.syncDataReads.keys()) {
      models.add(ref);
      const definition = await find(ref);
      if (definition) {
        models.add(definition.name);
        models.add(definition.id);
      }
    }
  }
  return StepOutputRetention.of(steps, models);
}
