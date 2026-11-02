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
 * the raw data query command, the extension API queryData and libswamp callers
 * pass no view, so they keep reading records as stored
 */

import type { Environment } from "cel-js";
import { UserError } from "../errors.ts";
import type { DataRecord } from "./data_record.ts";
import type { ASTNode } from "./query_predicate.ts";

export type QueryProgram =
  & ((ctx: Record<string, unknown>) => unknown)
  & { readonly ast: ASTNode };

/**
 * the query propagates it instead of skipping the row or answering null; code
 * and operation name what was refused and never a value
 */
export class QueryViewRefusal extends UserError {
  constructor(
    override readonly code: string,
    readonly operation: string,
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
  environment(base: Environment): Environment;
  /**
   * a new object when the view adapted the record, the record itself when left
   * as stored; the service routes a row's JSON content to the viewed attributes
   * by that identity alone
   */
  record(record: DataRecord): DataRecord;
  /**
   * a refusal the evaluation recorded is thrown as a QueryViewRefusal, absorbed
   * or not
   */
  predicate(
    expression: string,
    program: QueryProgram,
    ctx: Record<string, unknown>,
  ): unknown;
  projection(
    expression: string,
    program: QueryProgram,
    ctx: Record<string, unknown>,
  ): unknown;
}
