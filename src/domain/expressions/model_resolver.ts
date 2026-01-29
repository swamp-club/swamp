import type { ModelInput } from "../models/model_input.ts";
import type { ModelResource } from "../models/model_resource.ts";
import type { ModelType } from "../models/model_type.ts";
import type { YamlInputRepository } from "../../infrastructure/persistence/yaml_input_repository.ts";
import type { YamlResourceRepository } from "../../infrastructure/persistence/yaml_resource_repository.ts";
import { createModelResourceId } from "../models/model_resource.ts";
import { ModelNotFoundError } from "./errors.ts";

/**
 * Data about a single model for CEL context.
 */
export interface ModelData {
  input: {
    id: string;
    name: string;
    version: number;
    tags: Record<string, string>;
    attributes: Record<string, unknown>;
  };
  resource?: {
    id: string;
    version: number;
    createdAt: string;
    attributes: Record<string, unknown>;
  };
}

/**
 * Context for evaluating CEL expressions.
 */
export interface ExpressionContext {
  /** Map of model name/UUID to model data */
  model: Record<string, ModelData>;
  /** Self-reference for the current input being evaluated */
  self?: {
    id: string;
    name: string;
    version: number;
    tags: Record<string, string>;
    attributes: Record<string, unknown>;
  };
  /** Workflow context (for workflow evaluation) */
  workflow?: Record<string, unknown>;
  /** Index signature for CEL evaluator compatibility */
  [key: string]: unknown;
}

/**
 * Resolves model references to build CEL evaluation context.
 */
export class ModelResolver {
  constructor(
    private readonly inputRepo: YamlInputRepository,
    private readonly resourceRepo: YamlResourceRepository,
  ) {}

  /**
   * Builds a complete expression context from all available models.
   *
   * @param selfInput - The input currently being evaluated (for self reference)
   * @param selfType - The model type of the self input
   * @returns The expression context
   */
  async buildContext(
    selfInput?: ModelInput,
    selfType?: ModelType,
  ): Promise<ExpressionContext> {
    const context: ExpressionContext = {
      model: {},
    };

    // Load all inputs
    const allInputs = await this.inputRepo.findAllGlobal();

    for (const { input, type } of allInputs) {
      const modelData = await this.buildModelData(input, type);

      // Index by name
      context.model[input.name] = modelData;
      // Also index by UUID for direct ID references
      context.model[input.id] = modelData;
    }

    // Build self context if provided
    if (selfInput && selfType) {
      context.self = {
        id: selfInput.id,
        name: selfInput.name,
        version: selfInput.version,
        tags: selfInput.tags,
        attributes: selfInput.attributes,
      };
    }

    return context;
  }

  /**
   * Builds model data for a single input.
   */
  private async buildModelData(
    input: ModelInput,
    type: ModelType,
  ): Promise<ModelData> {
    const data: ModelData = {
      input: {
        id: input.id,
        name: input.name,
        version: input.version,
        tags: input.tags,
        attributes: input.attributes,
      },
    };

    // Load resource if available
    if (input.resourceId) {
      const resourceId = createModelResourceId(input.resourceId);
      const resource = await this.resourceRepo.findById(type, resourceId);
      if (resource) {
        data.resource = {
          id: resource.id,
          version: resource.version,
          createdAt: resource.createdAt.toISOString(),
          attributes: resource.attributes,
        };
      }
    }

    return data;
  }

  /**
   * Resolves a single model reference by name or ID.
   *
   * @param modelRef - The model name or UUID
   * @returns The model data
   * @throws ModelNotFoundError if the model cannot be found
   */
  async resolveModel(modelRef: string): Promise<{
    input: ModelInput;
    type: ModelType;
    resource?: ModelResource;
  }> {
    // Try by name first
    const byName = await this.inputRepo.findByNameGlobal(modelRef);
    if (byName) {
      const resource = byName.input.resourceId
        ? await this.resourceRepo.findById(
          byName.type,
          createModelResourceId(byName.input.resourceId),
        )
        : undefined;
      return {
        input: byName.input,
        type: byName.type,
        resource: resource ?? undefined,
      };
    }

    // Try by UUID - search across all types
    const allInputs = await this.inputRepo.findAllGlobal();
    for (const { input, type } of allInputs) {
      if (input.id === modelRef) {
        const resource = input.resourceId
          ? await this.resourceRepo.findById(
            type,
            createModelResourceId(input.resourceId),
          )
          : undefined;
        return { input, type, resource: resource ?? undefined };
      }
    }

    throw new ModelNotFoundError(modelRef);
  }

  /**
   * Updates the context with fresh resource data for a specific model.
   * Used during workflow execution when resources are created.
   *
   * @param context - The context to update
   * @param modelRef - The model name or UUID
   * @param resource - The new resource data
   */
  updateResourceInContext(
    context: ExpressionContext,
    modelRef: string,
    resource: ModelResource,
  ): void {
    const modelData = context.model[modelRef];
    if (modelData) {
      modelData.resource = {
        id: resource.id,
        version: resource.version,
        createdAt: resource.createdAt.toISOString(),
        attributes: resource.attributes,
      };
    }
  }
}
