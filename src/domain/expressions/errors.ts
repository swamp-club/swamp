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

/**
 * Base error for all expression-related errors.
 */
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

/**
 * Error thrown when a model referenced in an expression cannot be found.
 */
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

/**
 * Error thrown when an expression is syntactically or semantically invalid.
 */
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

/**
 * Error thrown when a method is about to run with an argument that still holds
 * an expression whose evaluation failed. Carries the original evaluation error
 * as its cause so the CEL message (and its caret) reaches the user.
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
    // The wrapper adds text, so it builds its own model spelling from the
    // cause's (swamp-club#3437).
    const causeModelText = modelWording(cause);
    if (causeModelText !== undefined) {
      markModelWording(
        this,
        `Expression in ${path} could not be evaluated: ${causeModelText}`,
      );
    }
  }
}

/** An expression applied an operation outside a secret's allowed set. */
export const SECRET_OPERATION_UNSUPPORTED = "secret_operation_unsupported";

/** An expression sent a secret where secrets are not accepted. */
export const SECRET_DESTINATION_REFUSED = "secret_destination_refused";

/**
 * A data record's sensitive-fields tag, one of its paths, or a tagged value
 * is not what the writer stores, so the record cannot enter an expression
 * (design/enablers/typed-secrets.md Section 6.1).
 */
export const SECRET_REFERENCE_INVALID = "secret_reference_invalid";

/** The stable codes an expression's secret refusal carries. */
export type SecretRefusalCode =
  | typeof SECRET_OPERATION_UNSUPPORTED
  | typeof SECRET_DESTINATION_REFUSED
  | typeof SECRET_REFERENCE_INVALID;

/**
 * An expression refused an operation on a secret
 * (design/enablers/typed-secrets.md Section 4). The message names the refused
 * operation, the code and the expression, never a value, and the error
 * carries no cause: a cel-js error or the refusing handler's own error can
 * name an operand.
 */
export class SecretRefusedError extends UserError {
  declare readonly code: SecretRefusalCode;

  constructor(
    code: SecretRefusalCode,
    /** What was refused: an operator or function signature, or a rule. */
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

/**
 * Error thrown when circular dependencies are detected between expressions.
 */
export class CyclicDependencyError extends ExpressionError {
  constructor(readonly cycle: string[]) {
    super(`Cyclic dependency detected: ${cycle.join(" -> ")}`);
    this.name = "CyclicDependencyError";
  }
}
