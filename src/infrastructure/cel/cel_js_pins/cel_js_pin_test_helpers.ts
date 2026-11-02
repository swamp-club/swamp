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
 * pin tests assert behavior observed in the pinned cel-js release; a failure
 * after a dependency change means the design needs re-review, not the test
 * bent. Messages are pinned exactly so rewording is noticed
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

/** read from the deno.json import map so test names follow the dependency */
const CEL_JS_VERSION: string = pinnedCelJsVersion();

export function pin(name: string): string {
  return `cel-js ${CEL_JS_VERSION}: ${name}`;
}

export class FixtureSecret {
  constructor(readonly v: string) {}
}

export class PrivateFieldSecret {
  readonly #v: string;
  constructor(v: string) {
    this.#v = v;
  }
  reveal(): string {
    return this.#v;
  }
}

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
 * ast.maybeAsync is not part of cel-js's typed API; the pins read it only here,
 * so a rename fails with one clear message
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

/** the production Secret, so a dependency upgrade is checked against what ships */
export function createSecret(reference: string): Secret {
  const [vaultName, key] = reference.split("/");
  return vaultReferenceSecret({ vaultName, key }, "pin");
}

export function withFaultContext<T>(fn: (faults: Fault[]) => T): T {
  return runInFaultScope((scope) => fn(scope.faults));
}

export function fault(operation: string): Fault {
  return { operation, code: SECRET_OPERATION_UNSUPPORTED };
}

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
 * every property is an enumerable getter that records its read, so a pin can
 * see which values cel-js read; the container rule relies on this read being
 * observable
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
