// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { getLogger } from "@logtape/logtape";
import type { Job } from "./job.ts";
import type { Step } from "./step.ts";
import type { ExpressionContext } from "../expressions/model_resolver.ts";
import { UserError } from "../errors.ts";

/**
 * Minimal CEL evaluator surface needed by forEach expansion. Includes
 * both sync (for step-name templates) and async (for `forEach.in`,
 * which may call data.* helpers that return Promises).
 *
 * Defined locally to keep this module free of direct infrastructure
 * imports; the infrastructure CelEvaluator implements it structurally.
 */
export interface CelEvaluatorRuntime {
  evaluate(expression: string, context: Record<string, unknown>): unknown;
  evaluateAsync(
    expression: string,
    context: Record<string, unknown>,
  ): Promise<unknown>;
}

/**
 * One concrete step produced by forEach expansion.
 */
export interface ExpandedStep {
  step: Step;
  /** The expanded step name after evaluating expressions. */
  expandedName: string;
  /** The forEach variable name and value bound to this iteration. */
  forEachVar: { name: string; value: unknown };
}

/**
 * Result of resolving a forEach step name template.
 */
export interface ResolvedStepName {
  /** The resolved step name. */
  name: string;
  /** Whether any expression evaluation failed during resolution. */
  hadEvalFailure: boolean;
}

/**
 * Resolves a forEach step name template by evaluating `${{ }}`
 * expressions, or falls back to appending a suffix when no expressions
 * are present.
 *
 * When expression evaluation fails, the raw expression is preserved
 * and the fallbackSuffix is appended to ensure uniqueness across
 * iterations.
 */
export function resolveForEachStepName(
  template: string,
  hasExpression: boolean,
  stepContext: Record<string, unknown>,
  celEvaluator: CelEvaluatorRuntime,
  fallbackSuffix: string,
): ResolvedStepName {
  if (hasExpression) {
    let hadEvalFailure = false;
    const resolved = template.replace(
      /\$\{\{\s*(.+?)\s*\}\}/g,
      (_match, expr) => {
        try {
          return String(
            celEvaluator.evaluate(expr as string, stepContext),
          );
        } catch {
          hadEvalFailure = true;
          return _match as string;
        }
      },
    );
    return {
      name: hadEvalFailure ? `${resolved}-${fallbackSuffix}` : resolved,
      hadEvalFailure,
    };
  }
  return { name: `${template}-${fallbackSuffix}`, hadEvalFailure: false };
}

/**
 * Expands forEach steps in a job into multiple concrete steps.
 *
 * For steps with `forEach`, evaluates the `in` expression and creates
 * one expanded step per item. Pure transformation: takes a job + an
 * expression context, returns the expanded-step map. No I/O, no event
 * emission, no orchestration concerns.
 */
export class ForEachExpansionService {
  constructor(private readonly celEvaluator: CelEvaluatorRuntime) {}

  async expand(
    job: Job,
    context: ExpressionContext,
  ): Promise<Map<string, ExpandedStep[]>> {
    const result = new Map<string, ExpandedStep[]>();

    for (const step of job.steps) {
      if (!step.forEach) {
        // Non-forEach step: single entry that's a no-op for the caller.
        result.set(step.name, [{
          step,
          expandedName: step.name,
          forEachVar: { name: "", value: undefined },
        }]);
        continue;
      }

      const inExpression = step.forEach.in;
      const itemName = step.forEach.item;

      const match = inExpression.match(/\$\{\{\s*(.+?)\s*\}\}/);
      if (!match) {
        throw new UserError(
          `Invalid forEach.in expression: ${inExpression}. Must be in $\{{ }} format.`,
        );
      }

      // Async evaluator so data.* helpers (latest, findByTag, findBySpec,
      // query) that return Promises resolve here before we iterate.
      const items = await this.celEvaluator.evaluateAsync(match[1], context);

      const nameHasExpression = /\$\{\{.+?\}\}/.test(step.name);
      const expandedSteps: ExpandedStep[] = [];

      if (Array.isArray(items)) {
        for (let index = 0; index < items.length; index++) {
          expandedSteps.push(
            this.expandArrayItem(
              step,
              context,
              itemName,
              items[index],
              index,
              nameHasExpression,
            ),
          );
        }
      } else if (items && typeof items === "object") {
        for (const [key, value] of Object.entries(items)) {
          expandedSteps.push(
            this.expandObjectItem(
              step,
              context,
              itemName,
              key,
              value,
              nameHasExpression,
            ),
          );
        }
      } else {
        throw new UserError(
          `forEach.in must evaluate to an array or object, got: ${typeof items}`,
        );
      }

      result.set(step.name, expandedSteps);
    }

    return result;
  }

  private expandArrayItem(
    step: Step,
    context: ExpressionContext,
    itemName: string,
    item: unknown,
    index: number,
    nameHasExpression: boolean,
  ): ExpandedStep {
    const stepContext = {
      ...context,
      self: { ...context.self, [itemName]: item },
    };

    // Fallback-suffix policy: index for objects (for uniqueness when
    // multiple objects share field values) and for the eval-failure
    // path; raw item value for primitives.
    const fallbackSuffix = nameHasExpression
      ? String(index)
      : (item !== null && typeof item === "object")
      ? String(index)
      : String(item);

    if (!nameHasExpression && item !== null && typeof item === "object") {
      getLogger(["swamp", "workflows"]).warn(
        "forEach step '{stepName}' uses index-based naming because item is an object. " +
          "Consider adding a ${{{{ self.{itemName}.<field> }}}} expression to the step name for better observability.",
        { stepName: step.name, itemName },
      );
    }

    const { name: expandedName, hadEvalFailure } = resolveForEachStepName(
      step.name,
      nameHasExpression,
      stepContext,
      this.celEvaluator,
      fallbackSuffix,
    );
    if (hadEvalFailure) {
      getLogger(["swamp", "workflows"]).warn(
        "forEach step '{stepName}' has expression(s) that failed to evaluate for item at index {index}. " +
          "Appending index to prevent duplicate names. " +
          "Check that the expression references valid properties on self.{itemName}.",
        { stepName: step.name, index, itemName },
      );
    }

    return {
      step,
      expandedName,
      forEachVar: { name: itemName, value: item },
    };
  }

  private expandObjectItem(
    step: Step,
    context: ExpressionContext,
    itemName: string,
    key: string,
    value: unknown,
    nameHasExpression: boolean,
  ): ExpandedStep {
    const objItem = { key, value };
    const stepContext = {
      ...context,
      self: { ...context.self, [itemName]: objItem },
    };

    const { name: expandedName, hadEvalFailure } = resolveForEachStepName(
      step.name,
      nameHasExpression,
      stepContext,
      this.celEvaluator,
      key,
    );
    if (hadEvalFailure) {
      getLogger(["swamp", "workflows"]).warn(
        "forEach step '{stepName}' has expression(s) that failed to evaluate for key '{key}'. " +
          "Appending key to prevent duplicate names. " +
          "Check that the expression references valid properties on self.{itemName}.",
        { stepName: step.name, key, itemName },
      );
    }

    return {
      step,
      expandedName,
      forEachVar: { name: itemName, value: objItem },
    };
  }
}
