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
 * a predicate runs in a row-local fault scope; its refusals propagate to the
 * calling evaluation and fail the query, and the container rule applies to the
 * predicate itself since the caller scans only its own AST
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

const environments = new WeakMap<Environment, Environment>();

const containerComparisons = new WeakMap<QueryProgram, boolean>();

const CONTAINER_IN_PREDICATE =
  "a container comparison (in, or == or != with no scalar literal or null " +
  "operand) in a query predicate that reads a secret";
const CONTAINER_IN_PROJECTION =
  "a container comparison (in, or == or != with no scalar literal or null " +
  "operand) in a query projection that reads a secret";

/**
 * clones the base so a Secret reaching latestRun, model or behavior refuses
 * too; the base itself is left as it is
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

function refusal(operation: string, expression: string): QueryViewRefusal {
  recordFault(operation);
  return new QueryViewRefusal(
    SECRET_OPERATION_UNSUPPORTED,
    operation,
    expression,
  );
}

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

function keepOpaque(value: object): boolean {
  return isSecret(value) || isAdaptedView(value);
}

/**
 * records of any other namespace are read as stored, tags unread, as every
 * accessor reads them; a solo row is the reader's own unless it reads the solo
 * namespace
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
      // the row's faults are the calling evaluation's: the first decides, then
      // the container rule, so a membership test on a secret is never left to
      // an error that drops the row quietly
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
