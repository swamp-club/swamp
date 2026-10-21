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
 * The fault context of one CEL evaluation (design/enablers/typed-secrets.md
 * Section 4.3 items 2 and 5).
 *
 * cel-js absorbs an error a handler or a Proxy trap throws when `||`, `&&`,
 * `exists` or `all` can decide without it, so a refusal that only threw
 * would vanish. Every refusal records a fault here first, and the evaluator
 * fails the evaluation on a recorded fault after cel-js returns. The same
 * scope counts the secrets an evaluation reads, for the container rule.
 *
 * The scope is an `AsyncLocalStorage`, the ambient pattern of
 * `RunVaultAccess`, so a fault recorded after an await lands in the
 * evaluation that caused it.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  SECRET_OPERATION_UNSUPPORTED,
  type SecretRefusalCode,
} from "../../domain/expressions/errors.ts";
import type { SecretReference } from "../../domain/vaults/secret_bag_registry.ts";

/** One refusal, recorded before the refusing code throws. */
export interface Fault {
  /** What was refused: a trap name, a signature or a destination. */
  readonly operation: string;
  readonly code: SecretRefusalCode;
}

/** What one evaluation recorded. */
export interface FaultScope {
  readonly faults: Fault[];
  /** How many times the evaluation read a secret out of a binding. */
  secretsRead: number;
  /** False once evaluation settles: later reads are the boundary's own. */
  recording: boolean;
  /** The first failure of the binding conversion, rethrown afterwards. */
  boundaryFailure?: Error;
  /**
   * Whether the expression holds a container comparison (Section 4.3 item
   * 5). The evaluator sets it once the expression is parsed; the effectful
   * function reads it with `secretsRead` before it starts any work.
   */
  containerComparison: boolean;
  /**
   * The evaluation's boundary release, when it has a run's bag: a `Secret`
   * in a value becomes its sentinel, issued into the bag, and every
   * container is rebuilt plain. The effectful function delivers its inputs
   * through it (Section 4.5 item 3). Undefined with no bag.
   */
  release?: (value: unknown) => unknown;
  /**
   * Every sensitive-field reference a data record adapted in this
   * evaluation holds, keyed by vault and key, selected or not. Recorded
   * whether or not recording is on, because the boundary conversion of a
   * result adapts records too, and the evaluator authorizes each after
   * release (typed-secrets 3.3).
   */
  readonly sensitiveReferences: Map<string, SecretReference>;
}

const ambientScope = new AsyncLocalStorage<FaultScope>();

/**
 * Run `fn` inside a fresh fault scope. The scope is handed to `fn` and is
 * the one the ambient context records into, so a caller reads it after `fn`
 * returns or its promise settles.
 */
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

/** The ambient scope, for a registration that reads what its evaluation recorded. */
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

/**
 * The key {@link FaultScope.sensitiveReferences} holds a reference under,
 * and the key the synchronous authorization step authorizes it by
 * (design/enablers/typed-secrets.md Section 3.4, typed-secrets 4.1).
 */
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

/** The faults recorded so far in the ambient scope, if one was entered. */
export function recordedFaults(): readonly Fault[] | undefined {
  return ambientScope.getStore()?.faults;
}

/** Count a secret the evaluation read, while it is still recording. */
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

/** Record a fault for `operation`, then throw. */
export function refuse(
  operation: string,
  code: SecretRefusalCode = SECRET_OPERATION_UNSUPPORTED,
): never {
  recordFault(operation, code);
  throw new SecretRefusal(operation, code);
}
