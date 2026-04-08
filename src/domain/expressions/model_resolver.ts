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
import type { DataRecord } from "../data/data_record.ts";
import type { DataQueryService } from "../data/data_query_service.ts";
import { isTextContentType } from "../data/content_type.ts";
import { fromData } from "../data/data_record_mapper.ts";
import { ModelNotFoundError } from "./errors.ts";
import { VaultService } from "../vaults/vault_service.ts";
import type { SecretRedactor } from "../secrets/mod.ts";
import type { VaultSecretBag } from "../vaults/vault_secret_bag.ts";

/**
 * Builds env context from Deno environment variables.
 *
 * Returns the **entire** process environment as a flat string map. Values are
 * not filtered or redacted in any way.
 *
 * **Security note:** Any environment variable accessed via `env.VAR_NAME` in a
 * CEL expression will be embedded in model output data and **persisted to disk**
 * in `.swamp/data/`. This includes sensitive runtime values such as
 * `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, database passwords, etc.
 *
 * Prefer `vault.get(vaultName, secretKey)` for sensitive values — vault secrets
 * are fetched at runtime and are never written to model output data.
 */
export function buildEnvContext(): Record<string, string> {
  return { ...Deno.env.toObject() };
}

// Re-export DataRecord from its canonical location.
export type { DataRecord } from "../data/data_record.ts";

/** Escapes a string for safe embedding in a CEL string literal. */
function escapeCelString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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
   * Get a specific version of data. Remains file-system-based because
   * the catalog only stores the latest version per item.
   */
  version(
    modelName: string,
    dataName: string,
    version: number,
  ): Promise<DataRecord | null>;

  /**
   * Get the latest version of data. Delegates to catalog query.
   */
  latest(
    modelName: string,
    dataName: string,
  ): Promise<DataRecord | null>;

  /**
   * List all version numbers for a data item. Remains file-system-based.
   */
  listVersions(modelName: string, dataName: string): number[];

  /**
   * Find all data records with a specific tag. Delegates to catalog query.
   */
  findByTag(tagKey: string, tagValue: string): Promise<DataRecord[]>;

  /**
   * Find all data records for a model matching a spec name.
   * Delegates to catalog query — no hidden scoping.
   */
  findBySpec(modelName: string, specName: string): Promise<DataRecord[]>;

  /**
   * Query data artifacts using a CEL predicate, with optional projection.
   */
  query(
    predicate: string,
    select?: string,
  ): Promise<DataRecord[] | unknown[]>;
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
  /**
   * Full process environment, available as `env.VAR_NAME` in CEL expressions.
   *
   * **Security note:** Values accessed via `env` are not redacted. If used as
   * model attributes they will be stored in `.swamp/data/` on disk and visible
   * in `swamp data get` output. Use `vault.get()` for sensitive values instead.
   */
  env: Record<string, string>;
  /** Data namespace for versioned data access */
  data?: DataNamespace;
  /** File namespace for lazy-loading file contents */
  file?: FileNamespace;
  /**
   * Workflow run ID for scoping data queries.
   * When set, `data.findBySpec()` only returns data tagged with this run ID.
   * Set by the workflow engine after creating the run.
   */
  workflowRunId?: string;
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
  /** Optional data query service for CEL data.query() support */
  dataQueryService?: DataQueryService;
}

/**
 * Coordinates for locating a model's data on disk.
 * The modelType and modelId identify the disk path where data is stored,
 * which may differ from the current definition's UUID (e.g., after delete/recreate).
 */
export interface ModelCoordinates {
  modelType: ModelType;
  modelId: string;
}

/**
 * Map from model name to its disk coordinates.
 * A model may have multiple coordinate sets when data exists under
 * both the current and a previous UUID (orphan recovery).
 */
export type ModelCoordinatesMap = Map<string, ModelCoordinates[]>;

/**
 * Resolves model references to build CEL evaluation context.
 */
export class ModelResolver {
  private readonly outputRepo?: YamlOutputRepository;
  private vaultService?: VaultService;
  private readonly repoDir?: string;
  private readonly dataRepo?: UnifiedDataRepository;
  private readonly dataQueryService?: DataQueryService;
  private vaultServiceInitialized = false;

  constructor(
    private readonly definitionRepo: YamlDefinitionRepository,
    repos?: ModelResolverRepositories,
  ) {
    this.outputRepo = repos?.outputRepo;
    this.repoDir = repos?.repoDir;
    this.dataRepo = repos?.dataRepo;
    this.dataQueryService = repos?.dataQueryService;
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

    // Build model coordinates map and populate model.resource/file eagerly.
    // Uses findAllGlobal() to discover data from disk first, then matches
    // to definitions. This handles the case where a model was deleted and
    // recreated (new UUID) — data under the old UUID is still found.
    const coordsMap: ModelCoordinatesMap = new Map();
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

        // Add current definition coordinates
        const coords: ModelCoordinates = {
          modelType: defType,
          modelId: def.id,
        };
        if (!coordsMap.has(def.name)) coordsMap.set(def.name, []);
        coordsMap.get(def.name)!.push(coords);
      }

      // Discover all data on disk for orphan recovery and eager population
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

      // Match each group to a definition and populate model.resource/file
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

        // Add orphan coordinates (disk modelId differs from current definition UUID)
        if (modelId !== matchedDef.definition.id) {
          const orphanCoords: ModelCoordinates = { modelType, modelId };
          if (!coordsMap.has(modelName)) coordsMap.set(modelName, []);
          const existing = coordsMap.get(modelName)!;
          const alreadyTracked = existing.some(
            (c) =>
              c.modelType.normalized === modelType.normalized &&
              c.modelId === modelId,
          );
          if (!alreadyTracked) existing.push(orphanCoords);
        }

        // Populate model.resource and model.file eagerly (backward compat)
        // Skip renamed-tombstoned entries to avoid duplicates
        const modelData = context.model[modelName];
        if (modelData) {
          for (const data of items) {
            if (data.isRenamed) continue;
            const latestRecord = this.dataToRecord(
              data,
              modelType,
              modelId,
              data.name,
              undefined,
              modelName,
            );
            if (!latestRecord) continue;

            const dataType = latestRecord.tags["type"];

            if (dataType === "resource") {
              if (!modelData.resource) modelData.resource = {};
              const specName = latestRecord.tags["specName"] ?? data.name;
              if (!modelData.resource[specName]) {
                modelData.resource[specName] = {};
              }
              modelData.resource[specName][data.name] = latestRecord;
            } else if (dataType === "file") {
              if (!modelData.file) modelData.file = {};
              const specName = latestRecord.tags["specName"] ?? data.name;
              if (!modelData.file[specName]) modelData.file[specName] = {};
              const contentPath = this.dataRepo.getContentPath(
                modelType,
                modelId,
                data.name,
                latestRecord.version,
              );
              try {
                const stat = Deno.statSync(contentPath);
                modelData.file[specName][data.name] = {
                  id: latestRecord.id,
                  version: latestRecord.version,
                  createdAt: latestRecord.createdAt,
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

    // Create data namespace — most functions delegate to DataQueryService
    const dataRepo = this.dataRepo;
    context.data = {
      // version() and listVersions() remain file-system-based because the
      // catalog only stores the latest version per item.
      version: async (
        modelName: string,
        dataName: string,
        version: number,
      ): Promise<DataRecord | null> => {
        if (!dataRepo) return null;
        const allCoords = coordsMap.get(modelName);
        if (!allCoords) return null;
        for (const { modelType, modelId } of allCoords) {
          const data = dataRepo.findByNameSync(
            modelType,
            modelId,
            dataName,
            version,
          );
          if (data) {
            return await fromData(data, modelType, modelId, dataRepo, {
              version,
              modelName,
              dataName,
              vaultService: this.vaultService,
            });
          }
        }
        return null;
      },
      latest: async (
        modelName: string,
        dataName: string,
      ): Promise<DataRecord | null> => {
        if (!this.dataQueryService) return null;
        const escaped = escapeCelString;
        const predicate = `modelName == "${escaped(modelName)}" && name == "${
          escaped(dataName)
        }"`;
        const results = await this.dataQueryService.query(predicate, {
          limit: 1,
          loadAttributes: true,
        }) as DataRecord[];
        return results.length > 0 ? results[0] : null;
      },
      listVersions: (modelName: string, dataName: string): number[] => {
        if (!dataRepo) return [];
        const allCoords = coordsMap.get(modelName);
        if (!allCoords) return [];
        for (const { modelType, modelId } of allCoords) {
          const versions = dataRepo.listVersionsSync(
            modelType,
            modelId,
            dataName,
          );
          if (versions.length > 0) return versions;
        }
        return [];
      },
      findByTag: async (
        tagKey: string,
        tagValue: string,
      ): Promise<DataRecord[]> => {
        if (!this.dataQueryService) return [];
        const escaped = escapeCelString;
        const predicate = `tags.${escaped(tagKey)} == "${escaped(tagValue)}"`;
        return await this.dataQueryService.query(predicate, {
          loadAttributes: true,
        }) as DataRecord[];
      },
      findBySpec: async (
        specModelName: string,
        specName: string,
      ): Promise<DataRecord[]> => {
        if (!this.dataQueryService) return [];
        const escaped = escapeCelString;
        const predicate = `modelName == "${
          escaped(specModelName)
        }" && specName == "${escaped(specName)}"`;
        return await this.dataQueryService.query(predicate, {
          loadAttributes: true,
        }) as DataRecord[];
      },
      query: async (
        predicate: string,
        select?: string,
      ): Promise<DataRecord[] | unknown[]> => {
        if (!this.dataQueryService) return [];
        return await this.dataQueryService.query(predicate, { select });
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
   * Converts a Data entity to a DataRecord by reading content from disk synchronously.
   * Used by data.* namespace functions for sync CEL evaluation.
   */
  private dataToRecord(
    data: Data,
    modelType: ModelType,
    modelId: string,
    dataName: string,
    version?: number,
    modelName?: string,
  ): DataRecord | null {
    if (!this.dataRepo) return null;

    const resolvedVersion = version ?? data.version;
    let attributes: Record<string, unknown> = {};
    let textContent = "";

    if (isTextContentType(data.contentType)) {
      const rawBytes = this.dataRepo.getContentSync(
        modelType,
        modelId,
        dataName,
        resolvedVersion,
      );
      if (rawBytes) {
        const decoded = new TextDecoder().decode(rawBytes);
        textContent = decoded;
        if (data.contentType === "application/json") {
          try {
            attributes = JSON.parse(decoded) as Record<string, unknown>;
          } catch {
            // Not valid JSON, use empty attributes
          }
        }
      }
    }

    const resolvedModelName = modelName ?? data.tags["modelName"] ?? "";

    return {
      id: data.id,
      name: data.name,
      version: resolvedVersion,
      createdAt: data.createdAt.toISOString(),
      attributes,
      tags: { ...data.tags },
      modelName: resolvedModelName,
      modelType: modelType.normalized,
      specName: data.tags["specName"] ?? "",
      dataType: data.tags["type"] ?? "",
      contentType: data.contentType,
      lifetime: data.lifetime,
      ownerType: data.ownerDefinition.ownerType,
      streaming: data.streaming,
      size: data.size ?? 0,
      content: textContent,
      ownerRef: data.ownerDefinition.ownerRef,
      workflowRunId: data.ownerDefinition.workflowRunId ?? "",
      workflowName: data.ownerDefinition.workflowName ?? "",
      jobName: data.ownerDefinition.jobName ?? "",
      stepName: data.ownerDefinition.stepName ?? "",
      source: data.ownerDefinition.source ?? "",
    };
  }

  /**
   * Resolves vault expressions in a string by evaluating vault.get() calls.
   *
   * Secret values are replaced with sentinel tokens in the CEL expression.
   * The sentinel-to-value mapping is stored in the provided VaultSecretBag,
   * allowing callers to resolve sentinels later — either to raw values
   * (non-shell contexts) or to environment variable references (shell commands).
   *
   * @param value - The string that may contain vault expressions
   * @param redactor - Optional SecretRedactor to register resolved secret values for redaction
   * @param secretBag - VaultSecretBag to store sentinel-to-value mappings
   * @returns The string with vault.get() calls replaced by sentinel tokens wrapped as CEL strings
   */
  async resolveVaultExpressions(
    value: string,
    redactor?: SecretRedactor,
    secretBag?: VaultSecretBag,
  ): Promise<string> {
    // Pattern to match vault.get(vaultName, secretKey) expressions.
    // Handles both quoted and unquoted arguments. Quoted arguments may
    // contain spaces (e.g. vault.get("infra", "Client ID")).
    // Each argument uses alternation:
    //   (['"`])(.+?)\1  — quoted: any chars up to the matching close quote
    //   ([^\s,)]+)      — unquoted: non-whitespace, non-comma, non-paren
    const vaultPattern =
      /vault\.get\(\s*(?:(['"`])(.+?)\1|([^\s,)]+))\s*,\s*(?:(['"`])(.+?)\4|([^\s,)]+))\s*\)/g;

    let resolvedValue = value;
    const matches = Array.from(value.matchAll(vaultPattern));

    if (matches.length === 0) {
      return resolvedValue;
    }

    // Get vault service (lazy initialization if needed)
    const vaultService = await this.getVaultService();

    for (const match of matches) {
      // Groups: [1]=quote1, [2]=quoted vault, [3]=unquoted vault,
      //         [4]=quote2, [5]=quoted key,   [6]=unquoted key
      const fullMatch = match[0];
      const vaultName = match[2] ?? match[3];
      const secretKey = match[5] ?? match[6];
      try {
        const secretValue = await vaultService.get(vaultName, secretKey);
        redactor?.addSecret(secretValue);

        let celReplacement: string;
        if (secretBag) {
          // Sentinel-based resolution: secret value goes into the bag,
          // sentinel token goes into the CEL expression.
          const sentinel = secretBag.addSecret(secretValue);
          celReplacement = `"${sentinel}"`;
        } else {
          // Legacy fallback: escape for CEL string safety only.
          // No shell-specific escaping — shell safety is handled by the
          // shell model via VaultSecretBag.resolveForShell().
          const escapedValue = secretValue
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"')
            .replace(/'/g, "\\'")
            .replace(/\n/g, "\\n")
            .replace(/\r/g, "\\r")
            .replace(/\t/g, "\\t");
          celReplacement = `"${escapedValue}"`;
        }

        resolvedValue = resolvedValue.split(fullMatch).join(celReplacement);
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
