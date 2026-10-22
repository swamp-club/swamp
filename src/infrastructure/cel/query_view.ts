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
 * The expression-facing query view (design/enablers/typed-secrets.md
 * Section 6.2, typed-secrets 4.3): the CEL adapter's implementation of the
 * {@link QueryView} port the query service declares. The typed `data.query`
 * handlers build one per call from the data namespace's own namespace, so
 * one identity decides the own-namespace check for the rows a predicate
 * reads and for the records the handler adapts afterwards.
 *
 * - The environment is the service's base with the `Secret` type, the
 *   allowed set and every refusal the inventory yields, `latestRun`, `model`
 *   and `behavior` included, built once per base.
 * - A record is viewed through the accessor adapter, so its tagged fields
 *   are data-origin Secrets before a predicate or projection reads them.
 * - A predicate runs in a row-local fault scope. Its refusals, absorbed or
 *   not, propagate to the calling evaluation as the port's
 *   `QueryViewRefusal` (the evaluation answers with the recorded fault) and
 *   fail the query; the
 *   container rule of Section 4.3 item 5 is applied to the predicate
 *   itself, since the calling evaluation scans only its own AST; and the
 *   row's secret reads and sensitive references stay with the row, because
 *   a predicate's Secrets never enter the calling expression and an
 *   unmatched row issues nothing. A record the query answers is adapted
 *   again in the calling scope, by the typed handler or by the projection,
 *   so everything the expression receives is recorded and authorized.
 * - A projection runs in the calling scope, since its result enters the
 *   calling expression. Its value is coerced with each `Secret` and each
 *   adapted view kept by identity, never cloned and never walked, so
 *   selecting a tagged field trips no trap.
 */

import type { NamespaceReader } from "../../domain/data/namespace.ts";
import type { ASTNode as CelAstNode, Environment } from "cel-js";
import type { DataRecord } from "../../domain/data/data_record.ts";
import {
  type QueryProgram,
  type QueryView,
  QueryViewRefusal,
} from "../../domain/data/query_view.ts";
import { SECRET_OPERATION_UNSUPPORTED } from "../../domain/expressions/errors.ts";
import { coerceBigInts } from "./cel_coercion.ts";
import { QUERY_VIEW_FUNCTION_SIGNATURES } from "./cel_js_secret_refusal_inventory.ts";
import { hasContainerComparison } from "./container_comparison.ts";
import {
  currentFaultScope,
  type Fault,
  type FaultScope,
  recordFault,
  runInFaultScope,
} from "./secret_fault_context.ts";
import {
  registerAllowedSet,
  registerSecretRefusals,
  registerSecretType,
} from "./secret_registrations.ts";
import { isSecret } from "./secret_value.ts";
import { adaptDataRecord, isAdaptedView } from "./sensitive_record_adapter.ts";

/** The view environment of each base, built once and collected with it. */
const environments = new WeakMap<Environment, Environment>();

/** Whether each program holds a container comparison, scanned once. */
const containerComparisons = new WeakMap<QueryProgram, boolean>();

const CONTAINER_IN_PREDICATE =
  "a container comparison (in, or == or != with no scalar literal or null " +
  "operand) in a query predicate that reads a secret";
const CONTAINER_IN_PROJECTION =
  "a container comparison (in, or == or != with no scalar literal or null " +
  "operand) in a query projection that reads a secret";

/**
 * The service's base with the `Secret` type, the allowed set and every
 * refusal the inventory yields for its built-ins and for the query view's
 * own functions, so a Secret reaching `latestRun`, `model` or `behavior`
 * refuses too. The base itself is left as it is.
 */
export function queryViewEnvironment(base: Environment): Environment {
  let env = environments.get(base);
  if (env === undefined) {
    env = base.clone();
    registerSecretType(env);
    registerAllowedSet(env);
    registerSecretRefusals(env, {
      swampSignatures: QUERY_VIEW_FUNCTION_SIGNATURES,
    });
    environments.set(base, env);
  }
  return env;
}

function comparesContainers(program: QueryProgram): boolean {
  let result = containerComparisons.get(program);
  if (result === undefined) {
    result = hasContainerComparison(program.ast as unknown as CelAstNode);
    containerComparisons.set(program, result);
  }
  return result;
}

function refusalOf(fault: Fault, expression: string): QueryViewRefusal {
  return new QueryViewRefusal(fault.code, fault.operation, expression);
}

/** Records `operation` in the ambient scope and answers its refusal. */
function refusal(operation: string, expression: string): QueryViewRefusal {
  recordFault(operation);
  return new QueryViewRefusal(
    SECRET_OPERATION_UNSUPPORTED,
    operation,
    expression,
  );
}

/** The ambient scope, or the refusal of a query outside an evaluation. */
function callingScope(what: string, expression: string): FaultScope {
  const scope = currentFaultScope();
  if (scope === undefined) {
    throw new QueryViewRefusal(
      SECRET_OPERATION_UNSUPPORTED,
      `${what} outside an evaluation`,
      expression,
    );
  }
  return scope;
}

/** A program's answer that the synchronous row evaluation cannot await. */
function refusePromise(
  result: unknown,
  what: string,
  expression: string,
): void {
  if (result instanceof Promise) {
    result.catch(() => {});
    throw refusal(`an asynchronous ${what}`, expression);
  }
}

/** Kept by identity in a projection: a `Secret` and an adapted view. */
function keepOpaque(value: object): boolean {
  return isSecret(value) || isAdaptedView(value);
}

/**
 * The view for one `data.query` call, bound to the calling data namespace's
 * reader: records of any other namespace are read as stored, their tags
 * unread, as every accessor reads them, and a solo row is the reader's own
 * unless it reads the solo namespace (swamp-club#3785).
 */
export function expressionQueryView(
  reader: NamespaceReader | undefined,
): QueryView {
  return {
    environment: queryViewEnvironment,

    record(record: DataRecord): DataRecord {
      return adaptDataRecord(record, reader, "data.query") as DataRecord;
    },

    predicate(
      expression: string,
      program: QueryProgram,
      ctx: Record<string, unknown>,
    ): unknown {
      const calling = callingScope("a query predicate", expression);
      let result: unknown;
      let thrown: unknown;
      let threw = false;
      const row = runInFaultScope((scope) => {
        try {
          result = program(ctx);
        } catch (error) {
          threw = true;
          thrown = error;
        }
        return scope;
      });
      // The row's faults are the calling evaluation's: the first decides,
      // whether cel-js propagated it or absorbed it. The container rule
      // decides next, whether the program answered or threw an unrelated
      // error after the comparison, so a membership test on a secret is
      // never left to an error that drops the row quietly.
      for (const fault of row.faults) calling.faults.push(fault);
      const fault = row.faults[0];
      if (fault !== undefined) throw refusalOf(fault, expression);
      if (row.secretsRead > 0 && comparesContainers(program)) {
        throw refusal(CONTAINER_IN_PREDICATE, expression);
      }
      if (threw) throw thrown;
      refusePromise(result, "query predicate", expression);
      return result;
    },

    projection(
      expression: string,
      program: QueryProgram,
      ctx: Record<string, unknown>,
    ): unknown {
      const scope = callingScope("a query projection", expression);
      const faultsBefore = scope.faults.length;
      const readsBefore = scope.secretsRead;
      let result: unknown;
      let thrown: unknown;
      let threw = false;
      try {
        result = program(ctx);
      } catch (error) {
        threw = true;
        thrown = error;
      }
      // As for a predicate: the refusal decides, then the container rule,
      // then an unrelated error.
      const fault = scope.faults[faultsBefore];
      if (fault !== undefined) throw refusalOf(fault, expression);
      if (scope.secretsRead > readsBefore && comparesContainers(program)) {
        throw refusal(CONTAINER_IN_PROJECTION, expression);
      }
      if (threw) throw thrown;
      refusePromise(result, "query projection", expression);
      return coerceBigInts(result, keepOpaque);
    },
  };
}
