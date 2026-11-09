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

import {
  analyzeVaultCalls,
  indirectVaultUse,
  type VaultCallAnalysis,
} from "../../domain/expressions/vault_call_syntax.ts";
import {
  checkEnvironment,
  firstLine,
  isTernaryUnification,
  namesSecret,
} from "./secret_diagnostics.ts";

/**
 * cel-js type-checks a whole expression before evaluating it, so a refusal here
 * is one every run of the expression hits. Text that does not parse, indirect
 * vault use and secret refusals are left to the checks that already report them.
 */
export function checkExpressionTypes(expression: string): string | undefined {
  let analysis: VaultCallAnalysis;
  try {
    analysis = analyzeVaultCalls(expression);
  } catch {
    return undefined;
  }
  if (indirectVaultUse(analysis) !== undefined) return undefined;
  const checked = checkEnvironment().check(analysis.source.text);
  if (checked.valid) return undefined;
  const reason = firstLine(checked.error);
  if (namesSecret(reason)) return undefined;
  // a checked vault.get is a Secret but binds as dyn at run time, so a
  // ternary that unifies it with another type still evaluates
  if (analysis.calls.length > 0 && isTernaryUnification(checked.error)) {
    return undefined;
  }
  return reason;
}
