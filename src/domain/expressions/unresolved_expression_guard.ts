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

import { UnresolvedExpressionError } from "./errors.ts";
import { extractExpressions } from "./expression_parser.ts";

/**
 * Expressions whose evaluation failed during a definition pass, keyed by their
 * raw `${{ ... }}` text. Definition evaluation is lenient — a failure is left
 * in place so it cannot break a method that never uses the value — and this
 * map carries the reason to the point where a method is about to run.
 */
export type FailedExpressions = ReadonlyMap<string, Error>;

/**
 * Fails when the arguments of the method about to run still hold an expression
 * that failed to evaluate. Without this check the raw `${{ ... }}` text would
 * be handed to the method as if it were the value.
 *
 * Only expressions recorded in `failed` count: runtime (vault/env) and
 * deferred references are resolved later, and `${{ ... }}` text that arrived
 * as data content was never evaluated, so all of those pass through.
 *
 * Call it after any step or `--input` overrides are applied, so an override
 * that replaces a failing value lets the method run.
 *
 * @throws UnresolvedExpressionError for the first failed expression found
 */
export function assertMethodArgumentsEvaluated(
  methodName: string,
  methodArgs: Record<string, unknown>,
  failed: FailedExpressions,
): void {
  if (failed.size === 0) return;
  const basePath = `methods.${methodName}.arguments`;
  for (const expr of extractExpressions(methodArgs, basePath)) {
    const cause = failed.get(expr.raw);
    if (cause) {
      throw new UnresolvedExpressionError(expr.raw, expr.path, cause);
    }
  }
}
