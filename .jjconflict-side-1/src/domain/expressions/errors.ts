// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
    super(
      `Model not found: ${modelRef}`,
      expression,
      path,
    );
    this.name = "ModelNotFoundError";
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
 * Error thrown when circular dependencies are detected between expressions.
 */
export class CyclicDependencyError extends ExpressionError {
  constructor(readonly cycle: string[]) {
    super(`Cyclic dependency detected: ${cycle.join(" -> ")}`);
    this.name = "CyclicDependencyError";
  }
}
