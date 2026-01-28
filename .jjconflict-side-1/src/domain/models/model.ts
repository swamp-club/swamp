import type { z } from "zod";
import { ModelType } from "./model_type.ts";
import type { ModelInput } from "./model_input.ts";
import type { ModelResource } from "./model_resource.ts";

/**
 * Context provided to method execution.
 */
export interface MethodContext {
  /**
   * The base directory for the repository (where inputs/resources are stored).
   */
  repoDir: string;
}

/**
 * Result of a method execution.
 */
export interface MethodResult {
  /**
   * The resource created by the method.
   */
  resource: ModelResource;
}

/**
 * Definition of a model method.
 */
export interface MethodDefinition<
  TInputAttrs extends z.ZodTypeAny = z.ZodTypeAny,
> {
  /**
   * Human-readable description of what the method does.
   */
  description: string;

  /**
   * Zod schema for validating the input attributes required by this method.
   * The method will only execute if the input's attributes match this schema.
   */
  inputAttributesSchema: TInputAttrs;

  /**
   * Executes the method with the given input and context.
   *
   * @param input - The model input
   * @param context - Execution context
   * @returns The method result containing the created resource
   */
  execute(input: ModelInput, context: MethodContext): Promise<MethodResult>;
}

/**
 * Definition of a model type (the aggregate root).
 *
 * A model defines:
 * - Its type identifier
 * - Current version
 * - Schema for input attributes
 * - Schema for resource attributes
 * - Available methods
 */
export interface ModelDefinition<
  TInputAttrs extends z.ZodTypeAny = z.ZodTypeAny,
  TResourceAttrs extends z.ZodTypeAny = z.ZodTypeAny,
> {
  /**
   * The model type.
   */
  type: ModelType;

  /**
   * Current version of this model definition.
   */
  version: number;

  /**
   * Zod schema for validating input attributes.
   */
  inputAttributesSchema: TInputAttrs;

  /**
   * Zod schema for validating resource attributes.
   */
  resourceAttributesSchema: TResourceAttrs;

  /**
   * Available methods on this model.
   */
  methods: Record<string, MethodDefinition>;
}

/**
 * Registry of all known model definitions.
 */
export class ModelRegistry {
  private models = new Map<string, ModelDefinition>();

  /**
   * Registers a model definition.
   *
   * @param model - The model definition to register
   */
  register(model: ModelDefinition): void {
    const key = model.type.normalized;
    if (this.models.has(key)) {
      throw new Error(`Model type already registered: ${key}`);
    }
    this.models.set(key, model);
  }

  /**
   * Gets a model definition by type.
   *
   * @param type - The model type (raw or normalized)
   * @returns The model definition, or undefined if not found
   */
  get(type: string | ModelType): ModelDefinition | undefined {
    const modelType = typeof type === "string" ? ModelType.create(type) : type;
    return this.models.get(modelType.normalized);
  }

  /**
   * Checks if a model type is registered.
   *
   * @param type - The model type (raw or normalized)
   * @returns true if registered, false otherwise
   */
  has(type: string | ModelType): boolean {
    const modelType = typeof type === "string" ? ModelType.create(type) : type;
    return this.models.has(modelType.normalized);
  }

  /**
   * Returns all registered model types.
   */
  types(): ModelType[] {
    return Array.from(this.models.values()).map((m) => m.type);
  }
}

/**
 * Global model registry instance.
 */
export const modelRegistry = new ModelRegistry();
