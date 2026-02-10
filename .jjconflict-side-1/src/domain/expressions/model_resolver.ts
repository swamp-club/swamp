import type { ModelOutput } from "../models/model_output.ts";
import type { ModelType } from "../models/model_type.ts";
import type { Definition, InputsSchema } from "../definitions/definition.ts";
import type { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import type { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import type { UnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { ModelNotFoundError } from "./errors.ts";
import { VaultService } from "../vaults/vault_service.ts";

/**
 * Builds env context from Deno environment variables.
 */
export function buildEnvContext(): Record<string, string> {
  return { ...Deno.env.toObject() };
}

/**
 * Record returned by data functions in CEL expressions.
 * Represents a single version of a named data item.
 */
export interface DataRecord {
  id: string;
  name: string;
  version: number;
  createdAt: string;
  attributes: Record<string, unknown>;
  tags: Record<string, string>;
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
  /** Latest DataRecord (single artifact) or map of data-name -> DataRecord (multiple) */
  data?: Record<string, DataRecord> | DataRecord;
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
 * Namespace for data versioning functions in CEL expressions.
 */
export interface DataNamespace {
  /**
   * Get a specific version of data.
   * @param modelName - The model name
   * @param dataName - The data name
   * @param version - The version number
   * @returns The DataRecord or null if not found
   */
  version(
    modelName: string,
    dataName: string,
    version: number,
  ): DataRecord | null;

  /**
   * Get the latest version of data.
   * @param modelName - The model name
   * @param dataName - The data name
   * @returns The DataRecord or null if not found
   */
  latest(modelName: string, dataName: string): DataRecord | null;

  /**
   * List all version numbers for a data item.
   * @param modelName - The model name
   * @param dataName - The data name
   * @returns Array of version numbers in ascending order
   */
  listVersions(modelName: string, dataName: string): number[];

  /**
   * Find all data records with a specific tag.
   * @param tagKey - The tag key to search
   * @param tagValue - The tag value to match
   * @returns Array of matching DataRecords
   */
  findByTag(tagKey: string, tagValue: string): DataRecord[];
}

/**
 * Context for evaluating CEL expressions.
 */
export interface ExpressionContext {
  /** Map of model name/UUID to model data */
  model: Record<string, ModelData>;
  /**
   * Self-reference for the current input being evaluated.
   * When forEach is used, additional keys are added for the iteration variable
   * (e.g., self.env for forEach with item: "env")
   */
  self?: {
    id: string;
    name: string;
    version: number;
    tags: Record<string, string>;
    attributes: Record<string, unknown>;
    /** Index signature to allow forEach variables like self.env, self.tag */
    [key: string]: unknown;
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
  /** Data namespace for versioned data access */
  data?: DataNamespace;
  /** Index signature for CEL evaluator compatibility */
  [key: string]: unknown;
}

/**
 * Configuration for optional repositories and services.
 */
export interface ModelResolverRepositories {
  outputRepo?: YamlOutputRepository;
  /** Optional vault service for dependency injection (useful for testing) */
  vaultService?: VaultService;
  /** Repository directory for lazy loading vault configurations */
  repoDir?: string;
  /** Optional data repository for loading versioned data */
  dataRepo?: UnifiedDataRepository;
}

/**
 * Cache for pre-loaded data to enable synchronous CEL function evaluation.
 *
 * The cache indexes data by:
 * - (modelName, dataName, version) for direct lookups
 * - (tagKey, tagValue) for tag-based queries
 */
export class DataCache {
  // (modelName) -> (dataName) -> (version) -> DataRecord
  private byModelData: Map<string, Map<string, Map<number, DataRecord>>> =
    new Map();

  // (tagKey:tagValue) -> DataRecord[]
  private byTag: Map<string, DataRecord[]> = new Map();

  /**
   * Adds a data record to the cache.
   */
  addData(
    modelName: string,
    dataName: string,
    version: number,
    record: DataRecord,
  ): void {
    // Add to model/data/version index
    if (!this.byModelData.has(modelName)) {
      this.byModelData.set(modelName, new Map());
    }
    const dataMap = this.byModelData.get(modelName)!;
    if (!dataMap.has(dataName)) {
      dataMap.set(dataName, new Map());
    }
    dataMap.get(dataName)!.set(version, record);

    // Add to tag index
    for (const [key, value] of Object.entries(record.tags)) {
      const tagKey = `${key}:${value}`;
      if (!this.byTag.has(tagKey)) {
        this.byTag.set(tagKey, []);
      }
      this.byTag.get(tagKey)!.push(record);
    }
  }

  /**
   * Gets a specific version of data.
   */
  getVersion(
    modelName: string,
    dataName: string,
    version: number,
  ): DataRecord | null {
    return (
      this.byModelData.get(modelName)?.get(dataName)?.get(version) ?? null
    );
  }

  /**
   * Gets the latest version of data.
   */
  getLatest(modelName: string, dataName: string): DataRecord | null {
    const versions = this.listVersions(modelName, dataName);
    if (versions.length === 0) return null;
    const latestVersion = Math.max(...versions);
    return this.getVersion(modelName, dataName, latestVersion);
  }

  /**
   * Lists all version numbers for a data item in ascending order.
   */
  listVersions(modelName: string, dataName: string): number[] {
    const versionMap = this.byModelData.get(modelName)?.get(dataName);
    if (!versionMap) return [];
    return Array.from(versionMap.keys()).sort((a, b) => a - b);
  }

  /**
   * Finds all data records with a specific tag.
   */
  findByTag(tagKey: string, tagValue: string): DataRecord[] {
    return this.byTag.get(`${tagKey}:${tagValue}`) ?? [];
  }

  /**
   * Gets all data names for a model.
   */
  getDataNames(modelName: string): string[] {
    const dataMap = this.byModelData.get(modelName);
    if (!dataMap) return [];
    return Array.from(dataMap.keys());
  }
}

/**
 * Resolves model references to build CEL evaluation context.
 */
export class ModelResolver {
  private readonly outputRepo?: YamlOutputRepository;
  private vaultService?: VaultService;
  private readonly repoDir?: string;
  private readonly dataRepo?: UnifiedDataRepository;
  private vaultServiceInitialized = false;

  constructor(
    private readonly definitionRepo: YamlDefinitionRepository,
    repos?: ModelResolverRepositories,
  ) {
    this.outputRepo = repos?.outputRepo;
    this.repoDir = repos?.repoDir;
    this.dataRepo = repos?.dataRepo;
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
   * Type resolver function that maps model IDs to their types.
   */
  private typeResolver?: (modelId: string) => ModelType | undefined;

  /**
   * Builds a complete expression context from all available models.
   *
   * @param selfDefinition - The definition currently being evaluated (for self reference)
   * @param selfType - The model type of the self definition
   * @param typeResolver - Optional function to resolve model IDs to their types for data loading
   * @returns The expression context
   */
  async buildContext(
    selfDefinition?: Definition,
    selfType?: ModelType,
    typeResolver?: (modelId: string) => ModelType | undefined,
  ): Promise<ExpressionContext> {
    const context: ExpressionContext = {
      model: {},
      env: buildEnvContext(),
    };

    // Store type resolver for data loading
    this.typeResolver = typeResolver;

    // Load all definitions and build a map of ID -> type
    const allDefinitions = await this.definitionRepo.findAllGlobal();
    const idToType = new Map<string, ModelType>();
    const idToName = new Map<string, string>();

    for (const { definition, type: defType } of allDefinitions) {
      idToType.set(definition.id, defType);
      idToName.set(definition.id, definition.name);

      // Build model data from definition
      const modelData: ModelData = {
        input: {
          id: definition.id,
          name: definition.name,
          version: definition.version,
          tags: definition.tags,
          attributes: definition.attributes,
        },
        definition: {
          id: definition.id,
          name: definition.name,
          version: definition.version,
          tags: definition.tags,
          attributes: definition.attributes,
          inputs: definition.inputs,
        },
      };

      // Index by name
      context.model[definition.name] = modelData;
      // Also index by UUID for direct ID references
      context.model[definition.id] = modelData;
    }

    // Build data cache if dataRepo is available
    const dataCache = new DataCache();
    if (this.dataRepo) {
      for (const { definition, type: defType } of allDefinitions) {
        const modelType = typeResolver?.(definition.id) ?? defType;
        const modelName = definition.name;

        // Load all data for this model
        const allData = await this.dataRepo.findAllForModel(
          modelType,
          definition.id,
        );

        for (const data of allData) {
          // Get all versions for this data item
          const versions = await this.dataRepo.listVersions(
            modelType,
            definition.id,
            data.name,
          );

          for (const version of versions) {
            const versionData = await this.dataRepo.findByName(
              modelType,
              definition.id,
              data.name,
              version,
            );

            if (versionData) {
              // Parse attributes from content if JSON
              let attributes: Record<string, unknown> = {};
              if (versionData.contentType === "application/json") {
                const content = await this.dataRepo.getContent(
                  modelType,
                  definition.id,
                  data.name,
                  version,
                );
                if (content) {
                  try {
                    attributes = JSON.parse(
                      new TextDecoder().decode(content),
                    ) as Record<string, unknown>;
                  } catch {
                    // Not valid JSON, use empty attributes
                  }
                }
              }

              const record: DataRecord = {
                id: versionData.id,
                name: versionData.name,
                version: versionData.version,
                createdAt: versionData.createdAt.toISOString(),
                attributes,
                tags: { ...versionData.tags },
              };

              dataCache.addData(modelName, data.name, version, record);
            }
          }
        }

        // Populate model.data with latest versions
        const modelData = context.model[modelName];
        if (modelData) {
          const dataNames = dataCache.getDataNames(modelName);
          if (dataNames.length > 0) {
            const dataMap: Record<string, DataRecord> = {};
            for (const dataName of dataNames) {
              const latestRecord = dataCache.getLatest(modelName, dataName);
              if (latestRecord) {
                dataMap[dataName] = latestRecord;
              }
            }
            const entries = Object.values(dataMap);
            // Unwrap single artifact for direct DataRecord access
            modelData.data = entries.length === 1 ? entries[0] : dataMap;
          }
        }
      }
    }

    // Create data namespace with functions that query the cache
    context.data = {
      version: (
        modelName: string,
        dataName: string,
        version: number,
      ): DataRecord | null => {
        return dataCache.getVersion(modelName, dataName, version);
      },
      latest: (modelName: string, dataName: string): DataRecord | null => {
        return dataCache.getLatest(modelName, dataName);
      },
      listVersions: (modelName: string, dataName: string): number[] => {
        return dataCache.listVersions(modelName, dataName);
      },
      findByTag: (tagKey: string, tagValue: string): DataRecord[] => {
        return dataCache.findByTag(tagKey, tagValue);
      },
    };

    // Build self context if provided
    if (selfDefinition && selfType) {
      context.self = {
        id: selfDefinition.id,
        name: selfDefinition.name,
        version: selfDefinition.version,
        tags: selfDefinition.tags,
        attributes: selfDefinition.attributes,
      };
    }

    return context;
  }

  /**
   * Resolves a single model reference by name or ID.
   *
   * @param modelRef - The model name or UUID
   * @returns The definition and model type
   * @throws ModelNotFoundError if the model cannot be found
   */
  async resolveModel(modelRef: string): Promise<{
    definition: Definition;
    type: ModelType;
  }> {
    // Try by name first
    const byName = await this.definitionRepo.findByNameGlobal(modelRef);
    if (byName) {
      return {
        definition: byName.definition,
        type: byName.type,
      };
    }

    // Try by UUID - search across all types
    const allDefinitions = await this.definitionRepo.findAllGlobal();
    for (const { definition, type } of allDefinitions) {
      if (definition.id === modelRef) {
        return { definition, type };
      }
    }

    throw new ModelNotFoundError(modelRef);
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
