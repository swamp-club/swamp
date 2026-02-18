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

import type { ModelOutput } from "../models/model_output.ts";
import type { ModelType } from "../models/model_type.ts";
import type { Definition, InputsSchema } from "../definitions/definition.ts";
import type { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import type { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import type { UnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import type { Data } from "../data/data.ts";
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
 * File metadata record for CEL expressions.
 * Eagerly loaded into the model context.
 */
export interface FileDataRecord {
  id: string;
  version: number;
  createdAt: string;
  path: string;
  size: number;
  contentType: string;
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
    globalArguments: Record<string, unknown>;
  };
  definition?: {
    id: string;
    name: string;
    version: number;
    tags: Record<string, string>;
    globalArguments: Record<string, unknown>;
    inputs?: InputsSchema;
  };
  /** Resource data: specName → instanceName → DataRecord (includes id, version, attributes, etc.) */
  resource?: Record<string, Record<string, DataRecord>>;
  /** File metadata: specName → instanceName → file metadata (path, size, contentType, etc.) */
  file?: Record<string, Record<string, FileDataRecord>>;
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

  /**
   * Find all data records for a model that match a given spec name.
   * Uses the auto-injected `specName` tag to identify records from a specific output spec.
   * @param modelName - The model name
   * @param specName - The output spec name
   * @returns Array of matching DataRecords
   */
  findBySpec(modelName: string, specName: string): DataRecord[];
}

/**
 * Namespace for lazy-loading file contents in CEL expressions.
 */
export interface FileNamespace {
  /**
   * Lazy-load file contents from disk.
   * Reads file synchronously for CEL evaluation.
   *
   * @param modelName - The model name
   * @param specName - The file spec name
   * @returns The file contents as string, or null if not found
   */
  contents(modelName: string, specName: string): string | null;
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
    globalArguments: Record<string, unknown>;
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
  /** File namespace for lazy-loading file contents */
  file?: FileNamespace;
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

  // (modelName) -> (specName) -> DataRecord[]
  private byModelSpec: Map<string, Map<string, DataRecord[]>> = new Map();

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

    // Add to model+spec index (from specName tag)
    const specTag = record.tags["specName"];
    if (specTag) {
      if (!this.byModelSpec.has(modelName)) {
        this.byModelSpec.set(modelName, new Map());
      }
      const specMap = this.byModelSpec.get(modelName)!;
      if (!specMap.has(specTag)) {
        specMap.set(specTag, []);
      }
      specMap.get(specTag)!.push(record);
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
   * Finds all data records for a model that match a given spec name.
   * Uses the `specName` tag populated during data writes.
   */
  findBySpec(modelName: string, specName: string): DataRecord[] {
    return this.byModelSpec.get(modelName)?.get(specName) ?? [];
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
          globalArguments: definition.globalArguments,
        },
        definition: {
          id: definition.id,
          name: definition.name,
          version: definition.version,
          tags: definition.tags,
          globalArguments: definition.globalArguments,
          inputs: definition.inputs,
        },
      };

      // Index by name
      context.model[definition.name] = modelData;
      // Also index by UUID for direct ID references
      context.model[definition.id] = modelData;
    }

    // Build data cache if dataRepo is available.
    // Uses findAllGlobal() to discover data from disk first, then matches
    // to definitions. This handles the case where a model was deleted and
    // recreated (new UUID) — data under the old UUID is still found.
    const dataCache = new DataCache();
    if (this.dataRepo) {
      // Build definition lookup maps
      const defById = new Map<
        string,
        { definition: Definition; type: ModelType }
      >();
      const defsByType = new Map<
        string,
        Array<{ definition: Definition; type: ModelType }>
      >();

      for (const { definition: def, type: defType } of allDefinitions) {
        defById.set(def.id, { definition: def, type: defType });
        const typeKey = defType.normalized;
        if (!defsByType.has(typeKey)) defsByType.set(typeKey, []);
        defsByType.get(typeKey)!.push({ definition: def, type: defType });
      }

      // Discover all data on disk
      const allGlobalData = await this.dataRepo.findAllGlobal();

      // Group data items by (modelType, modelId) — the disk coordinates
      const groupKey = (mt: ModelType, mid: string) =>
        `${mt.normalized}::${mid}`;
      const groupedData = new Map<
        string,
        { modelType: ModelType; modelId: string; items: Data[] }
      >();
      for (const { data, modelType, modelId } of allGlobalData) {
        const key = groupKey(modelType, modelId);
        if (!groupedData.has(key)) {
          groupedData.set(key, { modelType, modelId, items: [] });
        }
        groupedData.get(key)!.items.push(data);
      }

      // Match each group to a definition and load data
      for (const [_key, group] of groupedData) {
        const { modelType, modelId, items } = group;

        // 1. Direct match: modelId matches a definition's UUID
        let matchedDef = defById.get(modelId);

        // 2. Orphan recovery by modelName tag
        if (!matchedDef) {
          const modelNameTag = items.find((d) => d.tags["modelName"])
            ?.tags["modelName"];
          if (modelNameTag) {
            const defsOfType = defsByType.get(modelType.normalized) ?? [];
            const nameMatch = defsOfType.find(
              (d) => d.definition.name === modelNameTag,
            );
            if (nameMatch) matchedDef = nameMatch;
          }
        }

        // 3. Orphan recovery by heuristic: only one definition of this type
        if (!matchedDef) {
          const defsOfType = defsByType.get(modelType.normalized) ?? [];
          if (defsOfType.length === 1) {
            matchedDef = defsOfType[0];
          }
        }

        if (!matchedDef) continue;

        const modelName = matchedDef.definition.name;

        // Process data items — use disk modelId for all repo calls
        for (const data of items) {
          const versions = await this.dataRepo.listVersions(
            modelType,
            modelId,
            data.name,
          );

          for (const version of versions) {
            const versionData = await this.dataRepo.findByName(
              modelType,
              modelId,
              data.name,
              version,
            );

            if (versionData) {
              // Parse attributes from content if JSON
              let attributes: Record<string, unknown> = {};
              if (versionData.contentType === "application/json") {
                const content = await this.dataRepo.getContent(
                  modelType,
                  modelId,
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

        // Populate model.resource and model.file from latest data versions
        const modelData = context.model[modelName];
        if (modelData) {
          const dataNames = dataCache.getDataNames(modelName);
          for (const dataName of dataNames) {
            const latestRecord = dataCache.getLatest(modelName, dataName);
            if (!latestRecord) continue;

            const dataType = latestRecord.tags["type"];

            if (dataType === "resource") {
              // Populate resource context: specName → instanceName → full DataRecord
              if (!modelData.resource) modelData.resource = {};
              const specName = latestRecord.tags["specName"] ?? dataName;
              if (!modelData.resource[specName]) {
                modelData.resource[specName] = {};
              }
              modelData.resource[specName][dataName] = latestRecord;
            } else if (dataType === "file") {
              // Populate file context: specName → instanceName → file metadata
              if (!modelData.file) modelData.file = {};
              const specName = latestRecord.tags["specName"] ?? dataName;
              if (!modelData.file[specName]) modelData.file[specName] = {};
              // Use disk modelId for content path lookup
              const contentPath = this.dataRepo.getContentPath(
                modelType,
                modelId,
                dataName,
                latestRecord.version as number,
              );
              try {
                const stat = Deno.statSync(contentPath);
                modelData.file[specName][dataName] = {
                  id: latestRecord.id as string,
                  version: latestRecord.version as number,
                  createdAt: latestRecord.createdAt as string,
                  path: contentPath,
                  size: stat.size,
                  contentType: latestRecord.tags["contentType"] ??
                    "application/octet-stream",
                };
              } catch {
                // File not found on disk, skip
              }
            }
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
      findBySpec: (modelName: string, specName: string): DataRecord[] => {
        return dataCache.findBySpec(modelName, specName);
      },
    };

    // Create file namespace for lazy-loading file contents
    context.file = {
      contents: (modelName: string, specName: string): string | null => {
        const modelData = context.model[modelName];
        if (!modelData?.file?.[specName]) return null;
        // Get the first instance under the spec
        const instances = modelData.file[specName];
        const firstKey = Object.keys(instances)[0];
        if (!firstKey) return null;
        const filePath = instances[firstKey].path;
        try {
          return Deno.readTextFileSync(filePath);
        } catch {
          return null;
        }
      },
    };

    // Build self context if provided
    if (selfDefinition && selfType) {
      context.self = {
        id: selfDefinition.id,
        name: selfDefinition.name,
        version: selfDefinition.version,
        tags: selfDefinition.tags,
        globalArguments: selfDefinition.globalArguments,
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
        globalArguments: definition.globalArguments,
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
        resolvedValue = resolvedValue.split(fullMatch).join(
          `"${escapedValue}"`,
        );
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
