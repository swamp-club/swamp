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

import { secretRefusalCode, UnresolvedExpressionError } from "./errors.ts";
import { extractExpressions } from "./expression_parser.ts";

/**
 * definition evaluation is lenient: a failure is left in place so it cannot
 * break a method that never uses the value, and this map carries the reason to
 * where a method is about to run
 */
export type FailedExpressions = ReadonlyMap<string, Error>;

/**
 * only recorded failures count; runtime, deferred and data-origin text passes
 * through. Call after step or --input overrides are applied, so an override
 * replacing a failing value lets the method run.
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
      // Refusals retain their domain code when a lenient pass delays them.
      if (secretRefusalCode(cause) !== undefined) throw cause;
      throw new UnresolvedExpressionError(expr.raw, expr.path, cause);
    }
  }
}
