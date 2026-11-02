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
 * every function is registered with async: false so synchronous entry points
 * stay synchronous, and every refusal records a fault before it throws so ||,
 * &&, exists and all cannot absorb it
 */

import type { Environment } from "cel-js";
import {
  functionRefusalSignatures,
  operatorRefusalSignatures,
  SECRET_TYPE_NAME,
  secretCapableBuiltins,
  SWAMP_FUNCTION_SIGNATURES,
} from "./cel_js_secret_refusal_inventory.ts";
import type { SecretRefusalCode } from "../../domain/expressions/errors.ts";
import { refuse } from "./secret_fault_context.ts";
import { composeSecrets, Secret } from "./secret_value.ts";

/** Register the `Secret` type: no field is exposed to selection or `has()`. */
export function registerSecretType(env: Environment): Environment {
  return env.registerType(SECRET_TYPE_NAME, { ctor: Secret, fields: {} });
}

/**
 * concatenation composes a new Secret; comparison with null answers false;
 * cel-js derives != and the mirrored operand order of ==
 */
export function registerAllowedSet(env: Environment): Environment {
  return env
    .registerOperator("Secret + string: Secret", composeSecrets)
    .registerOperator("string + Secret: Secret", composeSecrets)
    .registerOperator("Secret + Secret: Secret", composeSecrets)
    .registerOperator("Secret == null", () => false);
}

export interface RefusalRegistration {
  readonly operators: readonly string[];
  readonly functions: readonly string[];
}

/**
 * a swamp signature env already carries is never treated as a built-in, so
 * nothing is registered twice
 */
export function registerSecretRefusals(
  env: Environment,
  options: {
    readonly customTypes?: readonly string[];
    readonly swampSignatures?: readonly string[];
    /**
     * defaults to secret_operation_unsupported; a routing argument such as the
     * model and method names of model.method records secret_destination_refused
     */
    readonly codeFor?: (signature: string) => SecretRefusalCode | undefined;
  } = {},
): RefusalRegistration {
  const operators = operatorRefusalSignatures(options.customTypes ?? []);
  for (const signature of operators) {
    env.registerOperator(signature, () => refuse(signature));
  }
  const swamp = new Set(SWAMP_FUNCTION_SIGNATURES);
  const builtins = secretCapableBuiltins(env)
    .map((fn) => fn.signature)
    .filter((signature) => !swamp.has(signature));
  const functions = [
    ...functionRefusalSignatures(builtins),
    ...functionRefusalSignatures(options.swampSignatures ?? []),
  ].sort();
  for (const signature of functions) {
    const code = options.codeFor?.(signature);
    env.registerFunction(signature, () => refuse(signature, code), {
      async: false,
    });
  }
  return { operators, functions };
}
