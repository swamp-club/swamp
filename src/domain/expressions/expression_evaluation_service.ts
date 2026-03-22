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

import type { ModelType } from "../models/model_type.ts";
import type { Definition } from "../definitions/definition.ts";
import { Definition as DefinitionClass } from "../definitions/definition.ts";
import type { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { CelEvaluator } from "../../infrastructure/cel/cel_evaluator.ts";
import {
  containsExpression,
  extractExpressions,
  replaceExpressions,
} from "./expression_parser.ts";
import type { ExpressionLocation } from "./expression.ts";
import {
  extractDependencies,
  extractModelRefs,
} from "./dependency_extractor.ts";
import {
  buildEnvContext,
  type ExpressionContext,
  ModelResolver,
  type ModelResolverRepositories,
} from "./model_resolver.ts";
import { CyclicDependencyError } from "./errors.ts";
import type { SecretRedactor } from "../secrets/mod.ts";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import {
  CyclicDependencyError as TopoCyclicError,
  type GraphNode,
  TopologicalSortService,
} from "../workflows/topological_sort_service.ts";

/**
 * Pattern to detect vault.get() references inside a CEL expression.
 */
const VAULT_GET_PATTERN = /vault\.get\s*\(/;

/**
 * Pattern to detect env.* references inside a CEL expression.
 */
const ENV_PATTERN = /\benv\./;

/**
 * Checks whether a CEL expression references vault.get().
 * Expressions containing vault references must NOT be evaluated during
 * the persist phase — they are resolved at runtime only.
 */
export function containsVaultExpression(celExpression: string): boolean {
  return VAULT_GET_PATTERN.test(celExpression);
}

/**
 * Checks whether a CEL expression references env.* variables.
 * Expressions containing env references must NOT be evaluated during
 * the persist phase — they are resolved at runtime only.
 */
export function containsEnvExpression(celExpression: string): boolean {
  return ENV_PATTERN.test(celExpression);
}

/**
 * Checks whether a CEL expression contains any runtime-only references
 * (vault or env). Expressions matching this check are deferred to runtime
 * and skipped during the persist phase.
 */
export function containsRuntimeExpression(celExpression: string): boolean {
  return containsVaultExpression(celExpression) ||
    containsEnvExpression(celExpression);
}

/**
 * Result of resolving runtime expressions in a definition.
 * Includes the resolved definition and a VaultSecretBag containing
 * sentinel-to-value mappings for any vault secrets encountered.
 */
export interface RuntimeResolutionResult {
  definition: Definition;
  secretBag: VaultSecretBag;
}

/**
 * Result of evaluating a single definition.
 */
export interface EvaluatedDefinition {
  definition: Definition;
  type: ModelType;
  /** Whether any expressions were evaluated */
  hadExpressions: boolean;
}

/**
 * Domain service for evaluating CEL expressions in model definitions.
 */
export class ExpressionEvaluationService {
  private readonly celEvaluator: CelEvaluator;
  private readonly sortService: TopologicalSortService;
  private readonly modelResolver: ModelResolver;
  private readonly definitionRepo: YamlDefinitionRepository;

  constructor(
    definitionRepo: YamlDefinitionRepository,
    repoDir?: string,
    repos?: ModelResolverRepositories,
  ) {
    this.celEvaluator = new CelEvaluator();
    this.sortService = new TopologicalSortService();
    this.definitionRepo = definitionRepo;
    this.modelResolver = new ModelResolver(definitionRepo, {
      repoDir,
      ...repos,
    });
  }

  private checkForExpressions(data: unknown): boolean {
    if (typeof data === "string") {
      return containsExpression(data);
    } else if (Array.isArray(data)) {
      return data.some((item) => this.checkForExpressions(item));
    } else if (data !== null && typeof data === "object") {
      return Object.values(data).some((value) =>
        this.checkForExpressions(value)
      );
    }
    return false;
  }

  /**
   * Evaluates expressions in arbitrary data with the given context.
   * Used for workflow evaluation.
   *
   * @param data - The data containing expressions
   * @param context - The evaluation context
   * @returns The data with expressions replaced
   */
  evaluateData(
    data: unknown,
    context: ExpressionContext,
  ): unknown {
    const expressions = extractExpressions(data);
    if (expressions.length === 0) {
      return data;
    }

    // Evaluate CEL-only expressions; skip runtime expressions (vault, env)
    const evaluatedValues = new Map<string, unknown>();
    for (const expr of expressions) {
      if (containsRuntimeExpression(expr.celExpression)) {
        continue;
      }

      const value = this.celEvaluator.evaluate(expr.celExpression, context);
      evaluatedValues.set(expr.raw, value);
    }

    return replaceExpressions(data, evaluatedValues);
  }

  /**
   * Evaluates expressions in a single definition.
   *
   * @param definition - The definition to evaluate
   * @param type - The model type
   * @param inputValues - Optional input values to use in expression evaluation
   * @param context - Optional pre-built context (for batch evaluation)
   * @returns The evaluated definition
   */
  async evaluateDefinition(
    definition: Definition,
    type: ModelType,
    inputValues?: Record<string, unknown>,
    context?: ExpressionContext,
  ): Promise<EvaluatedDefinition> {
    // Build context if not provided
    const ctx = context ?? await this.modelResolver.buildContext();

    // Add inputs to context if provided
    if (inputValues) {
      ctx.inputs = inputValues;
    }

    // Add self reference for the definition
    ctx.self = {
      id: definition.id,
      name: definition.name,
      version: definition.version,
      tags: definition.tags,
      globalArguments: definition.globalArguments,
    };

    // Extract expressions from definition data
    const definitionData = definition.toData();
    const expressions = extractExpressions(definitionData);

    if (expressions.length === 0) {
      return { definition, type, hadExpressions: false };
    }

    // Evaluate CEL-only expressions; skip runtime expressions (vault, env)
    // Runtime expressions are resolved at runtime only, never persisted
    const evaluatedValues = new Map<string, unknown>();
    for (const expr of expressions) {
      if (containsRuntimeExpression(expr.celExpression)) {
        // Leave runtime expressions (vault, env, and mixed) as raw
        continue;
      }

      // Skip expressions referencing model resource/file data that isn't
      // available in context (e.g., referenced model was never executed).
      // Unlike inputs, model data is never conditionally accessed in CEL —
      // member access on a missing model ref is always an error.
      let hasMissingModelDep = false;
      const deps = extractDependencies(expr.celExpression);
      for (const dep of deps) {
        if (dep.type === "resource" || dep.type === "file") {
          const modelData = ctx.model[dep.modelRef];
          if (
            !modelData ||
            (dep.type === "resource" && !modelData.resource) ||
            (dep.type === "file" && !modelData.file)
          ) {
            hasMissingModelDep = true;
            break;
          }
        }
      }

      if (hasMissingModelDep) {
        continue;
      }

      try {
        const value = this.celEvaluator.evaluate(expr.celExpression, ctx);
        evaluatedValues.set(expr.raw, value);
      } catch {
        // Leave unresolved — CEL threw because an input referenced directly
        // (not inside a conditional branch) is absent from context.
        // The Proxy on globalArgs will surface a clear error if the method
        // actually needs the unresolved value.
      }
    }

    // Replace only the CEL-only expressions with evaluated values
    const evaluatedData = replaceExpressions(definitionData, evaluatedValues);

    // Create new Definition from evaluated data
    const evaluatedDefinition = DefinitionClass.fromData(
      evaluatedData as ReturnType<typeof definition.toData>,
    );

    return { definition: evaluatedDefinition, type, hadExpressions: true };
  }

  /**
   * Evaluates all definitions in dependency order.
   * Definitions are evaluated in topological order based on their expression dependencies.
   *
   * @returns Array of evaluated definitions
   * @throws CyclicDependencyError if circular dependencies are detected
   */
  async evaluateAllDefinitions(): Promise<EvaluatedDefinition[]> {
    // Load all definitions
    const allDefinitions = await this.definitionRepo.findAllGlobal();

    // Build dependency graph
    const nodes = this.buildDefinitionDependencyGraph(allDefinitions);

    // Sort topologically
    let sortedNames: string[];
    try {
      const sortResult = this.sortService.sort(nodes);
      sortedNames = this.sortService.flatten(sortResult);
    } catch (error) {
      if (error instanceof TopoCyclicError) {
        throw new CyclicDependencyError(error.cycle);
      }
      throw error;
    }

    // Build initial context
    const context = await this.modelResolver.buildContext();

    // Map of definition name to definition data
    const definitionMap = new Map<
      string,
      { definition: Definition; type: ModelType }
    >();
    for (const { definition, type } of allDefinitions) {
      definitionMap.set(definition.name, { definition, type });
    }

    // Evaluate in order
    const results: EvaluatedDefinition[] = [];
    for (const name of sortedNames) {
      const entry = definitionMap.get(name);
      if (!entry) continue;

      // Add self to context for this evaluation
      const ctxWithSelf: ExpressionContext = {
        ...context,
        self: {
          id: entry.definition.id,
          name: entry.definition.name,
          version: entry.definition.version,
          tags: entry.definition.tags,
          globalArguments: entry.definition.globalArguments,
        },
      };

      const result = await this.evaluateDefinition(
        entry.definition,
        entry.type,
        undefined,
        ctxWithSelf,
      );
      results.push(result);

      // Update context with evaluated definition data for subsequent evaluations
      if (result.hadExpressions) {
        const modelData = context.model[name] ?? {
          input: {
            id: result.definition.id,
            name: result.definition.name,
            version: result.definition.version,
            tags: result.definition.tags,
            globalArguments: {},
          },
        };
        modelData.definition = {
          id: result.definition.id,
          name: result.definition.name,
          version: result.definition.version,
          tags: result.definition.tags,
          globalArguments: result.definition.globalArguments,
          inputs: result.definition.inputs,
        };
        context.model[name] = modelData;
        // Also update by UUID
        context.model[result.definition.id] = modelData;
      }
    }

    return results;
  }

  /**
   * Builds a dependency graph from definitions based on their expressions.
   */
  private buildDefinitionDependencyGraph(
    definitions: { definition: Definition; type: ModelType }[],
  ): GraphNode[] {
    const nodes: GraphNode[] = [];
    const nameSet = new Set(definitions.map((d) => d.definition.name));

    for (const { definition } of definitions) {
      const definitionData = definition.toData();
      const expressions = extractExpressions(definitionData);

      // Collect all model references from expressions
      const dependencies: string[] = [];
      for (const expr of expressions) {
        const refs = extractModelRefs(expr.celExpression);
        for (const ref of refs) {
          // Only add if it's a known definition name (not self, not UUID for simplicity)
          if (nameSet.has(ref) && ref !== definition.name) {
            if (!dependencies.includes(ref)) {
              dependencies.push(ref);
            }
          }
        }
      }

      nodes.push({
        name: definition.name,
        weight: 0, // All definitions have equal weight
        dependencies,
      });
    }

    return nodes;
  }

  /**
   * Checks if any string value in the definition contains expressions.
   */
  hasDefinitionExpressions(definition: Definition): boolean {
    const data = definition.toData();
    return this.checkForExpressions(data);
  }

  /**
   * Resolves remaining runtime expressions (vault and env) in an already-evaluated definition.
   * This is the runtime phase — vault secrets and env variables are resolved here and never persisted.
   *
   * Vault secrets are replaced with sentinel tokens. The returned VaultSecretBag
   * maps sentinels to raw values, allowing the caller to resolve them appropriately:
   * - Non-shell contexts: VaultSecretBag.resolveDeep() for raw values
   * - Shell commands: VaultSecretBag.resolveForShell() for env var injection
   *
   * @param definition - The definition (may contain remaining ${{ vault.get(...) }} or ${{ env.* }} expressions)
   * @param redactor - Optional SecretRedactor to register resolved secret values for redaction
   * @returns The definition with sentinels and the VaultSecretBag for resolving them
   */
  async resolveRuntimeExpressionsInDefinition(
    definition: Definition,
    redactor?: SecretRedactor,
  ): Promise<RuntimeResolutionResult> {
    const secretBag = new VaultSecretBag();
    const definitionData = definition.toData();
    const expressions = extractExpressions(definitionData);

    // Filter to only runtime expressions (vault or env)
    const runtimeExpressions = expressions.filter((expr) =>
      containsRuntimeExpression(expr.celExpression)
    );

    if (runtimeExpressions.length === 0) {
      return { definition, secretBag };
    }

    const resolvedDefinition = await this.resolveRuntimeInExpressions(
      definitionData,
      runtimeExpressions,
      redactor,
      secretBag,
    );

    return { definition: resolvedDefinition, secretBag };
  }

  /**
   * Resolves remaining runtime expressions (vault and env) in arbitrary data.
   * This is the runtime phase — vault secrets and env variables are resolved here and never persisted.
   *
   * When vault secrets are present, sentinels are resolved to raw values inline
   * (no VaultSecretBag is returned). This is appropriate for non-shell data contexts.
   *
   * @param data - The data (may contain remaining runtime expressions)
   * @param redactor - Optional SecretRedactor to register resolved secret values for redaction
   * @returns The data with all runtime expressions resolved (sentinels replaced with raw values)
   */
  async resolveRuntimeExpressionsInData(
    data: unknown,
    redactor?: SecretRedactor,
  ): Promise<unknown> {
    const expressions = extractExpressions(data);
    const runtimeExpressions = expressions.filter((expr) =>
      containsRuntimeExpression(expr.celExpression)
    );

    if (runtimeExpressions.length === 0) {
      return data;
    }

    const secretBag = new VaultSecretBag();
    const evaluatedValues = new Map<string, unknown>();
    for (const expr of runtimeExpressions) {
      // Resolve vault references first (if any), then evaluate the full CEL
      let resolvedCelExpr = expr.celExpression;
      if (containsVaultExpression(expr.celExpression)) {
        resolvedCelExpr = await this.modelResolver.resolveVaultExpressions(
          expr.celExpression,
          redactor,
          secretBag,
        );
      }
      const value = this.celEvaluator.evaluate(resolvedCelExpr, {
        model: {},
        env: buildEnvContext(),
      });
      evaluatedValues.set(expr.raw, value);
    }

    // For the data path, resolve sentinels to raw values immediately
    // since there's no shell context to worry about.
    const resolved = replaceExpressions(data, evaluatedValues);
    if (!secretBag.isEmpty) {
      return secretBag.resolveDeep(resolved);
    }
    return resolved;
  }

  /**
   * @deprecated Use resolveRuntimeExpressionsInDefinition instead.
   */
  async resolveVaultExpressionsInDefinition(
    definition: Definition,
  ): Promise<Definition> {
    const result = await this.resolveRuntimeExpressionsInDefinition(definition);
    // Legacy callers expect raw values, so resolve sentinels immediately
    if (!result.secretBag.isEmpty) {
      const data = result.definition.toData();
      const resolved = result.secretBag.resolveDeep(data);
      return DefinitionClass.fromData(
        resolved as ReturnType<Definition["toData"]>,
      );
    }
    return result.definition;
  }

  /**
   * @deprecated Use resolveRuntimeExpressionsInData instead.
   */
  resolveVaultExpressionsInData(data: unknown): Promise<unknown> {
    return this.resolveRuntimeExpressionsInData(data);
  }

  /**
   * Internal: resolves runtime expressions in definition data and returns a new Definition.
   * Vault secrets are replaced with sentinel tokens stored in the secretBag.
   */
  private async resolveRuntimeInExpressions(
    definitionData: ReturnType<Definition["toData"]>,
    runtimeExpressions: ExpressionLocation[],
    redactor?: SecretRedactor,
    secretBag?: VaultSecretBag,
  ): Promise<Definition> {
    const evaluatedValues = new Map<string, unknown>();
    for (const expr of runtimeExpressions) {
      // Resolve vault references first (if any), then evaluate the CEL expression
      let resolvedCelExpr = expr.celExpression;
      if (containsVaultExpression(expr.celExpression)) {
        resolvedCelExpr = await this.modelResolver.resolveVaultExpressions(
          expr.celExpression,
          redactor,
          secretBag,
        );
      }
      const value = this.celEvaluator.evaluate(resolvedCelExpr, {
        model: {},
        env: buildEnvContext(),
      });
      evaluatedValues.set(expr.raw, value);
    }

    const resolvedData = replaceExpressions(definitionData, evaluatedValues);
    return DefinitionClass.fromData(
      resolvedData as ReturnType<Definition["toData"]>,
    );
  }
}
