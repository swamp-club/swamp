import { evaluate, parse } from "cel-js";
import { InvalidExpressionError } from "../../domain/expressions/errors.ts";
import { transformHyphenatedModelRefs } from "../../domain/expressions/expression_parser.ts";

/**
 * Result of expression validation.
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * CEL evaluator that wraps the cel-js library.
 *
 * Provides type-safe evaluation of CEL expressions with model, self, and workflow contexts.
 */
export class CelEvaluator {
  /**
   * Evaluates a CEL expression with the given context.
   *
   * @param expression - The CEL expression to evaluate
   * @param context - The context object containing model, self, workflow data
   * @returns The evaluated result
   * @throws InvalidExpressionError if evaluation fails
   */
  evaluate(expression: string, context: Record<string, unknown>): unknown {
    try {
      // Transform hyphenated model names to bracket notation before evaluation
      const transformedExpr = transformHyphenatedModelRefs(expression);
      const result = evaluate(transformedExpr, context);
      return result;
    } catch (error) {
      throw new InvalidExpressionError(
        error instanceof Error ? error.message : String(error),
        expression,
        undefined,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Validates a CEL expression without evaluating it.
   *
   * @param expression - The CEL expression to validate
   * @returns Validation result with error message if invalid
   */
  validate(expression: string): ValidationResult {
    try {
      // Attempt to parse the expression
      const result = parse(expression);
      if (result.isSuccess) {
        return { valid: true };
      } else {
        return {
          valid: false,
          error: result.errors?.join("; ") ?? "Unknown parse error",
        };
      }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
