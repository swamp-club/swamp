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

/**
 * defined in the domain so consumers need not reach into infrastructure for the
 * type; the infrastructure CelEvaluator implements it structurally
 */
export interface CelExpressionEvaluator {
  evaluate(expression: string, context: Record<string, unknown>): unknown;
  evaluateAsync(
    expression: string,
    context: Record<string, unknown>,
  ): Promise<unknown>;
}

/**
 * lets a caller tell ${{ ... }} text that is not CEL at all (prose documenting
 * the syntax) from an expression that failed to evaluate
 */
export interface CelExpressionValidator {
  validate(expression: string): { valid: boolean; error?: string };
}
