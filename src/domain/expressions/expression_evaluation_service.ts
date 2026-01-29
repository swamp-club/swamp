import type { ModelInput } from "../models/model_input.ts";
import { ModelInput as ModelInputClass } from "../models/model_input.ts";
import type { ModelType } from "../models/model_type.ts";
import type { YamlInputRepository } from "../../infrastructure/persistence/yaml_input_repository.ts";
import type { YamlResourceRepository } from "../../infrastructure/persistence/yaml_resource_repository.ts";
import { CelEvaluator } from "../../infrastructure/cel/cel_evaluator.ts";
import {
  containsExpression,
  extractExpressions,
  replaceExpressions,
} from "./expression_parser.ts";
import { extractModelRefs } from "./dependency_extractor.ts";
import { type ExpressionContext, ModelResolver } from "./model_resolver.ts";
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
 * Domain service for evaluating CEL expressions in model inputs.
 */
export class ExpressionEvaluationService {
  private readonly celEvaluator: CelEvaluator;
  private readonly sortService: TopologicalSortService;
  private readonly modelResolver: ModelResolver;

  constructor(
    private readonly inputRepo: YamlInputRepository,
    private readonly resourceRepo: YamlResourceRepository,
  ) {
    this.celEvaluator = new CelEvaluator();
    this.sortService = new TopologicalSortService();
    this.modelResolver = new ModelResolver(inputRepo, resourceRepo);
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
      const value = this.celEvaluator.evaluate(expr.celExpression, ctx);
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
  evaluateData(
    data: unknown,
    context: ExpressionContext,
  ): unknown {
    const expressions = extractExpressions(data);
    if (expressions.length === 0) {
      return data;
    }

    const evaluatedValues = new Map<string, unknown>();
    for (const expr of expressions) {
      const value = this.celEvaluator.evaluate(expr.celExpression, context);
      evaluatedValues.set(expr.raw, value);
    }

    return replaceExpressions(data, evaluatedValues);
  }
}
