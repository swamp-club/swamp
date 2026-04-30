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

/**
 * Minimal CEL evaluator surface needed by domain-side evaluators
 * (expression evaluators, forEach expansion). Defined in the domain
 * so consumers don't need to reach into infrastructure for the type;
 * the infrastructure CelEvaluator implements this structurally.
 *
 * Includes both sync `evaluate` (used for step-name templates and
 * predicates) and async `evaluateAsync` (used for `forEach.in` and
 * any expression that may reach data.* helpers returning Promises).
 * Consumers that only need one of the two are still served by passing
 * the broader implementation — extra methods are harmless under
 * TypeScript's structural typing.
 */
export interface CelExpressionEvaluator {
  evaluate(expression: string, context: Record<string, unknown>): unknown;
  evaluateAsync(
    expression: string,
    context: Record<string, unknown>,
  ): Promise<unknown>;
}
