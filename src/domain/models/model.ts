import type { z } from "zod";
import type { CloudControlClient } from "@aws-sdk/client-cloudcontrol";
import { ModelType } from "./model_type.ts";
import type { ModelInput } from "./model_input.ts";
import type { ModelResource } from "./model_resource.ts";
import type { ModelData } from "./model_data.ts";
import type { ModelFile } from "./model_file.ts";
import type { ModelLog } from "./model_log.ts";
import type {
  DataRepository,
  FileRepository,
  LogRepository,
  OutputRepository,
  ResourceRepository,
} from "./repositories.ts";

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
 * Context provided to method execution.
 */
export interface MethodContext {
  /**
   * The base directory for the repository (where inputs/resources are stored).
   */
  repoDir: string;

  /**
   * Optional factory for CloudControl clients (for testing).
   */
  cloudControlClientFactory?: () => CloudControlClient;

  /**
   * Optional resource repository for accessing persisted resources.
   */
  resourceRepository?: ResourceRepository;

  /**
   * Optional data repository for accessing persisted data artifacts.
   */
  dataRepository?: DataRepository;

  /**
   * Optional file repository for accessing persisted file artifacts.
   */
  fileRepository?: FileRepository;

  /**
   * Optional log repository for accessing persisted log artifacts.
   */
  logRepository?: LogRepository;

  /**
   * Optional output repository for tracking execution history.
   */
  outputRepository?: OutputRepository;

  /**
   * Optional callbacks for streaming stdout/stderr output.
   */
  streaming?: MethodStreamingCallbacks;
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
   */
  continueCondition?: (resource: ModelResource) => boolean;
}

/**
 * Result of a method execution.
 */
export interface MethodResult {
  /**
   * The resource created by the method (optional with new artifact types).
   */
  resource?: ModelResource;

  /**
   * Structured data output produced by the method.
   */
  data?: ModelData;

  /**
   * File output produced by the method.
   */
  file?: {
    metadata: ModelFile;
    content: Uint8Array;
  };

  /**
   * Log outputs produced by the method.
   */
  logs?: ModelLog[];

  /**
   * Optional follow-up actions to execute.
   */
  followUpActions?: FollowUpAction[];

  /**
   * If true, the resource should be deleted instead of saved.
   * Used for operations like delete that complete by removing the resource.
   */
  deleteResource?: boolean;

  /**
   * If true, the data artifact should be deleted.
   */
  deleteData?: boolean;

  /**
   * If true, the file artifact should be deleted.
   */
  deleteFile?: boolean;

  /**
   * If true, the log artifacts should be deleted.
   */
  deleteLogs?: boolean;
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
 * - Schema for resource attributes (optional, for persistent resources)
 * - Schema for data attributes (optional, for ephemeral data)
 * - Available methods
 *
 * At least one of resourceAttributesSchema or dataAttributesSchema should be provided.
 */
export interface ModelDefinition<
  TInputAttrs extends z.ZodTypeAny = z.ZodTypeAny,
  TResourceAttrs extends z.ZodTypeAny = z.ZodTypeAny,
  TDataAttrs extends z.ZodTypeAny = z.ZodTypeAny,
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
   * Zod schema for validating resource attributes (persistent, git-tracked).
   */
  resourceAttributesSchema?: TResourceAttrs;

  /**
   * Zod schema for validating data attributes (ephemeral, not git-tracked).
   */
  dataAttributesSchema?: TDataAttrs;

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
  TResourceAttrs extends z.ZodTypeAny = z.ZodTypeAny,
  TDataAttrs extends z.ZodTypeAny = z.ZodTypeAny,
>(
  definition: ModelDefinition<TInputAttrs, TResourceAttrs, TDataAttrs>,
): ModelDefinition<TInputAttrs, TResourceAttrs, TDataAttrs> {
  if (!modelRegistry.has(definition.type)) {
    modelRegistry.register(definition);
  }
  return definition;
}
