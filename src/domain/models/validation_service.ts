import type { z } from "zod";
import type { ModelDefinition } from "./model.ts";
import { modelRegistry } from "./model.ts";
import type { ModelInput } from "./model_input.ts";
import { ModelInputSchema } from "./model_input.ts";
import type { ModelResource } from "./model_resource.ts";
import { ModelResourceSchema } from "./model_resource.ts";
import type { InputRepository } from "./repositories.ts";
import { extractExpressions } from "../expressions/expression_parser.ts";
import {
  extractPathReferences,
  extractSelfReferences,
} from "../expressions/expression_path_extractor.ts";
import {
  formatAvailableKeys,
  validateSchemaPath,
} from "../expressions/schema_path_validator.ts";

/**
 * Represents a malformed expression found in the data.
 */
interface MalformedExpression {
  /** The path where the malformed expression was found */
  path: string;
  /** The raw string containing the malformed expression */
  raw: string;
  /** The type of malformation detected */
  issue: string;
  /** Suggestion for fixing the malformation */
  suggestion: string;
}

/**
 * Patterns that indicate a malformed expression.
 */
const MALFORMED_PATTERNS: Array<{
  pattern: RegExp;
  issue: string;
  suggestion: string;
}> = [
  {
    // {{...}} without the $ prefix (negative lookbehind ensures no $ before)
    pattern: /(?<!\$)\{\{(?!\{)[^}]+\}\}/,
    issue: "Expression uses {{...}} instead of ${{...}}",
    suggestion: 'Add "$" prefix: ${{...}}',
  },
  {
    // ${...} with single braces (common mistake)
    pattern: /\$\{(?!\{)[^}]+\}/,
    issue: "Expression uses ${...} instead of ${{...}}",
    suggestion: "Use double braces: ${{...}}",
  },
];

/**
 * Scans a data structure for malformed expressions.
 */
function findMalformedExpressions(
  data: unknown,
  basePath = "",
): MalformedExpression[] {
  const malformed: MalformedExpression[] = [];
  findMalformedExpressionsRecursive(data, basePath, malformed);
  return malformed;
}

function findMalformedExpressionsRecursive(
  data: unknown,
  path: string,
  malformed: MalformedExpression[],
): void {
  if (typeof data === "string") {
    // Check for malformed expression patterns
    for (const { pattern, issue, suggestion } of MALFORMED_PATTERNS) {
      const match = data.match(pattern);
      if (match) {
        malformed.push({
          path,
          raw: match[0],
          issue,
          suggestion,
        });
      }
    }
  } else if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      const itemPath = path ? `${path}[${i}]` : `[${i}]`;
      findMalformedExpressionsRecursive(data[i], itemPath, malformed);
    }
  } else if (data !== null && typeof data === "object") {
    for (const [key, value] of Object.entries(data)) {
      const propPath = path ? `${path}.${key}` : key;
      findMalformedExpressionsRecursive(value, propPath, malformed);
    }
  }
}

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
   * @param inputRepo - Optional input repository for resolving model references in expressions
   * @returns Array of validation results
   */
  validateModel(
    input: ModelInput,
    definition: ModelDefinition,
    resource: ModelResource | null,
    inputRepo?: InputRepository,
  ): Promise<ValidationResult[]>;
}

/**
 * Error detail for a single expression path validation failure.
 */
export interface ExpressionPathError {
  /** The raw expression that failed validation */
  expression: string;
  /** The error message */
  error: string;
  /** Optional suggestion for fixing the error */
  suggestion?: string;
  /** Optional available keys at the failure point */
  availableKeys?: string[];
}

/**
 * Default implementation of the model validation service.
 */
export class DefaultModelValidationService implements ModelValidationService {
  validateModel(
    input: ModelInput,
    definition: ModelDefinition,
    resource: ModelResource | null,
    inputRepo?: InputRepository,
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

    // Add expression path validation if inputRepo is provided
    if (inputRepo) {
      validations.push(
        this.validateExpressionPaths(input, definition, inputRepo),
      );
    }

    return Promise.all(validations);
  }

  private validateWithSchema(
    name: string,
    schema: z.ZodTypeAny,
    data: unknown,
  ): Promise<ValidationResult> {
    const result = schema.safeParse(data);
    return Promise.resolve(
      result.success
        ? ValidationResult.pass(name)
        : ValidationResult.fail(name, formatZodError(result.error)),
    );
  }

  private validateInputSchema(input: ModelInput): Promise<ValidationResult> {
    return this.validateWithSchema(
      "Input schema",
      ModelInputSchema,
      input.toData(),
    );
  }

  private validateInputAttributes(
    input: ModelInput,
    definition: ModelDefinition,
  ): Promise<ValidationResult> {
    return this.validateWithSchema(
      "Input attributes",
      definition.inputAttributesSchema,
      input.attributes,
    );
  }

  private validateResourceSchema(
    resource: ModelResource,
  ): Promise<ValidationResult> {
    return this.validateWithSchema(
      "Resource schema",
      ModelResourceSchema,
      resource.toData(),
    );
  }

  private validateResourceAttributes(
    resource: ModelResource,
    definition: ModelDefinition,
  ): Promise<ValidationResult> {
    return this.validateWithSchema(
      "Resource attributes",
      definition.resourceAttributesSchema,
      resource.attributes,
    );
  }

  /**
   * Validates expression paths in the model input attributes.
   *
   * Extracts all expressions from input attributes, resolves model references,
   * and validates that the paths exist in the referenced schemas.
   * Also detects malformed expressions that don't match the proper ${{...}} syntax.
   */
  private async validateExpressionPaths(
    input: ModelInput,
    definition: ModelDefinition,
    inputRepo: InputRepository,
  ): Promise<ValidationResult> {
    const errors: ExpressionPathError[] = [];

    // First, check for malformed expressions
    const malformedErrors = findMalformedExpressions(input.attributes).map(
      (m) => ({
        expression: m.raw,
        error: `${m.issue} at "${m.path}"`,
        suggestion: m.suggestion,
      }),
    );
    errors.push(...malformedErrors);

    // Extract and validate all expressions from input attributes
    for (const exprLocation of extractExpressions(input.attributes)) {
      const { celExpression, raw, path } = exprLocation;

      // Validate model references
      const pathRefs = extractPathReferences(celExpression);
      const modelErrors = await Promise.all(
        pathRefs.map((ref) => this.validateModelPathReference(ref, inputRepo)),
      );
      errors.push(
        ...modelErrors.filter((e): e is ExpressionPathError => e !== null),
      );

      // Validate self references
      const selfRefs = extractSelfReferences(celExpression);
      const selfErrors = selfRefs
        .map((ref) => this.validateSelfPathReference(ref, definition))
        .filter((e): e is ExpressionPathError => e !== null);
      errors.push(...selfErrors);

      // Check for expressions with valid ${{...}} syntax but no valid references
      if (pathRefs.length === 0 && selfRefs.length === 0) {
        const error = this.validateExpressionContent(celExpression, raw, path);
        if (error) errors.push(error);
      }
    }

    if (errors.length === 0) {
      return ValidationResult.pass("Expression paths");
    }

    const errorMessage = this.formatExpressionPathErrors(errors);
    return ValidationResult.fail("Expression paths", errorMessage);
  }

  /**
   * Validates expression content when no valid model or self references were found.
   * This catches cases like ${{my-vpc.VpcId}} which should be ${{ model.my-vpc.resource.attributes.VpcId }}
   */
  private validateExpressionContent(
    celExpression: string,
    rawExpression: string,
    path: string,
  ): ExpressionPathError | null {
    // First, check if it looks like a valid CEL literal or operation
    // These are valid expressions that don't need model/self references
    const looksLikeValidCel = /^[\d"'\[\{(]|^true$|^false$|^null$/.test(
      celExpression,
    );
    if (looksLikeValidCel) {
      return null;
    }

    // Check if it looks like an incomplete model reference (e.g., "my-vpc.VpcId")
    // Pattern: word characters/hyphens followed by dot and more content
    const incompleteModelRefPattern = /^([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_.]+)$/;
    const match = celExpression.match(incompleteModelRefPattern);

    if (match) {
      const modelName = match[1];
      const propertyPath = match[2];
      return {
        expression: rawExpression,
        error:
          `Invalid expression "${celExpression}" at "${path}". Missing "model." prefix and path structure`,
        suggestion:
          `Use: model.${modelName}.resource.attributes.${propertyPath} or model.${modelName}.input.attributes.${propertyPath}`,
      };
    }

    // Check if it's just a simple identifier that might be a model name (must start with letter)
    const simpleIdentifierPattern = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
    if (simpleIdentifierPattern.test(celExpression)) {
      return {
        expression: rawExpression,
        error:
          `Invalid expression "${celExpression}" at "${path}". Expression must reference model or self`,
        suggestion:
          `Use: model.${celExpression}.resource.attributes.<property> or self.attributes.<property>`,
      };
    }

    // For other unrecognized expressions, provide a generic error
    return {
      expression: rawExpression,
      error:
        `Expression "${celExpression}" at "${path}" does not contain valid model or self references`,
      suggestion:
        "Expressions should use: model.<name>.resource.attributes.<property>, model.<name>.input.attributes.<property>, or self.attributes.<property>",
    };
  }

  /**
   * Validates a model path reference (e.g., model.my-vpc.resource.attributes.VpcId).
   */
  private async validateModelPathReference(
    ref: {
      modelRef: string;
      type: "input" | "resource";
      path: string[];
      rawExpression: string;
    },
    inputRepo: InputRepository,
  ): Promise<ExpressionPathError | null> {
    // Look up the referenced model
    const result = await inputRepo.findByNameGlobal(ref.modelRef);
    if (!result) {
      return {
        expression: ref.rawExpression,
        error: `Referenced model "${ref.modelRef}" not found`,
      };
    }

    // Get the model definition
    const targetDefinition = modelRegistry.get(result.type);
    if (!targetDefinition) {
      return {
        expression: ref.rawExpression,
        error:
          `Unknown model type "${result.type.normalized}" for model "${ref.modelRef}"`,
      };
    }

    // Get the appropriate schema based on type and determine path to validate
    // The path includes "attributes" as the first segment (e.g., ["attributes", "VpcId"])
    // but the schema is already for the attributes object itself
    const firstSegment = ref.path[0];

    // Validate the path structure
    if (ref.path.length === 0) {
      // Just "input" or "resource" without a path is valid
      return null;
    }

    if (firstSegment !== "attributes") {
      // For now, we only support .attributes paths
      // Other valid paths like .id could be added later
      return {
        expression: ref.rawExpression,
        error: `Invalid path segment "${firstSegment}". Expected "attributes"`,
        suggestion: firstSegment === "attribute"
          ? 'Did you mean "attributes" instead of "attribute"?'
          : undefined,
      };
    }

    // Skip the "attributes" segment and validate the rest against the schema
    const pathToValidate = ref.path.slice(1);
    if (pathToValidate.length === 0) {
      // Just ".attributes" is valid
      return null;
    }

    const schema = ref.type === "input"
      ? targetDefinition.inputAttributesSchema
      : targetDefinition.resourceAttributesSchema;

    // Validate the path against the schema
    const validationResult = validateSchemaPath(schema, pathToValidate);
    if (!validationResult.valid && validationResult.error) {
      return {
        expression: ref.rawExpression,
        error: validationResult.error,
        suggestion: validationResult.suggestion,
        availableKeys: validationResult.availableKeys,
      };
    }

    return null;
  }

  /**
   * Validates a self path reference (e.g., self.attributes.VpcId).
   */
  private validateSelfPathReference(
    ref: { path: string[]; rawExpression: string },
    definition: ModelDefinition,
  ): ExpressionPathError | null {
    if (ref.path.length === 0) {
      return null;
    }

    const [firstSegment, ...remainingPath] = ref.path;
    const validPrimitiveSegments = ["name", "version", "tags"];

    if (validPrimitiveSegments.includes(firstSegment)) {
      return null;
    }

    if (firstSegment !== "attributes") {
      return {
        expression: ref.rawExpression,
        error:
          `Invalid self reference segment "${firstSegment}". Valid segments: name, version, tags, attributes`,
      };
    }

    if (remainingPath.length === 0) {
      return null;
    }

    const validationResult = validateSchemaPath(
      definition.inputAttributesSchema,
      remainingPath,
    );
    if (!validationResult.valid && validationResult.error) {
      return {
        expression: ref.rawExpression,
        error: validationResult.error,
        suggestion: validationResult.suggestion,
        availableKeys: validationResult.availableKeys,
      };
    }

    return null;
  }

  /**
   * Formats expression path errors into a human-readable string.
   */
  private formatExpressionPathErrors(errors: ExpressionPathError[]): string {
    return errors
      .map((err) => {
        const lines = [`  - ${err.expression}`, `    ${err.error}`];
        if (err.suggestion) lines.push(`    ${err.suggestion}`);
        if (err.availableKeys?.length) {
          lines.push(
            `    Available: ${formatAvailableKeys(err.availableKeys)}`,
          );
        }
        return lines.join("\n");
      })
      .join("\n");
  }
}
