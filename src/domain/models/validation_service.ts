import type { z } from "zod";
import type { ModelDefinition } from "./model.ts";
import type { ModelInput } from "./model_input.ts";
import { ModelInputSchema } from "./model_input.ts";
import type { ModelResource } from "./model_resource.ts";
import { ModelResourceSchema } from "./model_resource.ts";

/**
 * Value object representing the result of a single validation.
 *
 * Immutable with equality based on value (name + passed + error).
 */
export class ValidationResult {
  private constructor(
    readonly name: string,
    readonly passed: boolean,
    readonly error?: string,
  ) {}

  /**
   * Creates a passing validation result.
   */
  static pass(name: string): ValidationResult {
    return new ValidationResult(name, true);
  }

  /**
   * Creates a failing validation result with an error message.
   */
  static fail(name: string, error: string): ValidationResult {
    return new ValidationResult(name, false, error);
  }

  /**
   * Value equality comparison.
   */
  equals(other: ValidationResult): boolean {
    return (
      this.name === other.name &&
      this.passed === other.passed &&
      this.error === other.error
    );
  }
}

/**
 * Formats a Zod error into a human-readable string.
 */
function formatZodError(error: z.ZodError): string {
  if (error.issues.length === 1) {
    const issue = error.issues[0];
    const path = issue.path.length > 0 ? ` at "${issue.path.join(".")}"` : "";
    return `${issue.message}${path}`;
  }
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? ` at "${issue.path.join(".")}"` : "";
      return `${issue.message}${path}`;
    })
    .join("; ");
}

/**
 * Domain service interface for model validation.
 */
export interface ModelValidationService {
  /**
   * Validates a model input and optionally its resource against the model definition.
   *
   * Runs all validations in parallel.
   *
   * @param input - The model input to validate
   * @param definition - The model definition containing schemas
   * @param resource - The model resource if one exists, or null
   * @returns Array of validation results
   */
  validateModel(
    input: ModelInput,
    definition: ModelDefinition,
    resource: ModelResource | null,
  ): Promise<ValidationResult[]>;
}

/**
 * Default implementation of the model validation service.
 */
export class DefaultModelValidationService implements ModelValidationService {
  validateModel(
    input: ModelInput,
    definition: ModelDefinition,
    resource: ModelResource | null,
  ): Promise<ValidationResult[]> {
    const validations: Promise<ValidationResult>[] = [
      this.validateInputSchema(input),
      this.validateInputAttributes(input, definition),
    ];

    if (resource) {
      validations.push(
        this.validateResourceSchema(resource),
        this.validateResourceAttributes(resource, definition),
      );
    }

    return Promise.all(validations);
  }

  private validateInputSchema(input: ModelInput): Promise<ValidationResult> {
    const result = ModelInputSchema.safeParse(input.toData());
    if (result.success) {
      return Promise.resolve(ValidationResult.pass("Input schema"));
    }
    return Promise.resolve(
      ValidationResult.fail("Input schema", formatZodError(result.error)),
    );
  }

  private validateInputAttributes(
    input: ModelInput,
    definition: ModelDefinition,
  ): Promise<ValidationResult> {
    const result = definition.inputAttributesSchema.safeParse(input.attributes);
    if (result.success) {
      return Promise.resolve(ValidationResult.pass("Input attributes"));
    }
    return Promise.resolve(
      ValidationResult.fail("Input attributes", formatZodError(result.error)),
    );
  }

  private validateResourceSchema(
    resource: ModelResource,
  ): Promise<ValidationResult> {
    const result = ModelResourceSchema.safeParse(resource.toData());
    if (result.success) {
      return Promise.resolve(ValidationResult.pass("Resource schema"));
    }
    return Promise.resolve(
      ValidationResult.fail("Resource schema", formatZodError(result.error)),
    );
  }

  private validateResourceAttributes(
    resource: ModelResource,
    definition: ModelDefinition,
  ): Promise<ValidationResult> {
    const result = definition.resourceAttributesSchema.safeParse(
      resource.attributes,
    );
    if (result.success) {
      return Promise.resolve(ValidationResult.pass("Resource attributes"));
    }
    return Promise.resolve(
      ValidationResult.fail(
        "Resource attributes",
        formatZodError(result.error),
      ),
    );
  }
}
