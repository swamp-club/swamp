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
} from "../expressions/expression_parser.ts";
import {
  containsSwampExpression,
  foreignRootsBesideVault,
  isForeignExpression,
  isSwampExpression,
  unresolvableVaultArguments,
  WIDEST_SWAMP_SCOPE,
} from "../expressions/swamp_namespaces.ts";
import { vaultCallsForAnalysis } from "../expressions/vault_reference_extractor.ts";
import { detectEnvVarUsageInDefinition } from "./env_var_detector.ts";
import { foreignTemplatePathPredicate } from "./foreign_template_fields.ts";
import {
  scanTemplateSyntax,
  type TemplateSyntaxFinding,
  type TemplateSyntaxForm,
  type TemplateSyntaxScan,
} from "./template_syntax_scan.ts";
import { CalVer } from "./calver.ts";
import {
  findLiteralSensitiveGlobalArgs,
  literalSensitiveGlobalArgsMessage,
  maskRefusedIssues,
  schemaThrowMessage,
} from "./sensitive_field_extractor.ts";
import {
  DefinitionUpgradeService,
  MALFORMED_TYPE_VERSION_CODE,
} from "./definition_upgrade_service.ts";
import { UserError } from "../errors.ts";
import { outputSpecTags, reservedRunTagRefusal } from "./data_writer.ts";
import {
  coerceMethodArgs,
  getObjectShape,
  parseGlobalArgumentsLeniently,
} from "./zod_type_coercion.ts";
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
import { freeRoots, typeChecksAsConstant } from "../expressions/cel_grammar.ts";
import { maskLiteralCalls } from "../expressions/cel_string_lexer.ts";
import { argumentParseContext } from "../untrusted_parse.ts";
import {
  markModelWording,
  type WordedText,
  wordedText,
} from "../behavior_wording.ts";

function foreignTemplateRemedy(example: string): WordedText {
  return wordedText((w) =>
    `If this is another service's template syntax, pass it through with literal(), e.g. ${example}, or have the ${w.noun} type declare the field with .meta({ foreignTemplate: true }).`
  );
}

const MALFORMED_EXPRESSION_MESSAGES: Record<
  TemplateSyntaxForm,
  { issue: string; suggestion: string; remedy?: WordedText }
> = {
  "bare-double-brace": {
    issue: "Expression uses {{...}} instead of ${{...}}",
    suggestion: 'Add "$" prefix: ${{...}}.',
    remedy: foreignTemplateRemedy("${{ literal('{{name}}') }}"),
  },
  "single-brace": {
    issue: "Expression uses ${...} instead of ${{...}}",
    suggestion: "Use double braces: ${{...}}.",
    remedy: foreignTemplateRemedy("${{ literal('${name}') }}"),
  },
  "inside-expression": {
    issue: "Template text {{...}} inside a ${{...}} expression cuts it short",
    suggestion:
      "An expression ends at the first }} that is not inside a complete CEL string, and a string here is left open. Close the string, and pass the braces through with literal(), e.g. ${{ literal('{{name}}') }}.",
  },
  "unclosed-expression": {
    issue: "Unclosed ${{...}} expression",
    suggestion:
      "An expression ends at the first }} after its ${{ that is not inside a CEL string. This one is not valid CEL up to there, or has no }} at all, so a brace is probably missing or out of place. Close it with }} where it should end. If the ${{ is another service's text, pass it through with literal(), e.g. ${{ literal('${{') }}.",
  },
};

/**
 * Name of the warning for another service's template syntax. Agent guidance
 * and acceptance tests identify the warning by this name.
 */
export const FOREIGN_TEMPLATE_WARNING_NAME = "Template syntax passed through";

export function envVarWarningText(): WordedText {
  return wordedText((w) =>
    `Data stored under this ${w.noun} will vary depending on these environment variables at runtime. Consider using separate ${w.nouns} per environment, or vault.get() for sensitive values.`
  );
}

export class ValidationWarning {
  private constructor(
    readonly name: string,
    readonly message: string,
    readonly details?: EnvVarUsageDetail[],
    readonly templates?: ForeignTemplateDetail[],
    readonly modelMessage: string = message,
  ) {
    markModelWording(this, modelMessage);
  }

  static envVarUsage(
    envVars: EnvVarUsageDetail[],
  ): ValidationWarning {
    const worded = envVarWarningText();
    return new ValidationWarning(
      "Environment variables detected",
      worded.text,
      envVars,
      undefined,
      worded.modelText,
    );
  }

  static foreignTemplateSyntax(
    templates: ForeignTemplateDetail[],
  ): ValidationWarning {
    // `model` in the namespace list is the expression namespace, not a noun.
    const worded = wordedText((w) =>
      `This text is not a swamp expression and is passed to the method unchanged. If you meant a swamp expression, write \${{ ... }} and reference one of swamp's namespaces (model, self, inputs, env, vault, data). If it is another service's template syntax, the ${w.noun} type can declare the field with .meta({ foreignTemplate: true }) to silence this warning.`
    );
    return new ValidationWarning(
      FOREIGN_TEMPLATE_WARNING_NAME,
      worded.text,
      undefined,
      templates,
      worded.modelText,
    );
  }

  equals(other: ValidationWarning): boolean {
    return (
      this.name === other.name &&
      this.message === other.message &&
      this.modelMessage === other.modelMessage
    );
  }
}

export interface ForeignTemplateDetail {
  path: string;
  text: string;
}

export interface EnvVarUsageDetail {
  path: string;
  envVar: string;
}

export class ValidationResult {
  private constructor(
    readonly name: string,
    readonly passed: boolean,
    readonly error?: string,
    /**
     * The failed expressions behind an `Expression paths` failure, for
     * renderers that lay them out. `error` is derived from these, so value
     * equality on `error` covers them.
     */
    readonly expressionErrors?: readonly ExpressionPathError[],
    readonly modelError: string | undefined = error,
  ) {}

  static pass(name: string): ValidationResult {
    return new ValidationResult(name, true);
  }

  static fail(
    name: string,
    error: string,
    expressionErrors?: readonly ExpressionPathError[],
    modelError: string = error,
  ): ValidationResult {
    return new ValidationResult(
      name,
      false,
      error,
      expressionErrors,
      modelError,
    );
  }

  equals(other: ValidationResult): boolean {
    return (
      this.name === other.name &&
      this.passed === other.passed &&
      this.error === other.error
    );
  }
}

interface FormattedIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

function formatZodError(error: { issues: readonly FormattedIssue[] }): string {
  const describe = (issue: FormattedIssue) => {
    const path = issue.path.length > 0
      ? ` at "${issue.path.map(String).join(".")}"`
      : "";
    return `${issue.message}${path}`;
  };
  return error.issues.map(describe).join("; ");
}

export interface CheckValidationContext {
  repoDir: string;
  dataRepository: MethodContext["dataRepository"];
  definitionRepository: DefinitionRepository;
  dataQueryService?: DataQueryService;
  createCelEnvironment: MethodContext["createCelEnvironment"];
  /**
   * Resolves runtime expressions (vault.get, env.*) in arbitrary data.
   * When provided, globalArguments are resolved before passing to checks
   * so they see real secret values instead of raw expression text.
   */
  resolveRuntimeExpressions?: (data: unknown) => Promise<unknown>;
  /**
   * delivers check arguments through the typed-run refuse-then-load step; a
   * refused destination or failed load throws and every applicable check fails
   * with it. Supplied only for typed runs; else inline resolution.
   */
  deliverCheckArguments?: (
    definition: Definition,
    methodName: string,
  ) => Promise<CheckArgumentDelivery>;
  labels?: string[];
  method?: string;
}

export interface ModelValidationOutcome {
  results: ValidationResult[];
  warnings: ValidationWarning[];
}

export interface ModelValidationOptions {
  /**
   * global arguments as authored, when the definition holds evaluated values (a
   * workflow step's synthesized one); the template-syntax scan reads these so
   * evaluation-produced text is never flagged
   */
  authoredGlobalArguments?: Record<string, unknown>;
  /**
   * fail Global arguments on a literal secret in a sensitive field; set only
   * for the definition as stored, since a resolved copy may hold plaintext read
   * through data where the stored one holds a vault reference
   */
  refuseLiteralSensitiveGlobals?: boolean;
  /**
   * static typed-secrets misuse diagnostics per authored expression, supplied
   * for typed runs; findings name a location and code, never a value. Absent,
   * no Secret usage validation runs.
   */
  diagnoseSecretMisuse?: (
    expression: string,
    location: string,
    embedded?: boolean,
  ) => readonly SecretMisuseFinding[];
  /**
   * validate as a run of this method: checks read only the global arguments and
   * this method's arguments; another method's problems are its own run's to
   * fail. Ignored for an undefined method.
   */
  method?: string;
}

export interface SecretMisuseFinding {
  readonly location: string;
  readonly code: string;
  readonly reason: string;
}

export interface CheckArgumentDelivery {
  globalArgs: Record<string, unknown>;
  unresolvedMethodArgs: Record<string, unknown>;
  vaultSecrets?: MethodContext["vaultSecrets"];
}

export interface ModelValidationService {
  validateModel(
    definition: Definition,
    modelDef: ModelDefinition,
    definitionRepo?: DefinitionRepository,
    checkContext?: CheckValidationContext,
    options?: ModelValidationOptions,
  ): Promise<ModelValidationOutcome>;
}

export interface ExpressionPathError {
  expression: string;
  error: string;
  code?: string;
  location?: string;
  suggestion?: string;
  /**
   * Optional fix shared by every error of the same form, printed once after
   * the list of errors rather than once per error.
   */
  remedy?: string;
  availableKeys?: string[];
}

export function distinctRemedies(
  errors: readonly ExpressionPathError[],
): string[] {
  return [
    ...new Set(
      errors.flatMap((err) => err.remedy === undefined ? [] : [err.remedy]),
    ),
  ];
}

export function formatExpressionPathErrors(
  errors: readonly ExpressionPathError[],
): string {
  const lines: string[] = [];
  for (const err of errors) {
    lines.push(`- ${err.expression}`, `  ${err.error}`);
    if (err.suggestion) lines.push(`  ${err.suggestion}`);
    if (err.availableKeys?.length) {
      lines.push(`  Available: ${formatAvailableKeys(err.availableKeys)}`);
    }
  }
  for (const remedy of distinctRemedies(errors)) lines.push(remedy);
  return lines.join("\n");
}

/**
 * a module-private symbol on a non-enumerable property, so JSON output never
 * sees the model-words counterpart
 */
const MODEL_SPELLING = Symbol("swamp.expressionPathErrorModelSpelling");

function wordedPathError(
  base: Omit<ExpressionPathError, "error" | "remedy">,
  error: WordedText,
  remedy?: WordedText,
): ExpressionPathError {
  const inWords = (
    pick: (worded: WordedText) => string,
  ): ExpressionPathError => ({
    ...base,
    error: pick(error),
    ...(remedy === undefined ? {} : { remedy: pick(remedy) }),
  });
  const behavior = inWords((worded) => worded.text);
  Object.defineProperty(behavior, MODEL_SPELLING, {
    value: inWords((worded) => worded.modelText),
    enumerable: false,
    writable: false,
    configurable: true,
  });
  return behavior;
}

export function expressionPathErrorInModelWords(
  error: ExpressionPathError,
): ExpressionPathError {
  const counterpart = (error as unknown as Record<symbol, unknown>)[
    MODEL_SPELLING
  ];
  return (counterpart as ExpressionPathError | undefined) ?? error;
}

/**
 * the method arguments a run of method is delivered: that method's subtree
 * alone, or all when none is selected. Pruned at the method key, so it holds
 * however a scanner spells paths.
 */
function deliveredMethodData(
  definition: Definition,
  method: string | undefined,
): Definition["methodData"] {
  const methodData = definition.methodData;
  if (method === undefined) return methodData;
  return Object.hasOwn(methodData, method)
    ? { [method]: methodData[method] }
    : {};
}

/**
 * global arguments parsed by the type's schema as a method run does before its
 * checks, leaving swamp expressions as written; a refused or throwing parse
 * leaves values as given for Global arguments to report
 */
function parsedForChecks(
  modelDef: ModelDefinition,
  globalArgs: Record<string, unknown>,
): Record<string, unknown> {
  const schema = modelDef.globalArguments;
  if (!schema) return globalArgs;
  const unresolvedKeys = new Set(
    Object.keys(globalArgs).filter((key) =>
      containsSwampExpression(globalArgs[key])
    ),
  );
  // fromEntries defines own properties, so a "__proto__" key stays a key.
  const resolved = Object.fromEntries(
    Object.entries(globalArgs).filter(([key]) => !unresolvedKeys.has(key)),
  );
  let result: ReturnType<typeof parseGlobalArgumentsLeniently>;
  try {
    result = parseGlobalArgumentsLeniently(
      schema,
      coerceMethodArgs(resolved, schema),
      unresolvedKeys,
    );
  } catch {
    return globalArgs;
  }
  return result.success ? { ...globalArgs, ...result.data } : globalArgs;
}

export class DefaultModelValidationService implements ModelValidationService {
  /**
   * reads a stored definition as a run would save it: an upgrade can move a
   * literal into a sensitive field, so only the upgraded copy is read when one
   * applies; the stored copy otherwise, or if the upgrade throws
   */
  findLiteralSensitiveGlobals(
    definition: Definition,
    modelDef: ModelDefinition,
  ): string[] {
    let saved = definition;
    try {
      const upgrade = new DefinitionUpgradeService().upgrade(
        definition,
        modelDef,
      );
      if (upgrade.upgraded) saved = upgrade.definition;
    } catch {
      // The run fails on the same upgrade; the stored copy is what stays.
    }
    return findLiteralSensitiveGlobalArgs(
      modelDef.globalArguments,
      saved.globalArguments,
    );
  }

  async validateModel(
    definition: Definition,
    modelDef: ModelDefinition,
    definitionRepo?: DefinitionRepository,
    checkContext?: CheckValidationContext,
    options?: ModelValidationOptions,
  ): Promise<ModelValidationOutcome> {
    // Global arguments and checks read static arguments as a method run would,
    // after the in-memory upgrade chain, never saved; every other check reads
    // the definition as authored
    const upgrade = this.upgradeInMemory(definition, modelDef);
    const leakedArgs = options?.refuseLiteralSensitiveGlobals
      ? this.findLiteralSensitiveGlobals(definition, modelDef)
      : [];
    const globalArgsResult = upgrade.failure
      ? Promise.resolve(upgrade.failure)
      : this.validateGlobalArguments(upgrade.definition, modelDef);
    const method = options?.method !== undefined &&
        Object.hasOwn(modelDef.methods, options.method)
      ? options.method
      : undefined;
    const methodData = deliveredMethodData(definition, method);
    const validations: Promise<ValidationResult>[] = [
      this.validateDefinitionSchema(definition),
      this.validateTypeVersion(definition),
      leakedArgs.length > 0
        ? globalArgsResult.then((result) =>
          ValidationResult.fail(
            "Global arguments",
            [
              literalSensitiveGlobalArgsMessage(leakedArgs),
              ...(result.passed || !result.error ? [] : [result.error]),
            ].join("\n"),
          )
        )
        : globalArgsResult,
      this.validateMethodArguments(methodData, modelDef),
    ];

    // Template-like text: swamp's own expressions with the syntax slightly
    // wrong fail Expression paths; another service's syntax only warns.
    const templateScan = this.scanTemplateSyntax(
      definition,
      methodData,
      modelDef,
      options?.authoredGlobalArguments,
    );

    // Add expression path validation if definitionRepo is provided. It also
    // collects ${{ ... }} text written for another templating system, which
    // joins the template-syntax warning rather than failing.
    const foreignExpressions: ForeignTemplateDetail[] = [];
    if (definitionRepo) {
      validations.push(
        this.validateExpressionPaths(
          definition,
          methodData,
          modelDef,
          definitionRepo,
          templateScan.malformed,
          foreignExpressions,
        ),
      );
    }

    if (options?.diagnoseSecretMisuse) {
      validations.push(
        Promise.resolve(
          this.validateSecretUsage(
            definition,
            methodData,
            options.diagnoseSecretMisuse,
          ),
        ),
      );
    }

    validations.push(
      this.validateCheckSelection(definition, modelDef),
    );

    validations.push(this.validateTags(definition, modelDef));

    const results = await Promise.all(validations);

    if (
      modelDef.checks && checkContext &&
      !results.some((result) =>
        result.name === "Secret usage" && !result.passed
      )
    ) {
      const checkResults = await this.runCheckValidations(
        upgrade.definition,
        modelDef,
        checkContext,
      );
      results.push(...checkResults);
    }

    const warnings = [
      ...this.detectEnvVarUsage(definition),
      ...this.foreignTemplateWarnings([
        ...templateScan.foreign.map(({ path, text }) => ({ path, text })),
        ...foreignExpressions,
      ]),
    ];

    return { results, warnings };
  }

  /**
   * applies the upgrade chain to a copy, as a run does; a throwing upgrade
   * fails Global arguments. Arguments holding swamp expressions are left as
   * written, since the run upgrades their evaluated values.
   */
  private upgradeInMemory(
    definition: Definition,
    modelDef: ModelDefinition,
  ): { definition: Definition; failure?: ValidationResult } {
    if (containsSwampExpression(definition.globalArguments)) {
      return { definition };
    }
    try {
      return {
        definition: new DefinitionUpgradeService().upgrade(definition, modelDef)
          .definition,
      };
    } catch (error) {
      if (
        error instanceof UserError &&
        error.code === MALFORMED_TYPE_VERSION_CODE
      ) {
        return { definition };
      }
      const message = error instanceof Error ? error.message : String(error);
      return {
        definition,
        failure: ValidationResult.fail(
          "Global arguments",
          `Upgrading from typeVersion ${definition.typeVersion} to ` +
            `${modelDef.version} failed: ${message}`,
        ),
      };
    }
  }

  private scanTemplateSyntax(
    definition: Definition,
    methodData: Definition["methodData"],
    modelDef: ModelDefinition,
    authoredGlobalArguments?: Record<string, unknown>,
  ): TemplateSyntaxScan {
    return scanTemplateSyntax(
      {
        globalArguments: authoredGlobalArguments ??
          definition.globalArguments,
        methods: methodData,
      },
      {
        declaredInputs: new Set(
          Object.keys(definition.inputs?.properties ?? {}),
        ),
        isDeclaredForeign: foreignTemplatePathPredicate(modelDef),
      },
    );
  }

  private foreignTemplateWarnings(
    foreign: ForeignTemplateDetail[],
  ): ValidationWarning[] {
    if (foreign.length === 0) {
      return [];
    }
    return [ValidationWarning.foreignTemplateSyntax(foreign)];
  }

  private detectEnvVarUsage(definition: Definition): ValidationWarning[] {
    const usages = detectEnvVarUsageInDefinition(definition);
    if (usages.length === 0) {
      return [];
    }
    return [ValidationWarning.envVarUsage(usages)];
  }

  private validateSecretUsage(
    definition: Definition,
    methodData: Definition["methodData"],
    diagnose: NonNullable<ModelValidationOptions["diagnoseSecretMisuse"]>,
  ): ValidationResult {
    const errors: ExpressionPathError[] = [];
    const data = {
      globalArguments: definition.globalArguments,
      methods: methodData,
    };
    for (
      const { celExpression, raw, path, embedded } of extractExpressions(data)
    ) {
      for (const finding of diagnose(celExpression, path, embedded)) {
        errors.push({
          expression: raw,
          code: finding.code,
          location: finding.location,
          error: `${finding.code} at "${finding.location}": ${finding.reason}`,
        });
      }
    }
    if (errors.length === 0) return ValidationResult.pass("Secret usage");
    return ValidationResult.fail(
      "Secret usage",
      formatExpressionPathErrors(errors),
      errors,
    );
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
    const methodName = checkContext.method ?? "";

    const applicable = Object.entries(checks).filter(([name, check]) => {
      // Definition-level skip always wins
      if (skippedCheckNames.has(name)) return false;
      if (
        checkContext.labels && checkContext.labels.length > 0 &&
        (!check.labels ||
          !check.labels.some((l) => checkContext.labels!.includes(l)))
      ) {
        return false;
      }
      // Filter by method: if --method given, only run checks that apply to
      // that method. If no --method given, run all checks so that `model
      // validate` surfaces the same errors that method execution would.
      return !(check.appliesTo && checkContext.method &&
        !check.appliesTo.includes(checkContext.method));
    });

    // No check to run means nothing to deliver: no probe, no load.
    if (applicable.length === 0) return results;

    // What the checks receive. In a typed run the shared delivery step
    // provides it, and a refusal or a failed load fails every applicable
    // check: nothing is delivered. Otherwise vault/env expressions in
    // globalArguments are resolved inline so checks see real values instead
    // of raw ${{ vault.get(...) }} text, falling back to the raw definition
    // values if resolution is unavailable or fails.
    let resolvedGlobalArgs = definition.globalArguments;
    let delivered: CheckArgumentDelivery | undefined;
    if (checkContext.deliverCheckArguments) {
      try {
        delivered = await checkContext.deliverCheckArguments(
          definition,
          methodName,
        );
        resolvedGlobalArgs = delivered.globalArgs;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return [ValidationResult.fail("Check argument delivery", message)];
      }
    } else if (checkContext.resolveRuntimeExpressions) {
      try {
        resolvedGlobalArgs = await checkContext.resolveRuntimeExpressions(
          definition.globalArguments,
        ) as Record<string, unknown>;
      } catch {
        // Vault may not be configured; degrade to unresolved values
      }
    }
    resolvedGlobalArgs = parsedForChecks(modelDef, resolvedGlobalArgs);

    for (const [name, check] of applicable) {
      try {
        const rawMethodArgs = methodName
          ? definition.getMethodArguments(methodName)
          : {};
        const filteredGlobalArgs: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(resolvedGlobalArgs)) {
          if (containsSwampExpression(value)) {
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
            vaultSecrets: delivered?.vaultSecrets,
            unresolvedMethodArgs: delivered?.unresolvedMethodArgs ?? {
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
   * DefinitionSchema keeps typeVersion a plain string so a malformed value
   * survives for model get to name, so CalVer is checked here. An absent
   * typeVersion passes: the upgrade service declines to migrate it.
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
    if (!modelDef.globalArguments) {
      return Promise.resolve(ValidationResult.pass("Global arguments"));
    }

    // Strip fields that contain expressions - they will be validated after evaluation.
    // Only validate the static (non-expression) fields against the schema.
    // Another templating system's ${{ ... }} text is a value, not an
    // expression, and the run schema-checks it, so it stays in.
    const staticArgs = stripExpressionFields(
      definition.globalArguments,
      containsSwampExpression,
    );

    // If any fields were stripped (contain expressions), skip schema validation entirely.
    // Expression paths are validated separately, and full schema validation will happen
    // at runtime when the evaluated definition is executed.
    const totalFields = Object.keys(definition.globalArguments).length;
    const staticFields = Object.keys(staticArgs).length;
    if (staticFields < totalFields) {
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
    // lenient: validate provided fields, don't require missing ones, since
    // direct execution and steps create ephemeral instances (create has its own
    // strict check). Failures are described as a run's refusal is.
    let result: ReturnType<typeof parseGlobalArgumentsLeniently>;
    try {
      result = parseGlobalArgumentsLeniently(globalArgsSchema, coerced);
    } catch (error) {
      return Promise.resolve(ValidationResult.fail(
        "Global arguments",
        schemaThrowMessage(error, globalArgsSchema, "Global arguments"),
      ));
    }
    return Promise.resolve(
      result.success
        ? ValidationResult.pass("Global arguments")
        : ValidationResult.fail(
          "Global arguments",
          formatZodError({
            issues: maskRefusedIssues(globalArgsSchema, coerced, result.issues),
          }),
        ),
    );
  }

  private validateMethodArguments(
    methodData: Definition["methodData"],
    modelDef: ModelDefinition,
  ): Promise<ValidationResult> {
    const errors: string[] = [];

    for (const [methodName, methodDef] of Object.entries(modelDef.methods)) {
      const args = methodData[methodName]?.arguments;
      if (!args) continue;

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
      // described as a run's refusal is, so the schema's own code cannot spell
      // a sensitive value here, and a schema that throws while parsing is
      // reported as a run reports it
      let result: ReturnType<typeof methodArgsSchema.safeParse>;
      try {
        result = methodArgsSchema.safeParse(
          coercedArgs,
          argumentParseContext(),
        );
      } catch (error) {
        errors.push(
          `Method "${methodName}": ${
            schemaThrowMessage(error, methodArgsSchema, "Method arguments")
          }`,
        );
        continue;
      }
      if (!result.success) {
        const described = formatZodError({
          issues: maskRefusedIssues(
            methodArgsSchema,
            coercedArgs,
            result.error.issues,
          ),
        });
        errors.push(`Method "${methodName}": ${described}`);
      }
    }

    if (errors.length === 0) {
      return Promise.resolve(ValidationResult.pass("Method arguments"));
    }

    return Promise.resolve(
      ValidationResult.fail("Method arguments", errors.join("; ")),
    );
  }

  private async validateExpressionPaths(
    definition: Definition,
    methodData: Definition["methodData"],
    modelDef: ModelDefinition,
    definitionRepo: DefinitionRepository,
    malformed: TemplateSyntaxFinding[],
    foreign: ForeignTemplateDetail[],
  ): Promise<ValidationResult> {
    const errors: ExpressionPathError[] = malformed.map((m) => {
      const { issue, suggestion, remedy } =
        MALFORMED_EXPRESSION_MESSAGES[m.form];
      return wordedPathError(
        { expression: m.text, suggestion },
        wordedText(() => `${issue} at "${m.path}"`),
        remedy,
      );
    });

    // An unclosed expression already has its error; its references would
    // only add a second one for the same missing brace.
    const unclosed = new Set(
      malformed
        .filter((m) => m.form === "unclosed-expression")
        .map((m) => `${m.path}\0${m.text}`),
    );

    const allExpressionData = {
      globalArguments: definition.globalArguments,
      methods: methodData,
    };
    const isDeclaredForeign = foreignTemplatePathPredicate(modelDef);
    for (const exprLocation of extractExpressions(allExpressionData)) {
      const { celExpression, raw, path } = exprLocation;
      if (unclosed.has(`${path}\0${raw}`)) continue;

      // Another system's ${{ }} text passes through, classified before the
      // reference checks that would misread it and judged by the run-time
      // guard's scope.
      if (
        isForeignExpression(celExpression) &&
        !await this.namesModel(celExpression, definitionRepo)
      ) {
        if (!isDeclaredForeign(path)) foreign.push({ path, text: raw });
        continue;
      }

      // An unquoted vault.get argument holding a "." is evaluated as CEL, so
      // one that reads nothing swamp provides fails when the run resolves it.
      for (const arg of unresolvableVaultArguments(celExpression)) {
        errors.push({
          expression: raw,
          error:
            `vault.get argument "${arg}" at "${path}" is evaluated as an expression because it contains ".", and it reads nothing swamp provides`,
          suggestion:
            `Quote it to use it as a literal name: '${arg}'. To compute the name instead, reference a swamp namespace, e.g. inputs.secretKey.`,
        });
      }

      // An expression that reads vault is always evaluated, so a root swamp
      // does not provide fails the run instead of passing through. A root
      // that names one of this repo's models still gets the missing "model."
      // prefix error below.
      const beside = foreignRootsBesideVault(celExpression);
      if (
        beside.length > 0 &&
        !await this.namesModel(celExpression, definitionRepo)
      ) {
        errors.push({
          expression: raw,
          error:
            `Expression "${celExpression}" at "${path}" reads vault, so swamp evaluates all of it, but it also reads ${
              beside.map((root) => `"${root}"`).join(", ")
            }, which swamp does not provide`,
          suggestion:
            "Reference only swamp's namespaces (model, self, inputs, env, vault, data) in an expression that reads vault. Put another templating system's text in its own ${{ ... }}, or pass it through with literal().",
        });
        continue;
      }

      const pathRefs = extractPathReferences(celExpression);
      const modelErrors = await Promise.all(
        pathRefs.map((ref) =>
          this.validateModelPathReference(ref, definitionRepo)
        ),
      );
      errors.push(
        ...modelErrors.filter((e): e is ExpressionPathError => e !== null),
      );

      const selfRefs = extractSelfReferences(celExpression);
      const selfErrors = selfRefs
        .map((ref) => this.validateSelfPathReference(ref, modelDef))
        .filter((e): e is ExpressionPathError => e !== null);
      errors.push(...selfErrors);

      const envRefs = extractEnvReferences(celExpression);

      const hasInputsRef = /\binputs\./.test(maskLiteralCalls(celExpression));

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

    return ValidationResult.fail(
      "Expression paths",
      formatExpressionPathErrors(errors),
      errors,
      formatExpressionPathErrors(errors.map(expressionPathErrorInModelWords)),
    );
  }

  private async namesModel(
    celExpression: string,
    definitionRepo: DefinitionRepository,
  ): Promise<boolean> {
    const root = celExpression.match(/^([a-zA-Z][a-zA-Z0-9_-]*)/)?.[1];
    return root !== undefined &&
      await definitionRepo.findByNameGlobal(root) !== null;
  }

  private validateExpressionContent(
    celExpression: string,
    rawExpression: string,
    path: string,
  ): ExpressionPathError | null {
    const looksLikeValidCel = /^[\d"'\[\{(]|^true$|^false$|^null$/.test(
      celExpression,
    );
    if (looksLikeValidCel) {
      return null;
    }

    // an expression reading nothing, like literal('{{a}}') + ' x', always
    // evaluates to the same value, so it is valid when every function it calls
    // exists: not now(), not literal(123)
    if (
      freeRoots(celExpression)?.size === 0 &&
      typeChecksAsConstant(celExpression)
    ) {
      return null;
    }

    // Check if it's a valid vault expression: one that is a vault.get(...)
    // call from end to end, or that holds one written as code anywhere and
    // reads only swamp's namespaces (vault.get(t, KEY) + "-x",
    // int(vault.get(t, PORT))).
    const vaultPattern = /^vault\.get\(.*\)$/;
    if (
      vaultPattern.test(celExpression) ||
      (vaultCallsForAnalysis(celExpression).length > 0 &&
        isSwampExpression(celExpression, WIDEST_SWAMP_SCOPE))
    ) {
      return null;
    }

    const fileContentsPattern = /^file\.contents\(.*\)/;
    if (fileContentsPattern.test(celExpression)) {
      return null;
    }

    // the alternation is derived from DATA_NAMESPACE_ACCESSORS, not restated,
    // so new accessors are not rejected in global arguments
    const dataFunctionPattern = new RegExp(
      `^data\\.(${dataAccessorAlternation()})\\(.*\\)`,
    );
    if (dataFunctionPattern.test(celExpression)) {
      return null;
    }

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

    return {
      expression: rawExpression,
      error:
        `Expression "${celExpression}" at "${path}" does not contain valid model, self, or env references`,
      suggestion:
        "Expressions should use: model.<name>.resource.<specName>.<instanceName>.attributes.<property>, model.<name>.definition.globalArguments.<property>, self.globalArguments.<property>, or env.<VARIABLE_NAME>",
    };
  }

  private async validateModelPathReference(
    ref: {
      modelRef: string;
      type: DependencyType;
      path: string[];
      rawExpression: string;
    },
    definitionRepo: DefinitionRepository,
  ): Promise<ExpressionPathError | null> {
    const result = await definitionRepo.findByNameGlobal(ref.modelRef);
    if (!result) {
      return wordedPathError(
        { expression: ref.rawExpression },
        wordedText((w) => `Referenced ${w.noun} "${ref.modelRef}" not found`),
      );
    }

    // ensure the type is fully loaded: lazy-registered types make get() return
    // undefined even though has() reports them
    await modelRegistry.ensureTypeLoaded(result.type);
    const targetDefinition = modelRegistry.get(result.type);
    if (!targetDefinition) {
      return wordedPathError(
        { expression: ref.rawExpression },
        wordedText((w) =>
          `Unknown ${w.noun} type "${result.type.normalized}" for ${w.noun} "${ref.modelRef}"`
        ),
      );
    }

    const firstSegment = ref.path[0];

    if (ref.path.length === 0) {
      return null;
    }

    if (ref.type === "resource") {
      const specName = firstSegment;
      const availableSpecs = targetDefinition.resources
        ? Object.keys(targetDefinition.resources)
        : [];

      if (availableSpecs.length > 0 && !availableSpecs.includes(specName)) {
        return wordedPathError(
          {
            expression: ref.rawExpression,
            suggestion: `Available resource specs: ${
              availableSpecs.join(", ")
            }`,
          },
          wordedText((w) =>
            `Unknown resource spec "${specName}" on ${w.noun} "${ref.modelRef}"`
          ),
        );
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

    if (ref.type === "file") {
      const specName = firstSegment;
      const availableSpecs = targetDefinition.files
        ? Object.keys(targetDefinition.files)
        : [];

      if (availableSpecs.length > 0 && !availableSpecs.includes(specName)) {
        return wordedPathError(
          {
            expression: ref.rawExpression,
            suggestion: `Available file specs: ${availableSpecs.join(", ")}`,
          },
          wordedText((w) =>
            `Unknown file spec "${specName}" on ${w.noun} "${ref.modelRef}"`
          ),
        );
      }

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

    const pathToValidate = ref.path.slice(1);
    if (pathToValidate.length === 0) {
      return null;
    }

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
   * fails when definition tags or a spec's default tags use the reserved
   * _swamp. prefix, which every method run refuses
   */
  private validateTags(
    definition: Definition,
    modelDef: ModelDefinition,
  ): Promise<ValidationResult> {
    const refusal = reservedRunTagRefusal({
      modelType: modelDef.type,
      definitionTags: definition.tags,
      specs: outputSpecTags(modelDef),
    });
    return Promise.resolve(
      refusal
        ? ValidationResult.fail(
          "Tags",
          refusal.text,
          undefined,
          refusal.modelText,
        )
        : ValidationResult.pass("Tags"),
    );
  }

  private validateCheckSelection(
    definition: Definition,
    modelDef: ModelDefinition,
  ): Promise<ValidationResult> {
    const errors: WordedText[] = [];

    if (modelDef.checks) {
      const availableMethods = new Set(Object.keys(modelDef.methods));
      for (const [checkName, check] of Object.entries(modelDef.checks)) {
        if (check.appliesTo) {
          if (check.appliesTo.length === 0) {
            errors.push(
              wordedText(() =>
                `Check "${checkName}" has empty appliesTo array — it will never run. Remove appliesTo to run on all mutating methods`
              ),
            );
          }
          for (const methodName of check.appliesTo) {
            if (!availableMethods.has(methodName)) {
              errors.push(
                wordedText(() =>
                  `Check "${checkName}" references unknown method "${methodName}" in appliesTo`
                ),
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

    if (selection?.require) {
      for (const name of selection.require) {
        if (!availableChecks.has(name)) {
          errors.push(
            wordedText((w) =>
              `Required check "${name}" not found on ${w.noun} type "${modelDef.type.normalized}"`
            ),
          );
        }
      }
    }

    if (selection?.skip) {
      for (const name of selection.skip) {
        if (!availableChecks.has(name)) {
          errors.push(
            wordedText((w) =>
              `Skipped check "${name}" not found on ${w.noun} type "${modelDef.type.normalized}"`
            ),
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
          wordedText(() =>
            `Check "${name}" is in both require and skip lists — skip takes precedence`
          ),
        );
      }
    }

    if (errors.length === 0) {
      return Promise.resolve(ValidationResult.pass("Check selection"));
    }

    return Promise.resolve(
      ValidationResult.fail(
        "Check selection",
        errors.map((e) => e.text).join("; "),
        undefined,
        errors.map((e) => e.modelText).join("; "),
      ),
    );
  }
}
