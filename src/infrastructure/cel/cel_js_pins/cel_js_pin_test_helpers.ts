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
 * Shared harness for the cel-js dependency pins (typed-secrets Phase 1.1,
 * design/enablers/typed-secrets.md Section 4.2).
 *
 * The pin tests assert behavior observed in the pinned cel-js release, not
 * behavior swamp wants. A failure after a dependency change means the
 * typed-secrets design must be re-reviewed against the new behavior, not that
 * the test should be bent to pass.
 *
 * Error messages are pinned exactly on purpose: a release that only rewords
 * one still fails, so a human looks at it.
 */

import { assertEquals, assertInstanceOf } from "@std/assert";
import { Environment, type EvaluationError, type ParseError } from "cel-js";
import type { TypeError as CelTypeError } from "cel-js";
import denoConfig from "../../../../deno.json" with { type: "json" };
import { SECRET_OPERATION_UNSUPPORTED } from "../../../domain/expressions/errors.ts";
import { type Fault, runInFaultScope } from "../secret_fault_context.ts";
import { type Secret, vaultReferenceSecret } from "../secret_value.ts";

function pinnedCelJsVersion(): string {
  const specifier = (denoConfig.imports as Record<string, string>)["cel-js"];
  const version = /@(\d+\.\d+\.\d+)$/.exec(specifier ?? "")?.[1];
  if (version === undefined) {
    throw new Error(
      `deno.json must map "cel-js" to an exact npm version, got ${specifier}`,
    );
  }
  return version;
}

/**
 * The cel-js version the pins ran against, read from the deno.json import
 * map so the test names follow the dependency instead of going stale when
 * it is bumped.
 */
const CEL_JS_VERSION: string = pinnedCelJsVersion();

/** Prefix a test name with the pinned library version. */
export function pin(name: string): string {
  return `cel-js ${CEL_JS_VERSION}: ${name}`;
}

/** Stand-in for a secret value: a class whose one field is public. */
export class FixtureSecret {
  constructor(readonly v: string) {}
}

/** A value whose only state is a private field. */
export class PrivateFieldSecret {
  readonly #v: string;
  constructor(v: string) {
    this.#v = v;
  }
  reveal(): string {
    return this.#v;
  }
}

/**
 * An environment configured like the review probes: unlisted variables are
 * dyn, optional syntax is enabled and literals may mix element types.
 */
export function dynEnvironment(): Environment {
  return new Environment({
    unlistedVariablesAreDyn: true,
    enableOptionalTypes: true,
    homogeneousAggregateLiterals: false,
  });
}

type CelErrorClass =
  | typeof EvaluationError
  | typeof ParseError
  | typeof CelTypeError;

/** Assert that `fn` throws the given cel-js error class with `code`. */
export function assertCelError<T extends CelErrorClass>(
  fn: () => unknown,
  errorClass: T,
  code: string,
): InstanceType<T> {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  assertInstanceOf(thrown, errorClass);
  assertEquals(thrown.code, code);
  return thrown as InstanceType<T>;
}

/** Assert that `fn` throws a plain Error (not a cel-js error) with `message`. */
export function assertPlainError(fn: () => unknown, message: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  assertInstanceOf(thrown, Error);
  assertEquals(thrown.constructor, Error);
  assertEquals(thrown.message, message);
}

/**
 * Read the evaluator's internal maybe-async flag from a parsed program.
 * `ast.maybeAsync` is not part of cel-js's typed API; this is the one place
 * the pins read it, so a rename fails here with one clear message.
 */
export function readMaybeAsync(
  program: ReturnType<Environment["parse"]>,
): boolean {
  const flag = (program.ast as unknown as { maybeAsync?: unknown }).maybeAsync;
  if (typeof flag !== "boolean") {
    throw new Error(
      `cel-js internal ast.maybeAsync is no longer a boolean (got ${typeof flag})`,
    );
  }
  return flag;
}

/**
 * The production `Secret` (design Section 3.1) holding one vault reference,
 * written `vault/key`. The typed-secrets pins observe cel-js against what
 * ships, so a dependency upgrade is checked against it.
 */
export function createSecret(reference: string): Secret {
  const [vaultName, key] = reference.split("/");
  return vaultReferenceSecret({ vaultName, key }, "pin");
}

/**
 * Run `fn` inside a fresh fault scope, handing it the scope's live fault
 * list, which it reads after `fn` returns or its promise settles.
 */
export function withFaultContext<T>(fn: (faults: Fault[]) => T): T {
  return runInFaultScope((scope) => fn(scope.faults));
}

/** The fault an operator, function or trap refusal records. */
export function fault(operation: string): Fault {
  return { operation, code: SECRET_OPERATION_UNSUPPORTED };
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
