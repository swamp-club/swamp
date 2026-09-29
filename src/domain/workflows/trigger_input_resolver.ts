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

import type { ExpressionContext } from "../expressions/model_resolver.ts";
import type { CelExpressionEvaluator } from "../expressions/cel_runtime.ts";
import {
  matchSingleExpression,
  scanExpressions,
} from "../expressions/expression_scanner.ts";

/**
 * Resolves a trigger's `inputs` value map by evaluating its CEL expressions
 * against an {@link ExpressionContext}. Used for webhook-triggered runs where
 * `trigger.inputs` maps fields of the request payload onto workflow inputs,
 * e.g. `identifier: "${{ webhook.body.data.issue.identifier }}"`.
 *
 * A value that is exactly a single `${{ ... }}` expression resolves to the
 * evaluated result with its native type preserved (object, number, boolean).
 * Expressions embedded in a larger string are interpolated and stringified.
 * Nested objects and arrays are resolved recursively; non-expression values
 * (the static literals scheduled runs rely on) pass through unchanged.
 *
 * **Strict**: a CEL evaluation error propagates, surfacing a misconfigured
 * mapping to the caller rather than silently dropping the input. Optional
 * payload fields should be guarded with `??` in the expression itself.
 */
export class TriggerInputResolver {
  constructor(private readonly celEvaluator: CelExpressionEvaluator) {}

  async resolve(
    triggerInputs: Record<string, unknown>,
    context: ExpressionContext,
  ): Promise<Record<string, unknown>> {
    const resolved = await this.resolveValue(triggerInputs, context);
    return resolved as Record<string, unknown>;
  }

  private async resolveValue(
    value: unknown,
    context: ExpressionContext,
  ): Promise<unknown> {
    if (typeof value === "string") {
      return await this.resolveString(value, context);
    }
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const item of value) {
        out.push(await this.resolveValue(item, context));
      }
      return out;
    }
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = Object.create(null);
      for (const [key, item] of Object.entries(value)) {
        Object.defineProperty(out, key, {
          value: await this.resolveValue(item, context),
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      return out;
    }
    return value;
  }

  private async resolveString(
    value: string,
    context: ExpressionContext,
  ): Promise<unknown> {
    const whole = matchSingleExpression(value);
    if (whole) {
      return await this.celEvaluator.evaluateAsync(whole.inner, context);
    }

    const spans = scanExpressions(value);
    if (spans.length === 0) {
      return value;
    }

    // Replace by position, so text inside one expression's string literal
    // that looks like another expression is left alone.
    let result = "";
    let last = 0;
    for (const span of spans) {
      const evaluated = await this.celEvaluator.evaluateAsync(
        span.inner,
        context,
      );
      result += value.slice(last, span.start) + String(evaluated);
      last = span.end;
    }
    return result + value.slice(last);
  }
}
