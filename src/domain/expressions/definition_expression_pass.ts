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

import type { DefinitionData } from "../definitions/definition.ts";
import type {
  CelExpressionEvaluator,
  CelExpressionValidator,
} from "./cel_runtime.ts";
import { extractDependencies } from "./dependency_extractor.ts";
import { ExpressionError } from "./errors.ts";
import type { ExpressionLocation } from "./expression.ts";
import { replaceExpressions } from "./expression_parser.ts";
import type { ExpressionContext } from "./model_resolver.ts";
import type { FailedExpressions } from "./unresolved_expression_guard.ts";

/** Result of one CEL pass over a definition's data. */
export interface DefinitionExpressionPassResult {
  data: DefinitionData;
  failedExpressions: FailedExpressions;
}

function isGlobalArgumentPath(path: string): boolean {
  return path === "globalArguments" || path.startsWith("globalArguments.") ||
    path.startsWith("globalArguments[");
}

/**
 * Evaluates CEL expressions in a definition's data, shared by the CLI and
 * workflow evaluation paths.
 *
 * Global arguments are evaluated first; everything else is then evaluated
 * with `self.globalArguments` bound to that result, so a method argument that
 * reads `self.globalArguments.X` sees X's value rather than its source text.
 * Global arguments that could not be evaluated keep their raw text there.
 *
 * Evaluation is lenient: an expression that fails, or that reads model data
 * not yet available, is left in place so it cannot break a method that never
 * uses it. Each one is recorded in `failedExpressions` with its reason, for
 * {@link assertMethodArgumentsEvaluated} to raise if the method being run
 * does use it. Text that is not valid CEL (prose documenting the syntax) is
 * left in place without being recorded.
 *
 * @param expressions - Expressions to evaluate. Callers exclude runtime
 *   (vault/env/deferred) expressions and apply their own provenance rules.
 * @param context - Not mutated; the second phase uses a copy.
 */
export async function evaluateDefinitionExpressions(
  definitionData: DefinitionData,
  expressions: readonly ExpressionLocation[],
  context: ExpressionContext,
  celEvaluator: CelExpressionEvaluator & CelExpressionValidator,
): Promise<DefinitionExpressionPassResult> {
  const failedExpressions = new Map<string, Error>();

  const evaluateAll = async (
    batch: readonly ExpressionLocation[],
    ctx: ExpressionContext,
  ): Promise<Map<string, unknown>> => {
    const values = new Map<string, unknown>();
    for (const expr of batch) {
      const missingModel = findMissingModelDependency(expr.celExpression, ctx);
      if (missingModel) {
        failedExpressions.set(
          expr.raw,
          new ExpressionError(
            `Model ${missingModel.modelRef} has no ${missingModel.type} data`,
            expr.celExpression,
            expr.path,
          ),
        );
        continue;
      }
      if (!celEvaluator.validate(expr.celExpression).valid) {
        continue;
      }
      try {
        values.set(
          expr.raw,
          await celEvaluator.evaluateAsync(expr.celExpression, ctx),
        );
      } catch (error) {
        // Most often an input referenced directly (not inside a conditional
        // branch) that only another method supplies — see #653.
        failedExpressions.set(
          expr.raw,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    return values;
  };

  const globalValues = await evaluateAll(
    expressions.filter((expr) => isGlobalArgumentPath(expr.path)),
    context,
  );
  const globalArguments = replaceExpressions(
    definitionData.globalArguments ?? {},
    globalValues,
  ) as Record<string, unknown>;

  const rest = expressions.filter((expr) => !isGlobalArgumentPath(expr.path));
  const restValues = rest.length === 0
    ? new Map<string, unknown>()
    : await evaluateAll(
      rest,
      context.self
        ? { ...context, self: { ...context.self, globalArguments } }
        : context,
    );

  // The same raw text can resolve differently in the two phases
  // (`self.globalArguments.*` does), so each section takes its own values.
  const data = replaceExpressions(definitionData, restValues) as DefinitionData;
  return {
    data: { ...data, globalArguments },
    failedExpressions,
  };
}

/**
 * Model data is never conditionally accessed in CEL — member access on a
 * missing model ref is always an error — so skip evaluation and say why.
 */
function findMissingModelDependency(
  celExpression: string,
  ctx: ExpressionContext,
): { modelRef: string; type: "resource" | "file" } | undefined {
  for (const dep of extractDependencies(celExpression)) {
    if (dep.type !== "resource" && dep.type !== "file") continue;
    const modelData = ctx.model[dep.modelRef];
    if (
      !modelData ||
      (dep.type === "resource" && !modelData.resource) ||
      (dep.type === "file" && !modelData.file)
    ) {
      return { modelRef: dep.modelRef, type: dep.type };
    }
  }
  return undefined;
}
