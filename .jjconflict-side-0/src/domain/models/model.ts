import { z } from "zod";
import type { CloudControlClient } from "@aws-sdk/client-cloudcontrol";
import { ModelType } from "./model_type.ts";
import type { Definition } from "../definitions/definition.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
import {
  type DataMetadata,
  type GarbageCollectionPolicy,
  GarbageCollectionSchema,
  type Lifetime,
  LifetimeSchema,
} from "../data/mod.ts";
import type { UnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import type { OutputRepository } from "./repositories.ts";

/**
 * Callbacks for streaming output from method execution.
 */
export interface MethodStreamingCallbacks {
  /**
   * Called for each line of stdout.
   */
  onStdout?: (line: string) => void;

  /**
   * Called for each line of stderr.
   */
  onStderr?: (line: string) => void;
}

/**
 * Data spec type - identifies a category of data output.
 * Value object - equality by value.
 */
export class DataSpecType {
  private constructor(readonly value: string) {
    if (!value || value.trim().length === 0) {
      throw new Error("Data spec type cannot be empty");
    }
  }

  static create(value: string): DataSpecType {
    return new DataSpecType(value.trim());
  }

  equals(other: DataSpecType): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}

/**
 * Specification for a data output spec type.
 * Value object - immutable.
 */
export interface DataOutputSpecification {
  /** The spec type identifier */
  specType: DataSpecType;

  /** Human-readable description */
  description?: string;

  /** Default content type */
  contentType?: string;

  /** Default lifetime policy */
  lifetime?: Lifetime;

  /** Default garbage collection policy */
  garbageCollection?: GarbageCollectionPolicy;

  /** Whether this supports streaming */
  streaming?: boolean;

  /** Default tags */
  tags?: Record<string, string>;
}

/**
 * Zod schema for data output specification.
 */
export const DataOutputSpecificationSchema = z.object({
  specType: z.string().min(1),
  description: z.string().optional(),
  contentType: z.string().optional(),
  lifetime: LifetimeSchema.optional(),
  garbageCollection: GarbageCollectionSchema.optional(),
  streaming: z.boolean().optional(),
  tags: z.record(z.string(), z.string()).optional(),
});

/**
 * Context provided to method execution.
 */
export interface MethodContext {
  /**
   * The base directory for the repository (where data is stored).
   */
  repoDir: string;

  /**
   * The model type for this execution.
   */
  modelType: ModelType;

  /**
   * The model ID (definition ID) for this execution.
   */
  modelId: string;

  /**
   * Optional factory for CloudControl clients (for testing).
   */
  cloudControlClientFactory?: () => CloudControlClient;

  /**
   * Repository for unified data storage.
   */
  dataRepository: UnifiedDataRepository;

  /**
   * Repository for definitions.
   */
  definitionRepository: DefinitionRepository;

  /**
   * Repository for tracking execution history.
   */
  outputRepository?: OutputRepository;

  /**
   * Optional callbacks for streaming stdout/stderr output.
   */
  streaming?: MethodStreamingCallbacks;

  /**
   * The model definition for validation and defaults.
   */
  modelDefinition?: ModelDefinition;
}

/**
 * Data output from a method execution.
 */
export interface DataOutput {
  /**
   * Unique name for this data instance.
   */
  name: string;

  /**
   * Reference to the declared spec type.
   */
  specType: DataSpecType;

  /**
   * Content of the data artifact.
   */
  content: Uint8Array;

  /**
   * Metadata for the data artifact (can override spec defaults).
   */
  metadata: Omit<
    DataMetadata,
    "id" | "name" | "version" | "createdAt" | "size" | "checksum"
  >;
}

/**
 * Follow-up action to be executed after a method completes.
 */
export interface FollowUpAction {
  /**
   * Name of the method to call next.
   */
  methodName: string;

  /**
   * Delay before executing the follow-up action (in milliseconds).
   */
  delayMs?: number;

  /**
   * Maximum number of retries for this action.
   */
  maxRetries?: number;

  /**
   * Condition that must be met to continue with follow-up actions.
   * If this returns false, the workflow stops.
   * Receives the data outputs from the previous method execution.
   */
  continueCondition?: (dataOutputs: DataOutput[]) => boolean;
}

/**
 * Result of a method execution.
 */
export interface MethodResult {
  /**
   * Data outputs produced by the method.
   * Each output will be stored as a versioned Data artifact.
   */
  dataOutputs?: DataOutput[];

  /**
   * Optional follow-up actions to execute.
   */
  followUpActions?: FollowUpAction[];
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
   * Zod schema for validating the definition attributes required by this method.
   * The method will only execute if the definition's attributes match this schema.
   */
  inputAttributesSchema: TInputAttrs;

  /**
   * Executes the method with the given definition and context.
   *
   * @param definition - The definition containing attributes
   * @param context - Execution context
   * @returns The method result
   */
  execute(
    definition: Definition,
    context: MethodContext,
  ): Promise<MethodResult>;
}

/**
 * Definition of a model type (the aggregate root).
 *
 * A model defines:
 * - Its type identifier
 * - Current version
 * - Schema for validating definition attributes
 * - Data output specifications
 * - Available methods
 */
export interface ModelDefinition<
  TInputAttrs extends z.ZodTypeAny = z.ZodTypeAny,
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
   * Zod schema for validating definition attributes.
   */
  inputAttributesSchema: TInputAttrs;

  /**
   * Data output specifications - declares what spec types this model produces.
   * Keys are spec type values, values are full specifications.
   * REQUIRED for all models.
   */
  dataOutputSpecs: Record<string, DataOutputSpecification>;

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
   * Extends an existing model with additional methods.
   * Creates a new merged ModelDefinition (immutable — doesn't mutate the existing object).
   *
   * @param type - The model type to extend (raw or normalized)
   * @param methods - Additional methods to add
   * @throws If the target type is not registered
   * @throws If any method name conflicts with existing methods
   */
  extend(
    type: string | ModelType,
    methods: Record<string, MethodDefinition>,
  ): void {
    const modelType = typeof type === "string" ? ModelType.create(type) : type;
    const key = modelType.normalized;
    const existing = this.models.get(key);

    if (!existing) {
      throw new Error(`Cannot extend unregistered model type: ${key}`);
    }

    // Check for method name conflicts
    for (const methodName of Object.keys(methods)) {
      if (existing.methods[methodName]) {
        throw new Error(
          `Method '${methodName}' already exists on model type '${key}'`,
        );
      }
    }

    // Create a new merged ModelDefinition (immutable)
    const merged: ModelDefinition = {
      ...existing,
      methods: { ...existing.methods, ...methods },
    };

    this.models.set(key, merged);
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

/**
 * Defines and registers a model with the global registry.
 *
 * Use this function at module level to self-register models when the module is imported.
 * The barrel file (models.ts) imports all model files, triggering registration.
 *
 * @param definition - The model definition to register
 * @returns The same model definition (for re-export)
 */
export function defineModel<
  TInputAttrs extends z.ZodTypeAny,
>(
  definition: ModelDefinition<TInputAttrs>,
): ModelDefinition<TInputAttrs> {
  if (!modelRegistry.has(definition.type)) {
    modelRegistry.register(definition);
  }
  return definition;
}
