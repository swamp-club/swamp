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
