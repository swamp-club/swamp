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

import { extractExpressions, replaceExpressions } from "./expression_parser.ts";
import { containsRuntimeExpression } from "./expression_evaluation_service.ts";
import { hasStepOutputDependency } from "./dependency_extractor.ts";

/**
 * A synchronous CEL evaluator: evaluates a single CEL expression against a
 * context and returns the resulting value. Both `WorkflowEvaluateDeps.evaluateCel`
 * and `CelEvaluator.evaluate` satisfy this shape.
 */
export type SyncCelEvaluator = (
  expression: string,
  context: Record<string, unknown>,
) => unknown;

/**
 * Resolves every `${{ }}` expression anywhere in `data` that can be evaluated
 * against `context` right now, deferring only the kinds that must be resolved at
 * a later, dedicated stage:
 *
 *   - `vault.*` / `env.*` (via {@link containsRuntimeExpression}) — resolved at
 *     runtime through the secret bag.
 *   - step-output / `data.*` dependencies (via {@link hasStepOutputDependency}) —
 *     resolved at step-execution time, once upstream outputs exist.
 *
 * Everything else is evaluated against `context`. An expression that throws —
 * because it references a binding not yet in `context` (e.g. `run.*` during
 * workflow evaluation) or because it is a bad reference — is left raw. This
 * makes the resolver context-adaptive: the same function resolves `self.*`
 * during forEach expansion and additionally `run.*` and available step outputs
 * at execution time, with no per-call configuration. It is the inverse of the
 * skip-list in `WorkflowExpressionEvaluator.evaluate()` (which defers the same
 * runtime/execution-stage kinds), and the two should stay in sync.
 *
 * This replaces the per-field allowlists that previously lived in
 * `resolveForEachTaskExpressions` (libswamp/workflows/evaluate.ts) and
 * `executeModelMethod` (workflows/execution_service.ts), so no task field can be
 * accidentally omitted from resolution.
 *
 * The input is never mutated. A whole-string single expression keeps the
 * evaluated value's native type; expressions embedded in a larger string are
 * stringified and substituted in place (see {@link replaceExpressions}). A
 * reference that cannot be resolved survives as its literal `${{ }}` text and
 * surfaces later as a clear downstream error (e.g. "workflow not found") rather
 * than as silent data loss.
 */
export function resolveAvailableExpressions(
  data: unknown,
  context: Record<string, unknown>,
  evaluate: SyncCelEvaluator,
): unknown {
  const locations = extractExpressions(data);
  if (locations.length === 0) return data;

  const values = new Map<string, unknown>();
  for (const { raw, celExpression } of locations) {
    if (values.has(raw)) continue;
    // Deferred to runtime (resolved via the secret bag).
    if (containsRuntimeExpression(celExpression)) continue;
    // Deferred to step execution (upstream step outputs / async data.* helpers).
    if (hasStepOutputDependency(celExpression)) continue;
    try {
      values.set(raw, evaluate(celExpression, context));
    } catch {
      // Not resolvable against this context yet (e.g. run.* during evaluation)
      // or a bad reference — leave the expression raw.
    }
  }

  if (values.size === 0) return data;
  return replaceExpressions(data, values);
}
