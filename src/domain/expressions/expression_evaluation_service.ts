import type { ModelInput } from "../models/model_input.ts";
import { ModelInput as ModelInputClass } from "../models/model_input.ts";
import type { ModelType } from "../models/model_type.ts";
import type { Definition } from "../definitions/definition.ts";
import { Definition as DefinitionClass } from "../definitions/definition.ts";
import type { YamlInputRepository } from "../../infrastructure/persistence/yaml_input_repository.ts";
import type { YamlResourceRepository } from "../../infrastructure/persistence/yaml_resource_repository.ts";
import type { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { CelEvaluator } from "../../infrastructure/cel/cel_evaluator.ts";
import {
  containsExpression,
  extractExpressions,
  replaceExpressions,
} from "./expression_parser.ts";
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
 * Result of evaluating a single input.
 */
export interface EvaluatedInput {
  input: ModelInput;
  type: ModelType;
  /** Whether any expressions were evaluated */
  hadExpressions: boolean;
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
 * Domain service for evaluating CEL expressions in model inputs and definitions.
 */
export class ExpressionEvaluationService {
  private readonly celEvaluator: CelEvaluator;
  private readonly sortService: TopologicalSortService;
  private readonly modelResolver: ModelResolver;
  private readonly definitionRepo?: YamlDefinitionRepository;

  constructor(
    private readonly inputRepo: YamlInputRepository,
    private readonly resourceRepo: YamlResourceRepository,
    repoDir?: string,
    repos?: ModelResolverRepositories,
  ) {
    this.celEvaluator = new CelEvaluator();
    this.sortService = new TopologicalSortService();
    this.definitionRepo = repos?.definitionRepo;
    this.modelResolver = new ModelResolver(inputRepo, resourceRepo, {
      repoDir,
      ...repos,
    });
  }

  /**
   * Evaluates expressions in a single input.
   *
   * @param input - The input to evaluate
   * @param type - The model type
   * @param context - Optional pre-built context (for batch evaluation)
   * @returns The evaluated input
   */
  async evaluateInput(
    input: ModelInput,
    type: ModelType,
    context?: ExpressionContext,
  ): Promise<EvaluatedInput> {
    // Build context if not provided
    const ctx = context ?? await this.modelResolver.buildContext(input, type);

    // Extract expressions from input data
    const inputData = input.toData();
    const expressions = extractExpressions(inputData);

    if (expressions.length === 0) {
      return { input, type, hadExpressions: false };
    }

    // Evaluate each expression
    const evaluatedValues = new Map<string, unknown>();
    for (const expr of expressions) {
      // First resolve any vault expressions in the CEL expression
      const resolvedCelExpr = await this.modelResolver.resolveVaultExpressions(
        expr.celExpression,
      );

      // Then evaluate the CEL expression
      const value = this.celEvaluator.evaluate(resolvedCelExpr, ctx);
      evaluatedValues.set(expr.raw, value);
    }

    // Replace expressions with evaluated values
    const evaluatedData = replaceExpressions(inputData, evaluatedValues);

    // Create new ModelInput from evaluated data
    const evaluatedInput = ModelInputClass.fromData(
      evaluatedData as ReturnType<typeof input.toData>,
    );

    return { input: evaluatedInput, type, hadExpressions: true };
  }

  /**
   * Evaluates all inputs in dependency order.
   * Inputs are evaluated in topological order based on their expression dependencies.
   *
   * @returns Array of evaluated inputs
   * @throws CyclicDependencyError if circular dependencies are detected
   */
  async evaluateAllInputs(): Promise<EvaluatedInput[]> {
    // Load all inputs
    const allInputs = await this.inputRepo.findAllGlobal();

    // Build dependency graph
    const nodes = this.buildDependencyGraph(allInputs);

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

    // Map of input name to input data
    const inputMap = new Map<string, { input: ModelInput; type: ModelType }>();
    for (const { input, type } of allInputs) {
      inputMap.set(input.name, { input, type });
    }

    // Evaluate in order
    const results: EvaluatedInput[] = [];
    for (const name of sortedNames) {
      const entry = inputMap.get(name);
      if (!entry) continue;

      // Add self to context for this evaluation
      const ctxWithSelf: ExpressionContext = {
        ...context,
        self: {
          id: entry.input.id,
          name: entry.input.name,
          version: entry.input.version,
          tags: entry.input.tags,
          attributes: entry.input.attributes,
        },
      };

      const result = await this.evaluateInput(
        entry.input,
        entry.type,
        ctxWithSelf,
      );
      results.push(result);

      // Update context with evaluated input data for subsequent evaluations
      if (result.hadExpressions) {
        context.model[name] = {
          input: {
            id: result.input.id,
            name: result.input.name,
            version: result.input.version,
            tags: result.input.tags,
            attributes: result.input.attributes,
          },
          resource: context.model[name]?.resource,
        };
        // Also update by UUID
        context.model[result.input.id] = context.model[name];
      }
    }

    return results;
  }

  /**
   * Builds a dependency graph from inputs based on their expressions.
   */
  private buildDependencyGraph(
    inputs: { input: ModelInput; type: ModelType }[],
  ): GraphNode[] {
    const nodes: GraphNode[] = [];
    const nameSet = new Set(inputs.map((i) => i.input.name));

    for (const { input } of inputs) {
      const inputData = input.toData();
      const expressions = extractExpressions(inputData);

      // Collect all model references from expressions
      const dependencies: string[] = [];
      for (const expr of expressions) {
        const refs = extractModelRefs(expr.celExpression);
        for (const ref of refs) {
          // Only add if it's a known input name (not self, not UUID for simplicity)
          if (nameSet.has(ref) && ref !== input.name) {
            if (!dependencies.includes(ref)) {
              dependencies.push(ref);
            }
          }
        }
      }

      nodes.push({
        name: input.name,
        weight: 0, // All inputs have equal weight
        dependencies,
      });
    }

    return nodes;
  }

  /**
   * Checks if any string value in the input contains expressions.
   */
  hasExpressions(input: ModelInput): boolean {
    const data = input.toData();
    return this.checkForExpressions(data);
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
  async evaluateData(
    data: unknown,
    context: ExpressionContext,
  ): Promise<unknown> {
    const expressions = extractExpressions(data);
    if (expressions.length === 0) {
      return data;
    }

    const evaluatedValues = new Map<string, unknown>();
    for (const expr of expressions) {
      // First resolve any vault expressions in the CEL expression
      const resolvedCelExpr = await this.modelResolver.resolveVaultExpressions(
        expr.celExpression,
      );

      // Then evaluate the CEL expression
      const value = this.celEvaluator.evaluate(resolvedCelExpr, context);
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
      attributes: definition.attributes,
    };

    // Extract expressions from definition data
    const definitionData = definition.toData();
    const expressions = extractExpressions(definitionData);

    if (expressions.length === 0) {
      return { definition, type, hadExpressions: false };
    }

    // Evaluate each expression
    const evaluatedValues = new Map<string, unknown>();
    for (const expr of expressions) {
      // First resolve any vault expressions in the CEL expression
      const resolvedCelExpr = await this.modelResolver.resolveVaultExpressions(
        expr.celExpression,
      );

      // Then evaluate the CEL expression
      const value = this.celEvaluator.evaluate(resolvedCelExpr, ctx);
      evaluatedValues.set(expr.raw, value);
    }

    // Replace expressions with evaluated values
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
    if (!this.definitionRepo) {
      return [];
    }

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
          attributes: entry.definition.attributes,
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
            attributes: {},
          },
        };
        modelData.definition = {
          id: result.definition.id,
          name: result.definition.name,
          version: result.definition.version,
          tags: result.definition.tags,
          attributes: result.definition.attributes,
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
}
