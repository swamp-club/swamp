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
import { extractModelRefs } from "./dependency_extractor.ts";
import {
  type ExpressionContext,
  ModelResolver,
  type ModelResolverRepositories,
} from "./model_resolver.ts";
import { CyclicDependencyError } from "./errors.ts";
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
 * Checks whether a CEL expression references vault.get().
 * Expressions containing vault references must NOT be evaluated during
 * the persist phase — they are resolved at runtime only.
 */
export function containsVaultExpression(celExpression: string): boolean {
  return VAULT_GET_PATTERN.test(celExpression);
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

    // Evaluate CEL-only expressions; skip vault-containing expressions
    const evaluatedValues = new Map<string, unknown>();
    for (const expr of expressions) {
      if (containsVaultExpression(expr.celExpression)) {
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

    // Evaluate CEL-only expressions; skip vault-containing expressions
    // Vault expressions are resolved at runtime only, never persisted
    const evaluatedValues = new Map<string, unknown>();
    for (const expr of expressions) {
      if (containsVaultExpression(expr.celExpression)) {
        // Leave vault-containing expressions (vault-only and mixed) as raw
        continue;
      }

      const value = this.celEvaluator.evaluate(expr.celExpression, ctx);
      evaluatedValues.set(expr.raw, value);
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
   * Resolves remaining vault expressions in an already-evaluated definition.
   * This is the runtime phase — vault secrets are resolved here and never persisted.
   *
   * @param definition - The definition (may contain remaining ${{ vault.get(...) }} expressions)
   * @returns A new definition with vault expressions resolved to actual secret values
   */
  async resolveVaultExpressionsInDefinition(
    definition: Definition,
  ): Promise<Definition> {
    const definitionData = definition.toData();
    const expressions = extractExpressions(definitionData);

    // Filter to only vault-containing expressions
    const vaultExpressions = expressions.filter((expr) =>
      containsVaultExpression(expr.celExpression)
    );

    if (vaultExpressions.length === 0) {
      return definition;
    }

    return await this.resolveVaultInExpressions(
      definitionData,
      vaultExpressions,
    );
  }

  /**
   * Resolves remaining vault expressions in arbitrary data.
   * This is the runtime phase — vault secrets are resolved here and never persisted.
   *
   * @param data - The data (may contain remaining ${{ vault.get(...) }} expressions)
   * @returns The data with vault expressions resolved
   */
  async resolveVaultExpressionsInData(data: unknown): Promise<unknown> {
    const expressions = extractExpressions(data);
    const vaultExpressions = expressions.filter((expr) =>
      containsVaultExpression(expr.celExpression)
    );

    if (vaultExpressions.length === 0) {
      return data;
    }

    const evaluatedValues = new Map<string, unknown>();
    for (const expr of vaultExpressions) {
      // Resolve vault expressions first, then evaluate the full CEL
      const resolvedCelExpr = await this.modelResolver.resolveVaultExpressions(
        expr.celExpression,
      );
      const value = this.celEvaluator.evaluate(resolvedCelExpr, {
        model: {},
        env: {},
      });
      evaluatedValues.set(expr.raw, value);
    }

    return replaceExpressions(data, evaluatedValues);
  }

  /**
   * Internal: resolves vault expressions in definition data and returns a new Definition.
   */
  private async resolveVaultInExpressions(
    definitionData: ReturnType<Definition["toData"]>,
    vaultExpressions: ExpressionLocation[],
  ): Promise<Definition> {
    const evaluatedValues = new Map<string, unknown>();
    for (const expr of vaultExpressions) {
      // Resolve vault references, then evaluate the CEL expression
      const resolvedCelExpr = await this.modelResolver.resolveVaultExpressions(
        expr.celExpression,
      );
      const value = this.celEvaluator.evaluate(resolvedCelExpr, {
        model: {},
        env: {},
      });
      evaluatedValues.set(expr.raw, value);
    }

    const resolvedData = replaceExpressions(definitionData, evaluatedValues);
    return DefinitionClass.fromData(
      resolvedData as ReturnType<Definition["toData"]>,
    );
  }
}
