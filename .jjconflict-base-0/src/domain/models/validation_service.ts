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

import type { z } from "zod";
import type { ModelDefinition } from "./model.ts";
import { modelRegistry } from "./model.ts";
import type { Definition } from "../definitions/definition.ts";
import { DefinitionSchema } from "../definitions/definition.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
import {
  extractExpressions,
  stripExpressionFields,
} from "../expressions/expression_parser.ts";
import {
  extractEnvReferences,
  extractPathReferences,
  extractSelfReferences,
} from "../expressions/expression_path_extractor.ts";
import type { DependencyType } from "../expressions/dependency_extractor.ts";
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
   * Validates a definition against the model definition.
   *
   * Runs all validations in parallel.
   *
   * @param definition - The definition to validate
   * @param modelDef - The model definition containing schemas
   * @param definitionRepo - Optional definition repository for resolving model references in expressions
   * @returns Array of validation results
   */
  validateModel(
    definition: Definition,
    modelDef: ModelDefinition,
    definitionRepo?: DefinitionRepository,
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
    definition: Definition,
    modelDef: ModelDefinition,
    definitionRepo?: DefinitionRepository,
  ): Promise<ValidationResult[]> {
    const validations: Promise<ValidationResult>[] = [
      this.validateDefinitionSchema(definition),
      this.validateGlobalArguments(definition, modelDef),
      this.validateMethodArguments(definition, modelDef),
    ];

    // Add expression path validation if definitionRepo is provided
    if (definitionRepo) {
      validations.push(
        this.validateExpressionPaths(definition, modelDef, definitionRepo),
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

  private validateDefinitionSchema(
    definition: Definition,
  ): Promise<ValidationResult> {
    return this.validateWithSchema(
      "Definition schema",
      DefinitionSchema,
      definition.toData(),
    );
  }

  private validateGlobalArguments(
    definition: Definition,
    modelDef: ModelDefinition,
  ): Promise<ValidationResult> {
    // Skip if model has no globalArguments schema
    if (!modelDef.globalArguments) {
      return Promise.resolve(ValidationResult.pass("Global arguments"));
    }

    // Strip fields that contain expressions - they will be validated after evaluation.
    // Only validate the static (non-expression) fields against the schema.
    const staticArgs = stripExpressionFields(definition.globalArguments);

    // If any fields were stripped (contain expressions), skip schema validation entirely.
    // Expression paths are validated separately, and full schema validation will happen
    // at runtime when the evaluated definition is executed.
    const totalFields = Object.keys(definition.globalArguments).length;
    const staticFields = Object.keys(staticArgs).length;
    if (staticFields < totalFields) {
      // Some fields contain expressions - skip schema validation
      return Promise.resolve(ValidationResult.pass("Global arguments"));
    }

    // All fields are static, validate normally
    return this.validateWithSchema(
      "Global arguments",
      modelDef.globalArguments,
      staticArgs,
    );
  }

  private validateMethodArguments(
    definition: Definition,
    modelDef: ModelDefinition,
  ): Promise<ValidationResult> {
    const errors: string[] = [];
    const methodData = definition.methodData;

    for (const [methodName, methodDef] of Object.entries(modelDef.methods)) {
      const args = methodData[methodName]?.arguments;
      if (!args) continue;

      // Strip fields that contain expressions
      const staticArgs = stripExpressionFields(args);
      const totalFields = Object.keys(args).length;
      const staticFields = Object.keys(staticArgs).length;
      if (staticFields < totalFields) {
        // Some fields contain expressions - skip validation for this method
        continue;
      }

      const result = methodDef.arguments.safeParse(staticArgs);
      if (!result.success) {
        errors.push(
          `Method "${methodName}": ${formatZodError(result.error)}`,
        );
      }
    }

    if (errors.length === 0) {
      return Promise.resolve(ValidationResult.pass("Method arguments"));
    }

    return Promise.resolve(
      ValidationResult.fail("Method arguments", errors.join("; ")),
    );
  }

  /**
   * Validates expression paths in the definition attributes.
   *
   * Extracts all expressions from definition attributes, resolves model references,
   * and validates that the paths exist in the referenced schemas.
   * Also detects malformed expressions that don't match the proper ${{...}} syntax.
   */
  private async validateExpressionPaths(
    definition: Definition,
    modelDef: ModelDefinition,
    definitionRepo: DefinitionRepository,
  ): Promise<ValidationResult> {
    const errors: ExpressionPathError[] = [];

    // First, check for malformed expressions in globalArguments and methods
    const malformedErrors = [
      ...findMalformedExpressions(definition.globalArguments),
      ...findMalformedExpressions(definition.methodData),
    ].map(
      (m) => ({
        expression: m.raw,
        error: `${m.issue} at "${m.path}"`,
        suggestion: m.suggestion,
      }),
    );
    errors.push(...malformedErrors);

    // Extract and validate all expressions from definition data
    const allExpressionData = {
      globalArguments: definition.globalArguments,
      methods: definition.methodData,
    };
    for (const exprLocation of extractExpressions(allExpressionData)) {
      const { celExpression, raw, path } = exprLocation;

      // Validate model references
      const pathRefs = extractPathReferences(celExpression);
      const modelErrors = await Promise.all(
        pathRefs.map((ref) =>
          this.validateModelPathReference(ref, definitionRepo)
        ),
      );
      errors.push(
        ...modelErrors.filter((e): e is ExpressionPathError => e !== null),
      );

      // Validate self references
      const selfRefs = extractSelfReferences(celExpression);
      const selfErrors = selfRefs
        .map((ref) => this.validateSelfPathReference(ref, modelDef))
        .filter((e): e is ExpressionPathError => e !== null);
      errors.push(...selfErrors);

      // Extract env references (these are always valid - resolved at runtime)
      const envRefs = extractEnvReferences(celExpression);

      // Check for inputs references (valid when model defines an inputs schema)
      const hasInputsRef = /\binputs\./.test(celExpression);

      // Check for expressions with valid ${{...}} syntax but no valid references
      if (
        pathRefs.length === 0 && selfRefs.length === 0 &&
        envRefs.length === 0 && !hasInputsRef
      ) {
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
   * Validates expression content when no valid model, self, or env references were found.
   * This catches cases like ${{my-vpc.VpcId}} which should be ${{ model.my-vpc.resource.attributes.VpcId }}
   */
  private validateExpressionContent(
    celExpression: string,
    rawExpression: string,
    path: string,
  ): ExpressionPathError | null {
    // First, check if it looks like a valid CEL literal or operation
    // These are valid expressions that don't need model/self/env references
    const looksLikeValidCel = /^[\d"'\[\{(]|^true$|^false$|^null$/.test(
      celExpression,
    );
    if (looksLikeValidCel) {
      return null;
    }

    // Check if it's a valid vault expression (vault.get(...))
    const vaultPattern = /^vault\.get\(.*\)$/;
    if (vaultPattern.test(celExpression)) {
      return null; // Valid vault expression
    }

    // Check if it's a valid file.contents expression
    const fileContentsPattern = /^file\.contents\(.*\)/;
    if (fileContentsPattern.test(celExpression)) {
      return null;
    }

    // Check if it's a valid data function expression
    const dataFunctionPattern =
      /^data\.(version|latest|listVersions|findByTag)\(.*\)/;
    if (dataFunctionPattern.test(celExpression)) {
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
          `Use: model.${modelName}.resource.<specName>.<instanceName>.attributes.${propertyPath} or model.${modelName}.definition.globalArguments.${propertyPath}`,
      };
    }

    // Check if it's just a simple identifier that might be a model name (must start with letter)
    const simpleIdentifierPattern = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
    if (simpleIdentifierPattern.test(celExpression)) {
      return {
        expression: rawExpression,
        error:
          `Invalid expression "${celExpression}" at "${path}". Expression must reference model, self, or env`,
        suggestion:
          `Use: model.${celExpression}.resource.<specName>.<instanceName>.attributes.<property>, self.globalArguments.<property>, or env.<VARIABLE_NAME>`,
      };
    }

    // For other unrecognized expressions, provide a generic error
    return {
      expression: rawExpression,
      error:
        `Expression "${celExpression}" at "${path}" does not contain valid model, self, or env references`,
      suggestion:
        "Expressions should use: model.<name>.resource.<specName>.<instanceName>.attributes.<property>, model.<name>.definition.globalArguments.<property>, self.globalArguments.<property>, or env.<VARIABLE_NAME>",
    };
  }

  /**
   * Validates a model path reference (e.g., model.my-vpc.data.attributes.VpcId).
   */
  private async validateModelPathReference(
    ref: {
      modelRef: string;
      type: DependencyType;
      path: string[];
      rawExpression: string;
    },
    definitionRepo: DefinitionRepository,
  ): Promise<ExpressionPathError | null> {
    // Look up the referenced model
    const result = await definitionRepo.findByNameGlobal(ref.modelRef);
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
    const firstSegment = ref.path[0];

    // Validate the path structure
    if (ref.path.length === 0) {
      // Just "input" or "resource" without a path is valid
      return null;
    }

    // For resource namespace: model.X.resource.<specName>.<instanceName>.<field>
    // path[0] is the specName, path[1] is the instanceName (any value valid), path[2+] are DataRecord fields
    if (ref.type === "resource") {
      const specName = firstSegment;
      const availableSpecs = targetDefinition.resources
        ? Object.keys(targetDefinition.resources)
        : [];

      if (availableSpecs.length > 0 && !availableSpecs.includes(specName)) {
        return {
          expression: ref.rawExpression,
          error:
            `Unknown resource spec "${specName}" on model "${ref.modelRef}"`,
          suggestion: `Available resource specs: ${availableSpecs.join(", ")}`,
        };
      }

      // path[1] is the instanceName — skip validation (any name is valid)
      // Validate DataRecord fields after instanceName
      if (ref.path.length > 2) {
        const recordField = ref.path[2];
        const validRecordFields = [
          "id",
          "name",
          "version",
          "createdAt",
          "attributes",
          "tags",
        ];
        if (!validRecordFields.includes(recordField)) {
          return {
            expression: ref.rawExpression,
            error: `Invalid field "${recordField}" on resource "${specName}"`,
            suggestion: `Resource records have: ${
              validRecordFields.join(", ")
            }`,
          };
        }

        // If accessing .attributes.<field>, validate against the resource schema
        if (
          recordField === "attributes" && ref.path.length > 3 &&
          targetDefinition.resources?.[specName]
        ) {
          const schema = targetDefinition.resources[specName].schema;
          const pathToValidate = ref.path.slice(3);
          const validationResult = validateSchemaPath(
            schema,
            pathToValidate,
          );
          if (!validationResult.valid && validationResult.error) {
            return {
              expression: ref.rawExpression,
              error: validationResult.error,
              suggestion: validationResult.suggestion,
              availableKeys: validationResult.availableKeys,
            };
          }
        }
      }
      return null;
    }

    // For file namespace: model.X.file.<specName>.<instanceName>.<field>
    // path[0] is the specName, path[1] is the instanceName (any value valid), path[2+] are FileDataRecord fields
    if (ref.type === "file") {
      const specName = firstSegment;
      const availableSpecs = targetDefinition.files
        ? Object.keys(targetDefinition.files)
        : [];

      if (availableSpecs.length > 0 && !availableSpecs.includes(specName)) {
        return {
          expression: ref.rawExpression,
          error: `Unknown file spec "${specName}" on model "${ref.modelRef}"`,
          suggestion: `Available file specs: ${availableSpecs.join(", ")}`,
        };
      }

      // path[1] is the instanceName — skip validation (any name is valid)
      if (ref.path.length > 2) {
        const fileField = ref.path[2];
        const validFileFields = [
          "id",
          "version",
          "createdAt",
          "path",
          "size",
          "contentType",
        ];
        if (!validFileFields.includes(fileField)) {
          return {
            expression: ref.rawExpression,
            error: `Invalid field "${fileField}" on file "${specName}"`,
            suggestion: `File records have: ${validFileFields.join(", ")}`,
          };
        }
      }
      return null;
    }

    if (ref.type === "execution") {
      const validExecSegments = [
        "id",
        "methodName",
        "status",
        "startedAt",
        "completedAt",
        "durationMs",
        "error",
      ];
      if (!validExecSegments.includes(firstSegment)) {
        return {
          expression: ref.rawExpression,
          error: `Invalid path segment "${firstSegment}" for execution`,
          suggestion: `Execution has: ${validExecSegments.join(", ")}`,
        };
      }
      return null;
    }

    // For definition type, validate globalArguments path
    if (firstSegment !== "globalArguments") {
      return {
        expression: ref.rawExpression,
        error:
          `Invalid path segment "${firstSegment}". Expected "globalArguments"`,
        suggestion: firstSegment === "attributes"
          ? 'Did you mean "globalArguments" instead of "attributes"?'
          : undefined,
      };
    }

    // Skip the "globalArguments" segment and validate the rest against the schema
    const pathToValidate = ref.path.slice(1);
    if (pathToValidate.length === 0) {
      // Just ".globalArguments" is valid
      return null;
    }

    // Validate against the global arguments schema
    if (!targetDefinition.globalArguments) {
      return null;
    }

    const validationResult = validateSchemaPath(
      targetDefinition.globalArguments,
      pathToValidate,
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

    if (firstSegment !== "globalArguments") {
      return {
        expression: ref.rawExpression,
        error:
          `Invalid self reference segment "${firstSegment}". Valid segments: name, version, tags, globalArguments`,
      };
    }

    if (remainingPath.length === 0) {
      return null;
    }

    if (!definition.globalArguments) {
      return null;
    }

    const validationResult = validateSchemaPath(
      definition.globalArguments,
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
