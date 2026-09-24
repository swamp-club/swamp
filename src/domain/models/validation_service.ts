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

import type { z } from "zod";
import type { MethodContext, ModelDefinition } from "./model.ts";
import { modelRegistry } from "./model.ts";
import { buildMethodContext } from "./method_context.ts";
import type { Definition } from "../definitions/definition.ts";
import { DefinitionSchema } from "../definitions/definition.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
import type { DataQueryService } from "../data/data_query_service.ts";
import {
  dataAccessorAlternation,
  extractExpressions,
  stripExpressionFields,
  valueContainsExpression,
} from "../expressions/expression_parser.ts";
import { detectEnvVarUsageInDefinition } from "./env_var_detector.ts";
import { foreignTemplatePathPredicate } from "./foreign_template_fields.ts";
import {
  scanTemplateSyntax,
  type TemplateSyntaxFinding,
  type TemplateSyntaxForm,
  type TemplateSyntaxScan,
} from "./template_syntax_scan.ts";
import { CalVer } from "./calver.ts";
import { coerceMethodArgs, getObjectShape } from "./zod_type_coercion.ts";
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
 * The second remedy for template-like text, for when it is another service's
 * syntax rather than a swamp expression with its syntax slightly wrong. The
 * example rebuilds the matched form, so it differs per form.
 */
function foreignTemplateRemedy(example: string): string {
  return `If this is another service's template syntax, build it with CEL string concatenation, e.g. ${example}, or have the model type declare the field with .meta({ foreignTemplate: true }).`;
}

/**
 * Error text for template-like text that swamp would claim as its own
 * expression once the syntax is fixed.
 */
const MALFORMED_EXPRESSION_MESSAGES: Record<
  TemplateSyntaxForm,
  { issue: string; suggestion: string }
> = {
  "bare-double-brace": {
    issue: "Expression uses {{...}} instead of ${{...}}",
    suggestion: `Add "$" prefix: \${{...}}. ${
      foreignTemplateRemedy('${{ "{" + "{name}" + "}" }}')
    }`,
  },
  "single-brace": {
    issue: "Expression uses ${...} instead of ${{...}}",
    suggestion: `Use double braces: \${{...}}. ${
      foreignTemplateRemedy('${{ "$" + "{name}" }}')
    }`,
  },
  "inside-expression": {
    issue: "Template text {{...}} inside a ${{...}} expression cuts it short",
    suggestion:
      'An expression ends at the first }}, so a string inside it cannot hold {{...}}. Build the braces with CEL string concatenation instead, e.g. ${{ "{" + "{name}" + "}" }}.',
  },
  "unclosed-expression": {
    issue: "Unclosed ${{...}} expression",
    suggestion:
      "An expression ends at the first }} after its ${{. This one is not valid CEL up to there, or has no }} at all, so it is probably missing a closing brace. Close it with }} where it should end.",
  },
};

/**
 * Name of the warning for another service's template syntax. Agent guidance
 * and acceptance tests identify the warning by this name.
 */
export const FOREIGN_TEMPLATE_WARNING_NAME = "Template syntax passed through";

/**
 * Value object representing a validation warning.
 *
 * Warnings do not cause validation to fail — they surface information
 * that may affect runtime behavior (e.g., env var usage).
 *
 * Immutable with equality based on value.
 */
export class ValidationWarning {
  private constructor(
    readonly name: string,
    readonly message: string,
    readonly details?: EnvVarUsageDetail[],
    readonly templates?: ForeignTemplateDetail[],
  ) {}

  /**
   * Creates a warning about environment variable usage in a model definition.
   */
  static envVarUsage(
    envVars: EnvVarUsageDetail[],
  ): ValidationWarning {
    const message =
      "Data stored under this model will vary depending on these environment variables at runtime. Consider using separate models per environment, or vault.get() for sensitive values.";
    return new ValidationWarning(
      "Environment variables detected",
      message,
      envVars,
    );
  }

  /**
   * Creates a warning about another service's template syntax, which is
   * passed to the method unchanged.
   */
  static foreignTemplateSyntax(
    templates: ForeignTemplateDetail[],
  ): ValidationWarning {
    const message =
      "This text is not a swamp expression and is passed to the method unchanged. If you meant a swamp expression, write ${{ ... }}. If it is another service's template syntax, the model type can declare the field with .meta({ foreignTemplate: true }) to silence this warning.";
    return new ValidationWarning(
      FOREIGN_TEMPLATE_WARNING_NAME,
      message,
      undefined,
      templates,
    );
  }

  /**
   * Value equality comparison.
   */
  equals(other: ValidationWarning): boolean {
    return (
      this.name === other.name &&
      this.message === other.message
    );
  }
}

/**
 * Describes another service's template syntax found in a model definition.
 */
export interface ForeignTemplateDetail {
  /** The definition path holding the text (e.g., "globalArguments.message") */
  path: string;
  /** The template text (e.g., "{{host.name}}") */
  text: string;
}

/**
 * Describes where an env var is referenced in a model definition.
 */
export interface EnvVarUsageDetail {
  /** The definition path where the env var is used (e.g., "globalArguments.shell") */
  path: string;
  /** The env var name (e.g., "JENKINS_BASE_URL") */
  envVar: string;
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
 * Context for running check validations during `model validate`.
 */
export interface CheckValidationContext {
  repoDir: string;
  dataRepository: MethodContext["dataRepository"];
  definitionRepository: DefinitionRepository;
  dataQueryService?: DataQueryService;
  /**
   * Factory that builds a fresh cel-js Environment with swamp's baseline
   * registrations. Forwarded to `buildMethodContext` so the domain layer
   * does not import the cel-js binding directly. The application layer
   * (libswamp / CLI) supplies the implementation.
   */
  createCelEnvironment: MethodContext["createCelEnvironment"];
  /**
   * Resolves runtime expressions (vault.get, env.*) in arbitrary data.
   * When provided, globalArguments are resolved before passing to checks
   * so they see real secret values instead of raw expression text.
   */
  resolveRuntimeExpressions?: (data: unknown) => Promise<unknown>;
  labels?: string[];
  method?: string;
}

/**
 * Return type for model validation: results (pass/fail) plus warnings.
 */
export interface ModelValidationOutcome {
  results: ValidationResult[];
  warnings: ValidationWarning[];
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
   * @param checkContext - Optional context for running pre-flight checks
   * @returns Validation results and warnings
   */
  validateModel(
    definition: Definition,
    modelDef: ModelDefinition,
    definitionRepo?: DefinitionRepository,
    checkContext?: CheckValidationContext,
  ): Promise<ModelValidationOutcome>;
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
  async validateModel(
    definition: Definition,
    modelDef: ModelDefinition,
    definitionRepo?: DefinitionRepository,
    checkContext?: CheckValidationContext,
  ): Promise<ModelValidationOutcome> {
    const validations: Promise<ValidationResult>[] = [
      this.validateDefinitionSchema(definition),
      this.validateTypeVersion(definition),
      this.validateGlobalArguments(definition, modelDef),
      this.validateMethodArguments(definition, modelDef),
    ];

    // Template-like text: swamp's own expressions with the syntax slightly
    // wrong fail Expression paths; another service's syntax only warns.
    const templateScan = this.scanTemplateSyntax(definition, modelDef);

    // Add expression path validation if definitionRepo is provided
    if (definitionRepo) {
      validations.push(
        this.validateExpressionPaths(
          definition,
          modelDef,
          definitionRepo,
          templateScan.malformed,
        ),
      );
    }

    // Validate definition-level check selection (require/skip)
    validations.push(
      this.validateCheckSelection(definition, modelDef),
    );

    const results = await Promise.all(validations);

    // Run pre-flight checks if context provided and model has checks
    if (modelDef.checks && checkContext) {
      const checkResults = await this.runCheckValidations(
        definition,
        modelDef,
        checkContext,
      );
      results.push(...checkResults);
    }

    // Detect env var usage and generate warnings
    const warnings = [
      ...this.detectEnvVarUsage(definition),
      ...this.foreignTemplateWarnings(templateScan.foreign),
    ];

    return { results, warnings };
  }

  /**
   * Scans the authored globalArguments and method data for template-like
   * text, skipping fields the model type declares as foreign template text.
   */
  private scanTemplateSyntax(
    definition: Definition,
    modelDef: ModelDefinition,
  ): TemplateSyntaxScan {
    return scanTemplateSyntax(
      {
        globalArguments: definition.globalArguments,
        methods: definition.methodData,
      },
      {
        declaredInputs: new Set(
          Object.keys(definition.inputs?.properties ?? {}),
        ),
        isDeclaredForeign: foreignTemplatePathPredicate(modelDef),
      },
    );
  }

  /**
   * Returns a warning listing another service's template syntax, if any.
   */
  private foreignTemplateWarnings(
    foreign: TemplateSyntaxFinding[],
  ): ValidationWarning[] {
    if (foreign.length === 0) {
      return [];
    }
    return [
      ValidationWarning.foreignTemplateSyntax(
        foreign.map(({ path, text }) => ({ path, text })),
      ),
    ];
  }

  /**
   * Scans a definition for env var references and returns warnings if found.
   */
  private detectEnvVarUsage(definition: Definition): ValidationWarning[] {
    const usages = detectEnvVarUsageInDefinition(definition);
    if (usages.length === 0) {
      return [];
    }
    return [ValidationWarning.envVarUsage(usages)];
  }

  private async runCheckValidations(
    definition: Definition,
    modelDef: ModelDefinition,
    checkContext: CheckValidationContext,
  ): Promise<ValidationResult[]> {
    const checks = modelDef.checks!;
    const results: ValidationResult[] = [];
    const defChecks = definition.checkSelection;
    const skippedCheckNames = new Set(defChecks?.skip ?? []);

    // Resolve vault/env expressions in globalArguments so checks see real
    // values instead of raw ${{ vault.get(...) }} text. Falls back to the
    // raw definition values if resolution is unavailable or fails.
    let resolvedGlobalArgs = definition.globalArguments;
    if (checkContext.resolveRuntimeExpressions) {
      try {
        resolvedGlobalArgs = await checkContext.resolveRuntimeExpressions(
          definition.globalArguments,
        ) as Record<string, unknown>;
      } catch {
        // Vault may not be configured; degrade to unresolved values
      }
    }

    for (const [name, check] of Object.entries(checks)) {
      // Definition-level skip always wins
      if (skippedCheckNames.has(name)) {
        continue;
      }

      // Filter by labels if provided
      if (
        checkContext.labels && checkContext.labels.length > 0 &&
        (!check.labels ||
          !check.labels.some((l) => checkContext.labels!.includes(l)))
      ) {
        continue;
      }

      // Filter by method: if --method given, only run checks that apply to
      // that method. If no --method given, run all checks so that `model
      // validate` surfaces the same errors that method execution would.
      if (check.appliesTo && checkContext.method) {
        if (!check.appliesTo.includes(checkContext.method)) {
          continue;
        }
      }

      try {
        const methodName = checkContext.method ?? "";
        const rawMethodArgs = methodName
          ? definition.getMethodArguments(methodName)
          : {};
        const filteredGlobalArgs: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(resolvedGlobalArgs)) {
          if (valueContainsExpression(value)) {
            continue;
          }
          filteredGlobalArgs[key] = value;
        }

        const context = buildMethodContext(
          {
            dataRepository: checkContext.dataRepository,
            definitionRepository: checkContext.definitionRepository,
            dataQueryService: checkContext.dataQueryService,
            createCelEnvironment: checkContext.createCelEnvironment,
          },
          {
            signal: new AbortController().signal,
            repoDir: checkContext.repoDir,
            modelType: modelDef.type,
            modelId: definition.id,
            globalArgs: resolvedGlobalArgs,
            definition: {
              id: definition.id,
              name: definition.name,
              version: definition.version,
              tags: definition.tags,
            },
            methodName,
            logger: {
              debug() {},
              info() {},
              warn() {},
              error() {},
              fatal() {},
              with() {
                return this;
              },
            } as unknown as MethodContext["logger"],
            extensionFilesRoot: modelDef.extensionFilesRoot,
            unresolvedMethodArgs: {
              ...filteredGlobalArgs,
              ...rawMethodArgs,
            },
          },
        );

        const checkResult = await check.execute(context);
        if (!checkResult || typeof checkResult.pass !== "boolean") {
          results.push(
            ValidationResult.fail(
              `Check: ${name}`,
              "Check returned invalid result (expected { pass: boolean })",
            ),
          );
        } else if (checkResult.pass) {
          results.push(ValidationResult.pass(`Check: ${name}`));
        } else {
          const errors = checkResult.errors ?? ["Check failed"];
          results.push(
            ValidationResult.fail(`Check: ${name}`, errors.join("; ")),
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push(ValidationResult.fail(`Check: ${name}`, message));
      }
    }

    return results;
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

  /**
   * Checks that a recorded `typeVersion` parses as CalVer.
   *
   * `DefinitionSchema` deliberately types the field as a plain optional string
   * so a malformed value survives into the definition — `model get` has to be
   * able to name it, and discarding it would silently throw away something the
   * author expected to be read. That permissiveness means the schema check
   * above passes a value like `1.0`, so the format rule lives here instead,
   * where reporting it costs nothing.
   *
   * An absent `typeVersion` passes: it records that nobody stated which version
   * the arguments were authored for, which is a legitimate state for a
   * hand-written definition. `DefinitionUpgradeService` declines to migrate it
   * rather than guessing (swamp-club#2412).
   */
  private validateTypeVersion(
    definition: Definition,
  ): Promise<ValidationResult> {
    const recorded = definition.typeVersion;
    if (recorded === undefined || CalVer.isValid(recorded)) {
      return Promise.resolve(ValidationResult.pass("Type version"));
    }
    return Promise.resolve(
      ValidationResult.fail(
        "Type version",
        `typeVersion "${recorded}" is not a valid CalVer version. Expected ` +
          `format YYYY.MM.DD.MICRO (e.g. "2026.02.09.1"). Running a method ` +
          `against this definition will fail until it is corrected to the ` +
          `version its global arguments were authored for, or removed.`,
      ),
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

    // All fields are static — reject unknown keys explicitly so the check
    // also catches schemas wrapped in .refine()/.transform() (no .strict()
    // available on ZodEffects) and is not bypassed by prototype-chain keys.
    const globalArgsSchema = modelDef.globalArguments;
    const shape = getObjectShape(globalArgsSchema);
    if (shape) {
      const unknownKeys = Object.keys(staticArgs).filter(
        (k) => !Object.hasOwn(shape, k),
      );
      if (unknownKeys.length > 0) {
        const validKeys = Object.keys(shape).join(", ");
        return Promise.resolve(ValidationResult.fail(
          "Global arguments",
          `Unknown global argument(s): ${
            unknownKeys.join(", ")
          }. Valid arguments are: ${validKeys || "none"}`,
        ));
      }
    }
    const coerced = coerceMethodArgs(staticArgs, globalArgsSchema);
    // Use lenient validation: validate provided fields but don't require
    // missing ones. Direct execution and workflow steps create ephemeral
    // instances where not all globalArgs are needed (e.g. get/sync/delete
    // don't need creation-time fields). swamp model create has its own
    // strict validation in create.ts.
    const lenient = "partial" in globalArgsSchema &&
        typeof globalArgsSchema.partial === "function"
      ? (globalArgsSchema.partial() as z.ZodTypeAny)
      : globalArgsSchema;
    return this.validateWithSchema(
      "Global arguments",
      lenient,
      coerced,
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

      const methodArgsSchema = methodDef.arguments;
      const shape = getObjectShape(methodArgsSchema);
      if (shape) {
        const unknownKeys = Object.keys(staticArgs).filter(
          (k) => !Object.hasOwn(shape, k),
        );
        if (unknownKeys.length > 0) {
          const validKeys = Object.keys(shape).join(", ");
          errors.push(
            `Method "${methodName}": Unknown argument(s): ${
              unknownKeys.join(", ")
            }. Valid arguments are: ${validKeys || "none"}`,
          );
          continue;
        }
      }
      const coercedArgs = coerceMethodArgs(staticArgs, methodArgsSchema);
      const result = methodArgsSchema.safeParse(coercedArgs);
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
   * Also reports template-like text that swamp would claim as its own
   * expression once the syntax is fixed (a dropped `$` or a missing brace).
   */
  private async validateExpressionPaths(
    definition: Definition,
    modelDef: ModelDefinition,
    definitionRepo: DefinitionRepository,
    malformed: TemplateSyntaxFinding[],
  ): Promise<ValidationResult> {
    const errors: ExpressionPathError[] = malformed.map((m) => {
      const { issue, suggestion } = MALFORMED_EXPRESSION_MESSAGES[m.form];
      return {
        expression: m.text,
        error: `${issue} at "${m.path}"`,
        suggestion,
      };
    });

    // An unclosed expression already has its error; its references would
    // only add a second one for the same missing brace.
    const unclosed = new Set(
      malformed
        .filter((m) => m.form === "unclosed-expression")
        .map((m) => `${m.path}\0${m.text}`),
    );

    // Extract and validate all expressions from definition data
    const allExpressionData = {
      globalArguments: definition.globalArguments,
      methods: definition.methodData,
    };
    for (const exprLocation of extractExpressions(allExpressionData)) {
      const { celExpression, raw, path } = exprLocation;
      if (unclosed.has(`${path}\0${raw}`)) continue;

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

    // Check if it's a valid data function expression. The alternation is
    // derived from DATA_NAMESPACE_ACCESSORS rather than restated: this list
    // was hand-written and fell behind when query and findBySpec joined the
    // namespace, which rejected them in global arguments long after they
    // worked everywhere else.
    const dataFunctionPattern = new RegExp(
      `^data\\.(${dataAccessorAlternation()})\\(.*\\)`,
    );
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

    // Ensure the referenced type is fully loaded — without this,
    // lazy-registered types (catalog-known but not yet imported) cause
    // get() to return undefined even though has() reports them as registered.
    await modelRegistry.ensureTypeLoaded(result.type);
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
      return null;
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
   * Validates that definition-level check selection (require/skip) references
   * checks that exist on the model definition.
   */
  private validateCheckSelection(
    definition: Definition,
    modelDef: ModelDefinition,
  ): Promise<ValidationResult> {
    const errors: string[] = [];

    // Validate appliesTo references existing methods
    if (modelDef.checks) {
      const availableMethods = new Set(Object.keys(modelDef.methods));
      for (const [checkName, check] of Object.entries(modelDef.checks)) {
        if (check.appliesTo) {
          if (check.appliesTo.length === 0) {
            errors.push(
              `Check "${checkName}" has empty appliesTo array — it will never run. Remove appliesTo to run on all mutating methods`,
            );
          }
          for (const methodName of check.appliesTo) {
            if (!availableMethods.has(methodName)) {
              errors.push(
                `Check "${checkName}" references unknown method "${methodName}" in appliesTo`,
              );
            }
          }
        }
      }
    }

    const selection = definition.checkSelection;
    if (!selection && errors.length === 0) {
      return Promise.resolve(ValidationResult.pass("Check selection"));
    }

    const availableChecks = modelDef.checks
      ? new Set(Object.keys(modelDef.checks))
      : new Set<string>();

    // Validate required check names exist
    if (selection?.require) {
      for (const name of selection.require) {
        if (!availableChecks.has(name)) {
          errors.push(
            `Required check "${name}" not found on model type "${modelDef.type.normalized}"`,
          );
        }
      }
    }

    // Validate skipped check names exist
    if (selection?.skip) {
      for (const name of selection.skip) {
        if (!availableChecks.has(name)) {
          errors.push(
            `Skipped check "${name}" not found on model type "${modelDef.type.normalized}"`,
          );
        }
      }
    }

    // Warn about overlap between require and skip (skip wins)
    if (selection?.require && selection.skip) {
      const overlap = selection.require.filter((n) =>
        selection.skip!.includes(n)
      );
      for (const name of overlap) {
        errors.push(
          `Check "${name}" is in both require and skip lists — skip takes precedence`,
        );
      }
    }

    if (errors.length === 0) {
      return Promise.resolve(ValidationResult.pass("Check selection"));
    }

    return Promise.resolve(
      ValidationResult.fail("Check selection", errors.join("; ")),
    );
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
