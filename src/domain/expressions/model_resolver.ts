import type { ModelInput } from "../models/model_input.ts";
import type { ModelResource } from "../models/model_resource.ts";
import type { ModelData as ModelDataEntity } from "../models/model_data.ts";
import type { ModelFile } from "../models/model_file.ts";
import type { ModelLog } from "../models/model_log.ts";
import type { ModelOutput } from "../models/model_output.ts";
import type { ModelType } from "../models/model_type.ts";
import type { Definition, InputsSchema } from "../definitions/definition.ts";
import type { YamlInputRepository } from "../../infrastructure/persistence/yaml_input_repository.ts";
import type { YamlResourceRepository } from "../../infrastructure/persistence/yaml_resource_repository.ts";
import type { YamlDataRepository } from "../../infrastructure/persistence/yaml_data_repository.ts";
import type { FileSystemFileRepository } from "../../infrastructure/persistence/fs_file_repository.ts";
import type { StreamingLogRepository } from "../../infrastructure/persistence/streaming_log_repository.ts";
import type { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import type { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { inputIdToResourceId } from "../models/model_resource.ts";
import { createModelDataId } from "../models/model_data.ts";
import { createModelFileId } from "../models/model_file.ts";
import { createModelLogId } from "../models/model_log.ts";
import { ModelNotFoundError } from "./errors.ts";
import { VaultService } from "../vaults/vault_service.ts";

/**
 * Builds env context from Deno environment variables.
 */
export function buildEnvContext(): Record<string, string> {
  return { ...Deno.env.toObject() };
}

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
  definition?: {
    id: string;
    name: string;
    version: number;
    tags: Record<string, string>;
    attributes: Record<string, unknown>;
    inputs?: InputsSchema;
  };
  resource?: {
    id: string;
    version: number;
    createdAt: string;
    attributes: Record<string, unknown>;
  };
  data?: {
    id: string;
    version: number;
    createdAt: string;
    attributes: Record<string, unknown>;
  };
  file?: {
    id: string;
    version: number;
    createdAt: string;
    filename: string;
    contentType: string;
    size: number;
    checksum: string;
    path: string;
  };
  log?: {
    id: string;
    version: number;
    createdAt: string;
    entries: Array<{
      message: string;
    }>;
  };
  execution?: {
    id: string;
    methodName: string;
    status: string;
    startedAt: string;
    completedAt?: string;
    durationMs?: number;
    error?: { message: string; stack?: string };
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
  /** Input values provided when instantiating a definition */
  inputs?: Record<string, unknown>;
  /** Workflow context (for workflow evaluation) */
  workflow?: Record<string, unknown>;
  /** Vault operations for secure secret access */
  vault?: {
    get(vaultName: string, secretKey: string): string;
  };
  /** Environment variables */
  env: Record<string, string>;
  /** Index signature for CEL evaluator compatibility */
  [key: string]: unknown;
}

/**
 * Configuration for optional repositories and services.
 */
export interface ModelResolverRepositories {
  dataRepo?: YamlDataRepository;
  fileRepo?: FileSystemFileRepository;
  logRepo?: StreamingLogRepository;
  outputRepo?: YamlOutputRepository;
  definitionRepo?: YamlDefinitionRepository;
  /** Optional vault service for dependency injection (useful for testing) */
  vaultService?: VaultService;
  /** Repository directory for lazy loading vault configurations */
  repoDir?: string;
}

/**
 * Resolves model references to build CEL evaluation context.
 */
export class ModelResolver {
  private readonly dataRepo?: YamlDataRepository;
  private readonly fileRepo?: FileSystemFileRepository;
  private readonly logRepo?: StreamingLogRepository;
  private readonly outputRepo?: YamlOutputRepository;
  private readonly definitionRepo?: YamlDefinitionRepository;
  private vaultService?: VaultService;
  private readonly repoDir?: string;
  private vaultServiceInitialized = false;

  constructor(
    private readonly inputRepo: YamlInputRepository,
    private readonly resourceRepo: YamlResourceRepository,
    repos?: ModelResolverRepositories,
  ) {
    this.dataRepo = repos?.dataRepo;
    this.fileRepo = repos?.fileRepo;
    this.logRepo = repos?.logRepo;
    this.outputRepo = repos?.outputRepo;
    this.definitionRepo = repos?.definitionRepo;
    this.repoDir = repos?.repoDir;
    // If a vault service was provided, use it directly
    if (repos?.vaultService) {
      this.vaultService = repos.vaultService;
      this.vaultServiceInitialized = true;
    }
  }

  /**
   * Gets or lazily initializes the vault service.
   * If a VaultService was provided in the constructor, it's used directly.
   * Otherwise, vaults are loaded from the repository (if repoDir was provided).
   */
  private async getVaultService(): Promise<VaultService> {
    if (this.vaultServiceInitialized && this.vaultService) {
      return this.vaultService;
    }

    // Lazy initialization: load vaults from repository if repoDir is available
    if (this.repoDir) {
      this.vaultService = await VaultService.fromRepository(this.repoDir);
    } else {
      // No repoDir, create an empty vault service with defaults
      this.vaultService = new VaultService();
      this.vaultService.ensureDefaultVaults();
    }
    this.vaultServiceInitialized = true;
    return this.vaultService;
  }

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
      env: buildEnvContext(),
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

    // Load definition if available (by name match)
    if (this.definitionRepo) {
      const definition = await this.definitionRepo.findByName(type, input.name);
      if (definition) {
        data.definition = {
          id: definition.id,
          name: definition.name,
          version: definition.version,
          tags: definition.tags,
          attributes: definition.attributes,
          inputs: definition.inputs,
        };
      }
    }

    // Load resource if available (resource ID equals input ID by convention)
    const resourceId = inputIdToResourceId(input.id);
    const resource = await this.resourceRepo.findById(type, resourceId);
    if (resource) {
      data.resource = {
        id: resource.id,
        version: resource.version,
        createdAt: resource.createdAt.toISOString(),
        attributes: resource.attributes,
      };
    }

    // Load data artifact if available
    if (input.dataId && this.dataRepo) {
      const dataId = createModelDataId(input.dataId);
      const dataArtifact = await this.dataRepo.findById(type, dataId);
      if (dataArtifact) {
        data.data = {
          id: dataArtifact.id,
          version: dataArtifact.version,
          createdAt: dataArtifact.createdAt.toISOString(),
          attributes: dataArtifact.attributes,
        };
      }
    }

    // Load file artifact if available
    // Note: We need to find the file using the output that created it
    // to get the method name for the path structure
    if (input.fileId && this.fileRepo && this.outputRepo) {
      const fileId = createModelFileId(input.fileId);
      // Find the output that created this file to get the method name
      const latestOutput = await this.outputRepo.findLatestByModelInput(
        type,
        input.id,
      );
      const methodName = latestOutput?.methodName;

      if (methodName) {
        const fileArtifact = await this.fileRepo.findById(
          type,
          input.id,
          methodName,
          fileId,
        );
        if (fileArtifact) {
          data.file = {
            id: fileArtifact.id,
            version: fileArtifact.version,
            createdAt: fileArtifact.createdAt.toISOString(),
            filename: fileArtifact.filename,
            contentType: fileArtifact.contentType,
            size: fileArtifact.size,
            checksum: fileArtifact.checksum,
            path: this.fileRepo.getContentPath(
              type,
              input.id,
              methodName,
              fileArtifact,
            ),
          };
        }
      }
    }

    // Load log artifact if available
    if (input.logId && this.logRepo) {
      const logId = createModelLogId(input.logId);
      const logArtifact = await this.logRepo.findById(type, logId);
      if (logArtifact) {
        data.log = {
          id: logArtifact.id,
          version: logArtifact.version,
          createdAt: logArtifact.createdAt.toISOString(),
          entries: logArtifact.entries.map((e) => ({
            message: e.message,
          })),
        };
      }
    }

    // Load latest output if available
    if (this.outputRepo) {
      const latestOutput = await this.outputRepo.findLatestByModelInput(
        type,
        input.id,
      );
      if (latestOutput) {
        data.execution = {
          id: latestOutput.id,
          methodName: latestOutput.methodName,
          status: latestOutput.status,
          startedAt: latestOutput.startedAt.toISOString(),
          completedAt: latestOutput.completedAt?.toISOString(),
          durationMs: latestOutput.durationMs,
          error: latestOutput.error,
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
      // Resource ID equals input ID by convention
      const resourceId = inputIdToResourceId(byName.input.id);
      const resource = await this.resourceRepo.findById(
        byName.type,
        resourceId,
      );
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
        // Resource ID equals input ID by convention
        const resourceId = inputIdToResourceId(input.id);
        const resource = await this.resourceRepo.findById(type, resourceId);
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

  /**
   * Updates the context with fresh data artifact for a specific model.
   *
   * @param context - The context to update
   * @param modelRef - The model name or UUID
   * @param dataArtifact - The new data artifact
   */
  updateDataInContext(
    context: ExpressionContext,
    modelRef: string,
    dataArtifact: ModelDataEntity,
  ): void {
    const modelData = context.model[modelRef];
    if (modelData) {
      modelData.data = {
        id: dataArtifact.id,
        version: dataArtifact.version,
        createdAt: dataArtifact.createdAt.toISOString(),
        attributes: dataArtifact.attributes,
      };
    }
  }

  /**
   * Updates the context with fresh file artifact for a specific model.
   *
   * @param context - The context to update
   * @param modelRef - The model name or UUID
   * @param fileArtifact - The new file artifact
   * @param filePath - The path to the file content
   */
  updateFileInContext(
    context: ExpressionContext,
    modelRef: string,
    fileArtifact: ModelFile,
    filePath: string,
  ): void {
    const modelData = context.model[modelRef];
    if (modelData) {
      modelData.file = {
        id: fileArtifact.id,
        version: fileArtifact.version,
        createdAt: fileArtifact.createdAt.toISOString(),
        filename: fileArtifact.filename,
        contentType: fileArtifact.contentType,
        size: fileArtifact.size,
        checksum: fileArtifact.checksum,
        path: filePath,
      };
    }
  }

  /**
   * Updates the context with fresh log artifact for a specific model.
   *
   * @param context - The context to update
   * @param modelRef - The model name or UUID
   * @param logArtifact - The new log artifact
   */
  updateLogInContext(
    context: ExpressionContext,
    modelRef: string,
    logArtifact: ModelLog,
  ): void {
    const modelData = context.model[modelRef];
    if (modelData) {
      modelData.log = {
        id: logArtifact.id,
        version: logArtifact.version,
        createdAt: logArtifact.createdAt.toISOString(),
        entries: logArtifact.entries.map((e) => ({
          message: e.message,
        })),
      };
    }
  }

  /**
   * Updates the context with fresh output state for a specific model.
   *
   * @param context - The context to update
   * @param modelRef - The model name or UUID
   * @param output - The output state
   */
  updateOutputInContext(
    context: ExpressionContext,
    modelRef: string,
    output: ModelOutput,
  ): void {
    const modelData = context.model[modelRef];
    if (modelData) {
      modelData.execution = {
        id: output.id,
        methodName: output.methodName,
        status: output.status,
        startedAt: output.startedAt.toISOString(),
        completedAt: output.completedAt?.toISOString(),
        durationMs: output.durationMs,
        error: output.error,
      };
    }
  }

  /**
   * Updates the context with fresh definition data for a specific model.
   *
   * @param context - The context to update
   * @param modelRef - The model name or UUID
   * @param definition - The definition data
   */
  updateDefinitionInContext(
    context: ExpressionContext,
    modelRef: string,
    definition: Definition,
  ): void {
    const modelData = context.model[modelRef];
    if (modelData) {
      modelData.definition = {
        id: definition.id,
        name: definition.name,
        version: definition.version,
        tags: definition.tags,
        attributes: definition.attributes,
        inputs: definition.inputs,
      };
    }
  }

  /**
   * Resolves vault expressions in a string by evaluating vault.get() calls.
   *
   * @param value - The string that may contain vault expressions
   * @returns The string with vault expressions resolved to actual secret values
   */
  async resolveVaultExpressions(value: string): Promise<string> {
    // Pattern to match vault.get(vaultName, secretKey) expressions
    // Handles both quoted and unquoted arguments
    const vaultPattern =
      /vault\.get\(\s*(['"`]?)([^'"`\s,]+)\1\s*,\s*(['"`]?)([^'"`\s,]+)\3\s*\)/g;

    let resolvedValue = value;
    const matches = Array.from(value.matchAll(vaultPattern));

    if (matches.length === 0) {
      return resolvedValue;
    }

    // Get vault service (lazy initialization if needed)
    const vaultService = await this.getVaultService();

    for (const match of matches) {
      const [fullMatch, , vaultName, , secretKey] = match;
      try {
        const secretValue = await vaultService.get(vaultName, secretKey);
        // Escape special characters to prevent CEL parsing issues and injection attacks
        const escapedValue = secretValue
          .replace(/\\/g, "\\\\")
          .replace(/"/g, '\\"')
          .replace(/\n/g, "\\n")
          .replace(/\r/g, "\\r")
          .replace(/\t/g, "\\t");
        // Replace the entire vault.get(...) call with the escaped secret value wrapped in quotes for CEL
        resolvedValue = resolvedValue.replace(fullMatch, `"${escapedValue}"`);
      } catch (error) {
        throw new Error(
          `Failed to resolve vault expression ${fullMatch}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return resolvedValue;
  }
}
