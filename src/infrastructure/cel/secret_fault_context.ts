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
 * cel-js absorbs an error a handler or trap throws when ||, &&, exists or all
 * can decide without it, so every refusal records a fault first and the
 * evaluator fails on a recorded fault after cel-js returns
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  SECRET_OPERATION_UNSUPPORTED,
  type SecretRefusalCode,
} from "../../domain/expressions/errors.ts";
import type { SecretReference } from "../../domain/vaults/secret_bag_registry.ts";

export interface Fault {
  readonly operation: string;
  readonly code: SecretRefusalCode;
}

export interface FaultScope {
  readonly faults: Fault[];
  secretsRead: number;
  /** False once evaluation settles: later reads are the boundary's own. */
  recording: boolean;
  boundaryFailure?: Error;
  /**
   * the evaluator sets it once the expression is parsed; the effectful function
   * reads it with secretsRead before starting any work
   */
  containerComparison: boolean;
  /**
   * the effectful function delivers its inputs through it; undefined with no
   * bag
   */
  release?: (value: unknown) => unknown;
  /**
   * recorded whether or not recording is on, because the boundary conversion of
   * a result adapts records too, and the evaluator authorizes each after
   * release
   */
  readonly sensitiveReferences: Map<string, SecretReference>;
}

const ambientScope = new AsyncLocalStorage<FaultScope>();

export function runInFaultScope<T>(fn: (scope: FaultScope) => T): T {
  const scope: FaultScope = {
    faults: [],
    secretsRead: 0,
    recording: true,
    containerComparison: false,
    sensitiveReferences: new Map(),
  };
  return ambientScope.run(scope, () => fn(scope));
}

export function currentFaultScope(): FaultScope | undefined {
  return ambientScope.getStore();
}

/**
 * Record a sensitive-field reference a data record holds, for authorization
 * after evaluation. Outside a scope nothing would authorize it, so the read
 * fails closed instead of being dropped.
 */
export function recordSensitiveReference(reference: SecretReference): void {
  const scope = ambientScope.getStore();
  if (scope === undefined) {
    throw new Error(
      "A sensitive-field reference was read outside an expression evaluation",
    );
  }
  scope.sensitiveReferences.set(sensitiveReferenceKey(reference), reference);
}

export function sensitiveReferenceKey(reference: SecretReference): string {
  return `${reference.vaultName}\u0000${reference.key}`;
}

/**
 * Record a fault in the ambient scope. Returns whether a scope was entered:
 * outside one the fault is dropped, and the refusal still throws.
 */
export function recordFault(
  operation: string,
  code: SecretRefusalCode = SECRET_OPERATION_UNSUPPORTED,
): boolean {
  const scope = ambientScope.getStore();
  if (scope === undefined) return false;
  scope.faults.push({ operation, code });
  return true;
}

export function recordedFaults(): readonly Fault[] | undefined {
  return ambientScope.getStore()?.faults;
}

export function recordSecretRead(): void {
  const scope = ambientScope.getStore();
  if (scope?.recording) scope.secretsRead++;
}

/**
 * Keep the first failure of the binding conversion. A getter's error can be
 * absorbed like a handler's, so the evaluator rethrows it afterwards.
 */
export function recordBoundaryFailure(error: Error): void {
  const scope = ambientScope.getStore();
  if (scope !== undefined) scope.boundaryFailure ??= error;
}

/**
 * Thrown inside an evaluation by every refusing trap, overload and
 * destination. It names the operation and the code, never a value. The
 * evaluator replaces it with a `SecretRefusedError` naming the expression.
 */
export class SecretRefusal extends Error {
  override readonly name = "SecretRefusal";
  constructor(
    readonly operation: string,
    readonly code: SecretRefusalCode,
  ) {
    super(`A secret refuses ${operation} (${code})`);
  }
}

export function refuse(
  operation: string,
  code: SecretRefusalCode = SECRET_OPERATION_UNSUPPORTED,
): never {
  recordFault(operation, code);
  throw new SecretRefusal(operation, code);
}
