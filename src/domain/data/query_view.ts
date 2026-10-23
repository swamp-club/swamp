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
 * The port through which an expression-facing query views the records its
 * predicate and projection read (design/enablers/typed-secrets.md Section
 * 6.2, typed-secrets 4.3). The query service takes one per query in
 * `DataQueryOptions.view`; the CEL adapter implements it for the typed
 * `data.query` accessor. The raw `swamp data query` command, the extension
 * API's `queryData` and the libswamp callers pass none, so they keep reading
 * records as stored.
 */

import type { Environment } from "cel-js";
import { UserError } from "../errors.ts";
import type { DataRecord } from "./data_record.ts";
import type { ASTNode } from "./query_predicate.ts";

/**
 * A parsed predicate or projection: a program over one row's context, with
 * the AST it was parsed from.
 */
export type QueryProgram =
  & ((ctx: Record<string, unknown>) => unknown)
  & { readonly ast: ASTNode };

/**
 * The refusal a view raises for a row's predicate or projection: a secret
 * refusal its evaluation recorded, absorbed or not, or an evaluation the
 * view cannot run. The query propagates it instead of skipping the row or
 * answering null; the calling evaluation answers with the fault the view
 * recorded, so the code and operation here name what was refused and never
 * a value.
 */
export class QueryViewRefusal extends UserError {
  constructor(
    /** The secret refusal code, as `SecretRefusedError` carries it. */
    override readonly code: string,
    /** What was refused: an operator or function signature, or a rule. */
    readonly operation: string,
    /** The predicate or projection text. */
    readonly expression: string,
  ) {
    super(
      `A query refused a secret (${code}): ${operation}, in ${expression}`,
      code,
    );
    this.name = "QueryViewRefusal";
  }
}

export interface QueryView {
  /**
   * The environment predicates and projections evaluate in, derived from
   * the service's own base and memoized by the implementation.
   */
  environment(base: Environment): Environment;
  /**
   * `record` as the predicate and the projection read it: a new object when
   * the view adapted it, and `record` itself when the view leaves it as
   * stored (another namespace's, or one whose tag names no sensitive
   * field). The service routes a row's JSON content to the viewed
   * attributes by that identity alone.
   */
  record(record: DataRecord): DataRecord;
  /**
   * Evaluates one row's predicate and answers the match. A refusal the
   * evaluation recorded is thrown as a {@link QueryViewRefusal}, absorbed
   * or not, and what the predicate read stays with the row.
   */
  predicate(
    expression: string,
    program: QueryProgram,
    ctx: Record<string, unknown>,
  ): unknown;
  /**
   * Evaluates one row's projection and answers the value the calling
   * expression receives, post-processing included.
   */
  projection(
    expression: string,
    program: QueryProgram,
    ctx: Record<string, unknown>,
  ): unknown;
}
