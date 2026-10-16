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
 * The `Secret` test fixture for the typed-secrets Phase 1.2 pins
 * (design/enablers/typed-secrets.md Section 3.1 and Section 4.3). It has the
 * shape the design specifies, so the pins observe cel-js 7.6.1 against the
 * real thing rather than a stand-in:
 *
 * - Each instance is a Proxy over one frozen, empty `Secret` object. Its state
 *   lives in a module-private WeakMap keyed by the proxy, so nothing can read
 *   it through the object.
 * - `ownKeys` and `getOwnPropertyDescriptor` throw. The `get` trap answers
 *   `constructor`, returns throwing functions for `toString`, `toJSON`,
 *   `valueOf` and `Symbol.toPrimitive`, and answers `undefined` for every other
 *   key, `then` included.
 * - Every trap and function that throws records a fault first, in the
 *   evaluation's ambient fault context.
 *
 * The fault context is an `AsyncLocalStorage`, the same ambient pattern as
 * `RunVaultAccess` and the expression rejection report, so a fault recorded
 * after an await lands in the evaluation that caused it.
 *
 * This is a test fixture, not production code. Nothing outside this directory
 * imports it, and its name follows the directory's `_test_helpers` convention
 * so the affected-commands rules read it as test support. Compare two secrets
 * with `assertStrictEquals` or {@link secretState}: `assertEquals` between two
 * different references walks their keys and trips the `ownKeys` trap.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Environment } from "cel-js";
import {
  functionRefusalSignatures,
  operatorRefusalSignatures,
  SECRET_TYPE_NAME,
  secretCapableBuiltins,
  SWAMP_FUNCTION_SIGNATURES,
} from "./cel_js_secret_refusal_inventory.ts";

/** One refusal, recorded before the refusing code throws. */
export interface Fault {
  /** What was refused: a trap name, a function name or a signature. */
  readonly operation: string;
}

const ambientFaults = new AsyncLocalStorage<Fault[]>();

/**
 * Run `fn` inside a fresh fault context. The list is handed to `fn` and is
 * the same list the ambient context records into, so a caller keeps a
 * reference and reads it after `fn` returns or its promise settles.
 */
export function withFaultContext<T>(fn: (faults: Fault[]) => T): T {
  const faults: Fault[] = [];
  return ambientFaults.run(faults, () => fn(faults));
}

/**
 * Record a fault in the ambient context. Returns whether a context was
 * entered: outside one the fault is dropped, which is the negative the pins
 * observe.
 */
export function recordFault(operation: string): boolean {
  const faults = ambientFaults.getStore();
  if (faults === undefined) return false;
  faults.push({ operation });
  return true;
}

/** The faults recorded so far in the ambient context, if one was entered. */
export function recordedFaults(): readonly Fault[] | undefined {
  return ambientFaults.getStore();
}

/** Thrown by every refusing trap, function and overload of the fixture. */
export class SecretRefusedError extends Error {
  override readonly name = "SecretRefusedError";
  constructor(readonly operation: string) {
    super(`Secret refuses ${operation}`);
  }
}

/** Record a fault for `operation`, then throw. */
export function refuse(operation: string): never {
  recordFault(operation);
  throw new SecretRefusedError(operation);
}

/**
 * The registered constructor. cel-js decides a value's type by exact
 * constructor identity, and the proxy's `get` trap answers `constructor` with
 * this class. Instances come only from {@link createSecret}.
 */
export class Secret {}

/** A part of a composed secret: text, or a reference to a stored value. */
export type SecretPart = string | { readonly reference: string };

/** What a `Secret` holds, kept out of reach of the object itself. */
export interface SecretState {
  readonly parts: readonly SecretPart[];
}

const states = new WeakMap<object, SecretState>();
const TARGET: Secret = Object.freeze(new Secret());
const THROWING_KEYS: ReadonlySet<PropertyKey> = new Set<PropertyKey>([
  "toString",
  "toJSON",
  "valueOf",
  Symbol.toPrimitive,
]);

const handler: ProxyHandler<Secret> = {
  ownKeys() {
    return refuse("ownKeys");
  },
  getOwnPropertyDescriptor() {
    return refuse("getOwnPropertyDescriptor");
  },
  get(_target, key) {
    if (key === "constructor") return Secret;
    if (THROWING_KEYS.has(key)) return () => refuse(String(key));
    return undefined;
  },
};

function createFromParts(parts: readonly SecretPart[]): Secret {
  const proxy = new Proxy(TARGET, handler);
  states.set(proxy, { parts });
  return proxy;
}

/** A `Secret` holding one vault reference. */
export function createSecret(reference: string): Secret {
  return createFromParts([{ reference }]);
}

/** The state behind a `Secret`, or undefined for any other value. */
export function secretState(value: unknown): SecretState | undefined {
  return typeof value === "object" && value !== null
    ? states.get(value)
    : undefined;
}

function partsOf(value: Secret | string): readonly SecretPart[] {
  if (typeof value === "string") return [value];
  const state = secretState(value);
  if (state === undefined) throw new Error("not a Secret");
  return state.parts;
}

/**
 * Register the allowed set (Section 4.1) on `env`: concatenation composes a
 * new `Secret`, and comparison with `null` answers `false`, so `!=` answers
 * `true`. Everything else is a refusal.
 */
export function registerAllowedSet(env: Environment): Environment {
  const compose = (a: Secret | string, b: Secret | string) =>
    createFromParts([...partsOf(a), ...partsOf(b)]);
  return env
    .registerOperator("Secret + string: Secret", compose)
    .registerOperator("string + Secret: Secret", compose)
    .registerOperator("Secret + Secret: Secret", compose)
    .registerOperator("Secret == null", () => false);
}

/** The options the review probes and the internal environment use. */
export function secretEnvironmentOptions(): ConstructorParameters<
  typeof Environment
>[0] {
  return {
    unlistedVariablesAreDyn: true,
    enableOptionalTypes: true,
    homogeneousAggregateLiterals: false,
  };
}

/** Register the `Secret` type on `env` the way the design does. */
export function registerSecretType(env: Environment): Environment {
  return env.registerType(SECRET_TYPE_NAME, { ctor: Secret, fields: {} });
}

export interface RefusalRegistration {
  readonly operators: readonly string[];
  readonly functions: readonly string[];
}

/**
 * Register every refusal the inventory yields on `env`: the operator
 * refusals (with `customTypes` added to the equality list), the cross product
 * over the secret-capable cel-js built-ins read from `env`, and, with
 * `swamp: true`, the cross product over swamp's own registrations, which
 * needs the namespace types registered first. A swamp signature `env`
 * already carries (a stub, say) is never treated as a built-in, so nothing
 * is registered twice. Every handler is synchronous, functions use
 * `{ async: false }`, and each records a fault and throws. Returns what was
 * registered, so a pin can count it.
 */
export function registerSecretRefusals(
  env: Environment,
  options: {
    readonly customTypes?: readonly string[];
    readonly swamp?: boolean;
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
    ...(options.swamp
      ? functionRefusalSignatures(SWAMP_FUNCTION_SIGNATURES)
      : []),
  ].sort();
  for (const signature of functions) {
    env.registerFunction(signature, () => refuse(signature), { async: false });
  }
  return { operators, functions };
}

/**
 * A plain object whose every property is an enumerable getter that pushes
 * `<label>.<key>` to `reads` before answering, so a pin can see which values
 * cel-js read. The container rule relies on this read being observable.
 */
export function recordingObject<T extends Record<string, unknown>>(
  label: string,
  entries: T,
  reads: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) {
    Object.defineProperty(out, key, {
      enumerable: true,
      get() {
        reads.push(`${label}.${key}`);
        return value;
      },
    });
  }
  return out;
}

/** An array whose every element is an enumerable getter, like above. */
export function recordingList(
  label: string,
  items: readonly unknown[],
  reads: string[],
): unknown[] {
  const out: unknown[] = [];
  items.forEach((value, index) => {
    Object.defineProperty(out, index, {
      enumerable: true,
      get() {
        reads.push(`${label}[${index}]`);
        return value;
      },
    });
  });
  out.length = items.length;
  return out;
}
