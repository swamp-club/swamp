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
 * Static misuse diagnostics for typed secrets
 * (design/enablers/typed-secrets.md Sections 4.3 item 4 and 10.2): what
 * `swamp behavior validate` reports about an expression before any run,
 * without evaluating it, calling a function or asking a provider.
 *
 * Only an expression with a direct `vault.get` call is examined, since only
 * there is a `Secret` statically known: a record-origin secret is `dyn`. Two
 * checks run on the normalized source. A type check in the check
 * environment, whose error is the secret's when it names the `Secret` type
 * (cel-js names the operand or argument types it found no overload for, so
 * `Secret == string` is the secret's and `string + int` is not), so a type
 * error that has nothing to do with the secret is never reported with a
 * secret code. And the container rule, which refuses `in`, or `==` or `!=`
 * with no scalar-literal or `null` operand, in an expression that reads a
 * secret. Both answer `secret_operation_unsupported`, the code the run
 * refuses with, and each finding names the authored location and the
 * reason, never a value.
 *
 * The pinned cel-js limits hold here as they do at run time: a dyn operand
 * (an unlisted variable, or `dyn(...)`) and a map literal keyed by the
 * result pass the check, `type()` passes, and `has()` on a call result
 * fails the check for its own reason, which names no type, so it is not
 * attributed.
 */

import type { Environment } from "cel-js";
import {
  SECRET_OPERATION_UNSUPPORTED,
  type SecretRefusalCode,
} from "../../domain/expressions/errors.ts";
import {
  analyzeVaultCalls,
  type VaultCallAnalysis,
} from "../../domain/expressions/vault_call_syntax.ts";
import { createSecretCheckEnvironment } from "./cel_evaluator.ts";
import { SECRET_TYPE_NAME } from "./cel_js_secret_refusal_inventory.ts";
import { callLocation } from "./cel_vault_namespace.ts";
import { hasContainerComparison } from "./container_comparison.ts";

/** One statically identified misuse. It carries no value. */
export interface SecretDiagnostic {
  /** The authored path, with the line and column of the first vault.get call. */
  readonly location: string;
  /** The code the run refuses the same misuse with. */
  readonly code: SecretRefusalCode;
  /** What was refused: the type error's own text, or the container rule. */
  readonly reason: string;
}

/** The container rule's reason, as the evaluator words it. */
export const CONTAINER_COMPARISON_REASON =
  "a container comparison (in, or == or != with no scalar literal or null " +
  "operand) in an expression that calls vault.get";

let environment: Environment | undefined;

function checkEnvironment(): Environment {
  return environment ??= createSecretCheckEnvironment();
}

/** The first line of a check error, which names types, never a value. */
function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0];
}

/** Whether a check error is about the `Secret` type. */
const NAMES_SECRET = new RegExp(`\\b${SECRET_TYPE_NAME}\\b`);

/**
 * The static misuse findings for `expression`, authored at `location` (a
 * definition path such as `methods.run.arguments.cmd`). Text that does not
 * parse, holds no direct `vault.get` call, or uses `vault` through an alias
 * yields nothing: the first is the syntax check's to report, the second
 * holds no statically known secret, and the third is refused at run time
 * before anything is checked.
 */
export function diagnoseSecretMisuse(
  expression: string,
  location: string,
): SecretDiagnostic[] {
  let analysis: VaultCallAnalysis;
  try {
    analysis = analyzeVaultCalls(expression);
  } catch {
    return [];
  }
  if (analysis.calls.length === 0 || analysis.invalidUses.length > 0) {
    return [];
  }
  const at = callLocation(
    expression,
    Math.min(...analysis.calls.map((call) => call.start)),
    location,
  );
  const findings: SecretDiagnostic[] = [];
  const checked = checkEnvironment().check(analysis.source.text);
  if (!checked.valid) {
    const reason = firstLine(checked.error);
    if (NAMES_SECRET.test(reason)) {
      findings.push({
        location: at,
        code: SECRET_OPERATION_UNSUPPORTED,
        reason,
      });
    }
  }
  if (hasContainerComparison(analysis.ast)) {
    findings.push({
      location: at,
      code: SECRET_OPERATION_UNSUPPORTED,
      reason: CONTAINER_COMPARISON_REASON,
    });
  }
  return findings;
}
