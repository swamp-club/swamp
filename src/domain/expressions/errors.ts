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

import { UserError } from "../errors.ts";
import {
  markModelWording,
  modelWording,
  wordedText,
} from "../behavior_wording.ts";

export class ExpressionError extends Error {
  readonly expression?: string;
  readonly path?: string;

  constructor(
    message: string,
    expression?: string,
    path?: string,
    cause?: Error,
  ) {
    super(message, { cause });
    this.name = "ExpressionError";
    this.expression = expression;
    this.path = path;
  }
}

export class ModelNotFoundError extends ExpressionError {
  constructor(
    readonly modelRef: string,
    expression?: string,
    path?: string,
  ) {
    const worded = wordedText((w) => `${w.Noun} not found: ${modelRef}`);
    super(worded.text, expression, path);
    this.name = "ModelNotFoundError";
    markModelWording(this, worded.modelText);
  }
}

export class InvalidExpressionError extends ExpressionError {
  constructor(
    message: string,
    expression?: string,
    path?: string,
    cause?: Error,
  ) {
    super(
      `Invalid expression: ${message}`,
      expression,
      path,
      cause,
    );
    this.name = "InvalidExpressionError";
  }
}

export class UnboundExpressionError extends InvalidExpressionError {
  constructor(message: string, expression: string) {
    super(message, expression);
    this.name = "UnboundExpressionError";
  }
}

/**
 * like an absent binding, this is a gap a later run fills, so validation leaves
 * the expression as its stored text
 */
export class MissingModelDataError extends InvalidExpressionError {
  constructor(
    message: string,
    expression: string,
    path?: string,
    cause?: Error,
  ) {
    super(message, expression, path, cause);
    this.name = "MissingModelDataError";
    // The gap is not an invalid expression, so the message carries no such
    // prefix: it names the model or lookup that has no data.
    this.message = message;
  }
}

/**
 * carries the original evaluation error as its cause so the CEL message (and
 * its caret) reaches the user
 */
export class UnresolvedExpressionError extends ExpressionError {
  constructor(expression: string, path: string, cause: Error) {
    super(
      `Expression in ${path} could not be evaluated: ${cause.message}`,
      expression,
      path,
      cause,
    );
    this.name = "UnresolvedExpressionError";
    // the wrapper adds text, so it builds its own model spelling from the
    // cause's
    const causeModelText = modelWording(cause);
    if (causeModelText !== undefined) {
      markModelWording(
        this,
        `Expression in ${path} could not be evaluated: ${causeModelText}`,
      );
    }
  }
}

export const SECRET_OPERATION_UNSUPPORTED = "secret_operation_unsupported";

export const SECRET_DESTINATION_REFUSED = "secret_destination_refused";

/**
 * a data record's sensitive-fields tag, one of its paths, or a tagged value is
 * not what the writer stores, so the record cannot enter an expression
 */
export const SECRET_REFERENCE_INVALID = "secret_reference_invalid";

export type SecretRefusalCode =
  | typeof SECRET_OPERATION_UNSUPPORTED
  | typeof SECRET_DESTINATION_REFUSED
  | typeof SECRET_REFERENCE_INVALID;

export function secretRefusalCode(
  error: unknown,
): SecretRefusalCode | undefined {
  const seen = new Set<unknown>();
  while (typeof error === "object" && error !== null && !seen.has(error)) {
    seen.add(error);
    const { code, cause } = error as { code?: unknown; cause?: unknown };
    if (
      code === SECRET_OPERATION_UNSUPPORTED ||
      code === SECRET_DESTINATION_REFUSED || code === SECRET_REFERENCE_INVALID
    ) return code;
    error = cause;
  }
  return undefined;
}

/**
 * the message names the operation, code and expression, never a value, and the
 * error carries no cause: a cel-js error or the refusing handler's error can
 * name an operand
 */
export class SecretRefusedError extends UserError {
  declare readonly code: SecretRefusalCode;

  constructor(
    code: SecretRefusalCode,
    readonly operation: string,
    readonly expression: string,
  ) {
    super(
      `Expression refused a secret (${code}): ${operation}, in ${expression}`,
      code,
    );
    this.name = "SecretRefusedError";
  }
}

export class CyclicDependencyError extends ExpressionError {
  constructor(readonly cycle: string[]) {
    super(`Cyclic dependency detected: ${cycle.join(" -> ")}`);
    this.name = "CyclicDependencyError";
  }
}
