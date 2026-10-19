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
 * What an environment registers for the `Secret` value
 * (design/enablers/typed-secrets.md Sections 4.1 and 4.3): the type, the
 * allowed set, and every refusal the inventory
 * (`cel_js_secret_refusal_inventory.ts`) yields.
 *
 * Every handler is synchronous and every function is registered with
 * `{ async: false }`, so synchronous entry points stay synchronous (fact 4),
 * and every refusal records a fault before it throws, so `||`, `&&`,
 * `exists` and `all` cannot absorb it (fact 3).
 */

import type { Environment } from "cel-js";
import {
  functionRefusalSignatures,
  operatorRefusalSignatures,
  SECRET_TYPE_NAME,
  secretCapableBuiltins,
  SWAMP_FUNCTION_SIGNATURES,
} from "./cel_js_secret_refusal_inventory.ts";
import { refuse } from "./secret_fault_context.ts";
import { composeSecrets, Secret } from "./secret_value.ts";

/** Register the `Secret` type: no field is exposed to selection or `has()`. */
export function registerSecretType(env: Environment): Environment {
  return env.registerType(SECRET_TYPE_NAME, { ctor: Secret, fields: {} });
}

/**
 * Register the allowed set's operators: concatenation composes a new
 * `Secret`, and comparison with `null` answers `false`, so `!=` answers
 * `true`. cel-js derives `!=` and the mirrored operand order of `==`.
 */
export function registerAllowedSet(env: Environment): Environment {
  return env
    .registerOperator("Secret + string: Secret", composeSecrets)
    .registerOperator("string + Secret: Secret", composeSecrets)
    .registerOperator("Secret + Secret: Secret", composeSecrets)
    .registerOperator("Secret == null", () => false);
}

/** The refusals one environment registered. */
export interface RefusalRegistration {
  readonly operators: readonly string[];
  readonly functions: readonly string[];
}

/**
 * Register every refusal the inventory yields on `env`: the operator
 * refusals with `customTypes` added to the operand types, the cross product
 * over the secret-capable cel-js built-ins read from `env`, and the cross
 * product over `swampSignatures`, swamp's registrations on `env`. A swamp
 * signature `env` already carries is never treated as a built-in, so nothing
 * is registered twice. Returns what was registered.
 */
export function registerSecretRefusals(
  env: Environment,
  options: {
    readonly customTypes?: readonly string[];
    readonly swampSignatures?: readonly string[];
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
    env.registerFunction(signature, () => refuse(signature), { async: false });
  }
  return { operators, functions };
}
