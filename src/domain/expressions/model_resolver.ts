// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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
import { getLogger } from "@logtape/logtape";
import type { ModelOutput } from "../models/model_output.ts";
import { ModelType } from "../models/model_type.ts";
import {
  CONTROL_PLANE_STORED_TYPES,
  isControlPlaneModelType,
} from "../models/control_plane_types.ts";
import type { Definition, InputsSchema } from "../definitions/definition.ts";
import type { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import type { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import type { UnifiedDataRepository } from "../data/repositories.ts";
import type { Data } from "../data/data.ts";
import type { DataRecord } from "../data/data_record.ts";
import type {
  DataQueryService,
  QueryView,
} from "../data/data_query_service.ts";
import {
  mergeModelData,
  modelIdentityPredicate,
} from "../data/data_access_service.ts";
import { isTextContentType } from "../data/content_type.ts";
import { localContentPath } from "../data/data_record_mapper.ts";
import { ModelNotFoundError } from "./errors.ts";
import { isUuid } from "../models/model_lookup.ts";
import { parseNamespacedModelName } from "../data/namespace.ts";
import type { Namespace } from "../data/namespace.ts";
import { UserError } from "../errors.ts";
import { isUnreadableContentError } from "../datastore/unreadable_content.ts";
import { markModelWording, wordedText } from "../behavior_wording.ts";
import { extractOwnNamespaceDataModelNames } from "./dependency_extractor.ts";
import { analyzeExpression } from "./expression_references.ts";
import {
  type VaultRefreshOptions,
  VaultService,
} from "../vaults/vault_service.ts";
import { createVaultRefreshOptions } from "../../infrastructure/vaults/vault_refresh.ts";
import type { RunSensitiveValues, SecretRedactor } from "../secrets/mod.ts";
import { attachSensitiveValues } from "./sensitive_context.ts";
import type { ProbeRedactor } from "../vaults/secret_reference_check.ts";
import { SecretLoader } from "../vaults/secret_loader.ts";

/**
 * returns the unfiltered process environment; env.* values land in persisted
 * model output, so prefer vault.get for secrets, which is never written to
 * output
 */
export function buildEnvContext(): Record<string, string> {
  return { ...Deno.env.toObject() };
}

// Re-export DataRecord and FileDataRecord from their canonical
// location. Importing here too so this file can use them locally.
import type { FileDataRecord } from "../data/data_record.ts";
export type { DataRecord, FileDataRecord } from "../data/data_record.ts";

function escapeCelString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

interface NamespaceRouting {
  modelName: string;
  namespacePredicate: string;
  isWildcard: boolean;
}

/**
 * no prefix scopes to the own namespace, ns:model to that namespace, *:model to
 * all namespaces with no filter (the caller must check ambiguity)
 */
function routeNamespace(
  rawModelName: string,
  ownNamespace: Namespace,
): NamespaceRouting {
  const parsed = parseNamespacedModelName(rawModelName);
  if (parsed.namespace === undefined) {
    return {
      modelName: parsed.modelName,
      namespacePredicate: ` && ns == "${escapeCelString(ownNamespace)}"`,
      isWildcard: false,
    };
  }
  if (parsed.namespace === "*") {
    return {
      modelName: parsed.modelName,
      namespacePredicate: "",
      isWildcard: true,
    };
  }
  return {
    modelName: parsed.modelName,
    namespacePredicate: ` && ns == "${escapeCelString(parsed.namespace)}"`,
    isWildcard: false,
  };
}

function checkWildcardAmbiguity(
  results: DataRecord[],
  rawModelName: string,
): void {
  if (results.length === 0) return;
  const namespaces = new Set(results.map((r) => r.namespace));
  if (namespaces.size > 1) {
    const sorted = [...namespaces].sort();
    throw new UserError(
      `Ambiguous: "${rawModelName.slice(2)}" exists in namespaces ` +
        `[${sorted.join(", ")}], qualify with a namespace prefix`,
    );
  }
}

/**
 * records with the same non-empty modelName and data name are one item under
 * different model UUIDs (orphan recovery); the newest wins, and an empty
 * modelName is never merged
 */
function deduplicateByName(
  records: DataRecord[],
  modelName?: string,
  preferred?: (record: DataRecord) => boolean,
): DataRecord[] {
  const byKey = new Map<string, DataRecord>();
  for (const record of records) {
    const name = modelName ?? record.modelName;
    const key = name
      ? `${name}\0${record.name}\0${record.stepName}`
      : record.id;
    const existing = byKey.get(key);
    if (
      !existing || record.createdAt > existing.createdAt ||
      (record.createdAt === existing.createdAt && preferred !== undefined &&
        preferred(record) && !preferred(existing))
    ) {
      byKey.set(key, record);
    }
  }
  return [...byKey.values()];
}

function localFileSize(path: string): number | null {
  try {
    return Deno.statSync(path).size;
  } catch {
    return null;
  }
}

function fileExists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * list lookups must not download every match on a lazy-hydration datastore, so
 * missing content paths are cleared; single-record lookups hydrate instead
 */
function dropMissingPaths(records: DataRecord[]): DataRecord[] {
  for (const record of records) {
    if (record.path && !fileExists(record.path)) record.path = "";
  }
  return records;
}

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
  resource?: Record<string, Record<string, DataRecord>>;
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
 * resolve (default) reads own-namespace tagged fields from the reader's vaults
 * into plaintext; stored returns the record as stored with no vault read, the
 * typed path authorizing each reference itself
 */
export interface DataReadOptions {
  readonly sensitiveFields?: "resolve" | "stored";
}

export interface DataNamespace {
  readonly namespace?: Namespace;

  /**
   * Whether the reader reads the solo namespace as another namespace, as a
   * v3 checkout does, so a solo row is not its own (see
   * `isForeignNamespace`). Absent reads as false.
   */
  readonly readsSoloNamespace?: boolean;

  version(
    modelName: string,
    dataName: string,
    version: number,
  ): Promise<DataRecord | null>;

  latest(
    modelName: string,
    dataName: string,
    options?: DataReadOptions,
  ): Promise<DataRecord | null>;

  /**
   * stays synchronous so it works in sync CEL contexts that skip the async
   * evaluator
   */
  listVersions(modelName: string, dataName: string): number[];

  findByTag(tagKey: string, tagValue: string): Promise<DataRecord[]>;

  findBySpec(modelName: string, specName: string): Promise<DataRecord[]>;

  /**
   * Data names of the latest records a model wrote under `specName`, newest
   * first, scoped to the namespaces `latest()` would search. Used only to
   * explain a `latest()`/`version()` miss whose argument was a spec name.
   */
  specInstanceNames?(modelName: string, specName: string): string[];

  query(
    predicate: string,
    select?: string,
    view?: QueryView,
  ): Promise<DataRecord[] | unknown[]>;

  /**
   * no-op kept for interface compatibility; latest() always reads from disk, so
   * there is no cache to invalidate
   */
  invalidateLatest?(modelName: string, dataName: string): void;

  /**
   * runs before evaluation because some reads are synchronous: resolves
   * definitions for listVersions and makes content local so lazily hydrating
   * datastores do not yield empty or stale data
   */
  prepare?(expression: string): Promise<void>;
}

interface ReadSetState {
  readonly coordsByRef: Map<string, ModelCoordinates[]>;
  /**
   * Updates a model's already-loaded maps in place with items whose
   * content `prepare` changed, keyed like {@link coordsByRef}. A model
   * whose getter has not fired yet is left to load current content itself.
   */
  readonly refreshers: Map<string, (items: ChangedItem[]) => void>;
  readonly ensured: Set<string>;
}

interface ChangedItem {
  readonly data: Data;
  readonly modelType: ModelType;
  readonly modelId: string;
}

export interface FileNamespace {
  contents(modelName: string, specName: string): string | null;
}

export interface WorkersNamespace {
  connected(): Promise<DataRecord[]>;
}

/**
 * Workflow run metadata exposed as `run.*` in CEL expressions.
 * Populated by the workflow engine after the run starts; only available
 * inside workflow step inputs (not during workflow-level evaluation).
 */
export interface RunContext {
  id: string;
  workflowId: string;
  workflowName: string;
  startedAt: string;
  tags: Record<string, string>;
  initiatedBy?: string;
  inputs?: Record<string, unknown>;
}

/**
 * a context may carry the output sources under a symbol key that CEL cannot
 * read; the typed evaluator views the outputs through them
 */
export interface StepContext {
  status: string;
  outputs?: Record<string, unknown>;
}

/**
 * header values are not redacted and the signature header is excluded; a header
 * mapped into a model attribute is stored and visible in data output
 */
export interface WebhookPayload {
  body: unknown;
  headers: Record<string, string>;
  route: string;
}

export interface ExpressionContext {
  deferredExpressions?:
    readonly import("./deferred_expression.ts").DeferredExpression[];
  model: Record<string, ModelData>;
  self?: {
    id: string;
    name: string;
    version: number;
    tags: Record<string, string>;
    globalArguments: Record<string, unknown>;
    [key: string]: unknown;
  };
  inputs?: Record<string, unknown>;
  workflow?: Record<string, unknown>;
  vault?: {
    get(vaultName: string, secretKey: string): string;
  };
  /**
   * env values are not redacted; used as model attributes they are stored on
   * disk and visible in data output, so use vault.get() for secrets
   */
  env: Record<string, string>;
  data?: DataNamespace;
  workers?: WorkersNamespace;
  file?: FileNamespace;
  workflowRunId?: string;
  run?: RunContext;
  steps?: Record<string, StepContext>;
  webhook?: WebhookPayload;
  [key: string]: unknown;
}

export interface ModelResolverRepositories {
  outputRepo?: YamlOutputRepository;
  vaultService?: VaultService;
  repoDir?: string;
  vaultsDir?: string;
  dataRepo?: UnifiedDataRepository;
  dataQueryService?: DataQueryService;
  vaultRefreshOptions?: VaultRefreshOptions;
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

function populateFromItems(
  items: Data[],
  result: {
    resource?: Record<string, Record<string, DataRecord>>;
    file?: Record<string, Record<string, FileDataRecord>>;
  },
  dataRepo: UnifiedDataRepository,
  toRecord: (
    data: Data,
    modelType: ModelType,
    modelId: string,
    dataName: string,
    version?: number,
    modelName?: string,
  ) => DataRecord | null,
  defName: string,
  overrideModelType?: ModelType,
  overrideModelId?: string,
): void {
  for (const data of items) {
    if (data.isRenamed) continue;
    if (!overrideModelType || !overrideModelId) continue;
    const mt = overrideModelType;
    const mid = overrideModelId;
    const latestRecord = toRecord(data, mt, mid, data.name, undefined, defName);
    if (!latestRecord) continue;

    const dataType = latestRecord.tags["type"];
    if (dataType === "resource") {
      if (!result.resource) result.resource = {};
      const specName = latestRecord.tags["specName"] ?? data.name;
      if (!result.resource[specName]) result.resource[specName] = {};
      result.resource[specName][data.name] = latestRecord;
    } else if (dataType === "file") {
      if (!result.file) result.file = {};
      const specName = latestRecord.tags["specName"] ?? data.name;
      if (!result.file[specName]) result.file[specName] = {};
      const contentPath = dataRepo.getContentPath(
        mt,
        mid,
        data.name,
        latestRecord.version,
      );
      try {
        const stat = Deno.statSync(contentPath);
        result.file[specName][data.name] = {
          id: latestRecord.id,
          version: latestRecord.version,
          createdAt: latestRecord.createdAt,
          path: contentPath,
          size: stat.size,
          contentType: latestRecord.tags["contentType"] ??
            "application/octet-stream",
        } as FileDataRecord;
      } catch {
        // File not found on disk, skip
      }
    }
  }
}

export class ModelResolver {
  private readonly outputRepo?: YamlOutputRepository;
  private vaultService?: VaultService;
  private readonly repoDir?: string;
  private readonly vaultsDir?: string;
  private readonly dataRepo?: UnifiedDataRepository;
  private readonly dataQueryService?: DataQueryService;
  private readonly vaultRefreshOptions?: VaultRefreshOptions;
  private vaultServiceInitialized = false;
  /**
   * shared by every light context this resolver builds so a name is looked up
   * once; a stale entry only falls back to or adds to the name-tag read
   */
  private readonly identityLookups = new Map<string, ModelCoordinates[]>();
  private readonly pendingIdentityLookups = new Map<
    string,
    Promise<ModelCoordinates[]>
  >();

  constructor(
    private readonly definitionRepo: YamlDefinitionRepository,
    repos?: ModelResolverRepositories,
  ) {
    this.outputRepo = repos?.outputRepo;
    this.repoDir = repos?.repoDir;
    this.vaultsDir = repos?.vaultsDir;
    this.dataRepo = repos?.dataRepo;
    this.dataQueryService = repos?.dataQueryService;
    this.vaultRefreshOptions = repos?.vaultRefreshOptions;
    if (repos?.vaultService) {
      this.vaultService = repos.vaultService;
      this.vaultServiceInitialized = true;
    }
  }

  private async getVaultService(): Promise<VaultService> {
    if (this.vaultServiceInitialized && this.vaultService) {
      return this.vaultService;
    }

    const refreshOpts = this.vaultRefreshOptions ??
      createVaultRefreshOptions();
    if (this.repoDir) {
      this.vaultService = await VaultService.fromRepository(
        this.repoDir,
        { refreshOptions: refreshOpts, vaultsDir: this.vaultsDir },
      );
    } else {
      this.vaultService = new VaultService(refreshOpts);
      this.vaultService.ensureDefaultVaults();
    }
    this.vaultServiceInitialized = true;
    return this.vaultService;
  }

  private typeResolver?: (modelId: string) => ModelType | undefined;

  async buildContext(
    sensitiveValues: RunSensitiveValues,
    selfDefinition?: Definition,
    selfType?: ModelType,
    typeResolver?: (modelId: string) => ModelType | undefined,
    definitions?: { definition: Definition; type: ModelType }[],
  ): Promise<ExpressionContext> {
    const context: ExpressionContext = {
      model: {},
      env: buildEnvContext(),
    };

    this.typeResolver = typeResolver;

    const allDefinitions = definitions ??
      await this.definitionRepo.findAllGlobal();
    const idToType = new Map<string, ModelType>();
    const idToName = new Map<string, string>();

    // control-plane models (grants, groups, tokens, workers) are never
    // addressable from an expression, neither as model.<name> nor through their
    // data
    const visibleDefinitions = allDefinitions.filter(({ type }) =>
      !isControlPlaneModelType(type.normalized)
    );
    for (const { definition, type: defType } of visibleDefinitions) {
      idToType.set(definition.id, defType);
      idToName.set(definition.id, definition.name);

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

      context.model[definition.name] = modelData;
      context.model[definition.id] = modelData;
    }

    // coordinates come from definitions, O(definitions) not O(data);
    // model.resource and model.file load lazily on first access to avoid the
    // O(N) findAllGlobal() walk
    const coordsMap: ModelCoordinatesMap = new Map();
    let readSet: ReadSetState | undefined;
    if (this.dataRepo) {
      for (const { definition: def, type: defType } of visibleDefinitions) {
        const coords: ModelCoordinates = {
          modelType: defType,
          modelId: def.id,
        };
        if (!coordsMap.has(def.name)) coordsMap.set(def.name, []);
        coordsMap.get(def.name)!.push(coords);
      }
      // model["<id>"] reads the same entry, and so the same coordinates, as
      // model.<name>.
      const coordsByRef = new Map(coordsMap);
      for (const { definition: def } of visibleDefinitions) {
        coordsByRef.set(def.id, coordsMap.get(def.name)!);
      }
      readSet = { coordsByRef, refreshers: new Map(), ensured: new Set() };

      const dataRepo = this.dataRepo;
      const boundDataToRecord = this.dataToRecord.bind(this);
      let orphanData:
        | Array<{ data: Data; modelType: ModelType; modelId: string }>
        | null = null;
      for (const { definition: def } of allDefinitions) {
        const modelData = context.model[def.name];
        if (!modelData) continue;

        const defName = def.name;

        const loadResources = (): {
          resource?: Record<string, Record<string, DataRecord>>;
          file?: Record<string, Record<string, FileDataRecord>>;
        } => {
          const result: {
            resource?: Record<string, Record<string, DataRecord>>;
            file?: Record<string, Record<string, FileDataRecord>>;
          } = {};
          const allCoords = coordsMap.get(defName) ?? [];

          for (const { modelType: mt, modelId: mid } of allCoords) {
            const items = dataRepo.findAllForModelSync(mt, mid);
            populateFromItems(
              items,
              result,
              dataRepo,
              boundDataToRecord,
              defName,
              mt,
              mid,
            );
          }

          // orphan recovery: with no data under the current coordinates, scan
          // the datastore once (shared across models) for orphan data tagged
          // with this model's name
          if (!result.resource && !result.file) {
            if (!orphanData) {
              orphanData = dataRepo.findAllGlobalSync();
            }
            for (
              const { data, modelType: mt, modelId: mid } of orphanData
            ) {
              if (
                data.isRenamed || data.tags["modelName"] !== defName ||
                isControlPlaneModelType(mt.normalized)
              ) {
                continue;
              }
              populateFromItems(
                [data],
                result,
                dataRepo,
                boundDataToRecord,
                defName,
                mt,
                mid,
              );
            }
          }

          return result;
        };

        Object.defineProperty(modelData, "resource", {
          configurable: true,
          enumerable: true,
          get() {
            const loaded = loadResources();
            Object.defineProperty(this, "resource", {
              value: loaded.resource,
              writable: true,
              configurable: true,
              enumerable: true,
            });
            Object.defineProperty(this, "file", {
              value: loaded.file,
              writable: true,
              configurable: true,
              enumerable: true,
            });
            return loaded.resource;
          },
        });

        const refresh = (items: ChangedItem[]): void => {
          // Until a getter fires, the maps are not loaded and will read the
          // content just made local.
          if (Object.getOwnPropertyDescriptor(modelData, "resource")?.get) {
            return;
          }
          const fresh: {
            resource?: Record<string, Record<string, DataRecord>>;
            file?: Record<string, Record<string, FileDataRecord>>;
          } = {};
          for (const item of items) {
            populateFromItems(
              [item.data],
              fresh,
              dataRepo,
              boundDataToRecord,
              defName,
              item.modelType,
              item.modelId,
            );
          }
          // only changed items are replaced; records a step merged in after the
          // getter fired were written locally, never changed by prepare, and
          // are kept
          for (
            const [spec, instances] of Object.entries(fresh.resource ?? {})
          ) {
            modelData.resource ??= {};
            modelData.resource[spec] ??= {};
            Object.assign(modelData.resource[spec], instances);
          }
          for (const [spec, instances] of Object.entries(fresh.file ?? {})) {
            modelData.file ??= {};
            modelData.file[spec] ??= {};
            Object.assign(modelData.file[spec], instances);
          }
        };
        readSet.refreshers.set(def.name, refresh);
        readSet.refreshers.set(def.id, refresh);

        Object.defineProperty(modelData, "file", {
          configurable: true,
          enumerable: true,
          get() {
            const loaded = loadResources();
            Object.defineProperty(this, "resource", {
              value: loaded.resource,
              writable: true,
              configurable: true,
              enumerable: true,
            });
            Object.defineProperty(this, "file", {
              value: loaded.file,
              writable: true,
              configurable: true,
              enumerable: true,
            });
            return loaded.file;
          },
        });
      }
    }

    const ownNamespace = this.dataRepo?.namespace ?? ("" as Namespace);
    context.data = this.buildDataNamespace(
      ownNamespace,
      coordsMap,
      false,
      readSet,
    );
    context.workers = this.buildWorkersNamespace();
    attachSensitiveValues(context, sensitiveValues);

    context.file = {
      contents: (modelName: string, specName: string): string | null => {
        const modelData = context.model[modelName];
        if (!modelData?.file?.[specName]) return null;
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
   * light context: data and env only, no definition loading, model data or file
   * namespace; used when expressions read no model or file namespace, and by
   * --last-evaluated for deferred data.* expressions
   */
  buildLightContext(sensitiveValues: RunSensitiveValues): ExpressionContext {
    const ownNamespace = this.dataRepo?.namespace ?? ("" as Namespace);
    const context: ExpressionContext = {
      model: {},
      env: buildEnvContext(),
    };
    context.data = this.buildDataNamespace(
      ownNamespace,
      new Map(),
      true,
    );
    context.workers = this.buildWorkersNamespace();
    attachSensitiveValues(context, sensitiveValues);
    return context;
  }

  /**
   * hydration can add a path but never fail a lookup: if the file is still
   * absent or the fetch fails, path is cleared. List lookups use
   * dropMissingPaths so they never download.
   */
  private async materializePath(record: DataRecord | null): Promise<void> {
    if (!record?.path || !this.dataRepo) return;
    try {
      await this.dataRepo.ensureContentLocal(
        ModelType.create(record.modelType),
        record.modelId,
        record.name,
        record.version,
        record.size,
      );
    } catch (error) {
      if (isUnreadableContentError(error)) throw error;
      getLogger(["swamp", "expressions"])
        .debug`Could not hydrate ${record.modelName}/${record.name}@v${record.version}: ${
        String(error)
      }`;
    }
    if (!fileExists(record.path)) record.path = "";
  }

  /**
   * ensures only what synchronous readers read (text resources, files of the
   * specs read), once per context; loaded maps get changed items; a download
   * error fails the evaluation, as it fails data get
   */
  private async ensureReadSet(
    expression: string,
    state: ReadSetState,
  ): Promise<void> {
    const dataRepo = this.dataRepo;
    // Only the model map and the file namespace read synchronously.
    if (!dataRepo || !/\b(?:model|file)\b/.test(expression)) return;
    const reads = analyzeExpression(expression).syncDataReads;
    for (const [ref, read] of reads) {
      const coords = state.coordsByRef.get(ref);
      if (!coords) continue;
      const wanted = (data: Data): boolean => {
        const kind = data.tags["type"];
        if (kind === "resource") {
          return read.resource && isTextContentType(data.contentType);
        }
        if (kind === "file") {
          return read.allFiles ||
            read.fileSpecs.has(data.tags["specName"] ?? data.name);
        }
        return false;
      };
      const changed: ChangedItem[] = [];
      for (const { modelType, modelId } of coords) {
        const keys = [
          ...(read.resource ? ["resource"] : []),
          ...(read.allFiles ? ["file"] : []),
          ...[...read.fileSpecs].map((spec) => `file:${spec}`),
        ].map((k) => `${modelType.normalized}/${modelId}/${k}`);
        const covered = (key: string) =>
          state.ensured.has(key) ||
          (key.includes("/file:") &&
            state.ensured.has(key.replace(/\/file:.*$/, "/file")));
        if (keys.every(covered)) continue;
        for (const data of await dataRepo.findAllForModel(modelType, modelId)) {
          if (data.isRenamed || !wanted(data)) continue;
          const contentPath = dataRepo.getContentPath(
            modelType,
            modelId,
            data.name,
            data.version,
          );
          const before = localFileSize(contentPath);
          try {
            await dataRepo.ensureContentLocal(
              modelType,
              modelId,
              data.name,
              data.version,
              data.size,
            );
          } catch (error) {
            if (isUnreadableContentError(error)) throw error;
            const worded = wordedText((w) =>
              `Could not download ${data.name} of ${w.noun} ${ref}, which ` +
              `the expression reads: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
            throw markModelWording(
              new Error(worded.text, { cause: error }),
              worded.modelText,
            );
          }
          if (localFileSize(contentPath) !== before) {
            changed.push({ data, modelType, modelId });
          }
        }
        for (const key of keys) state.ensured.add(key);
      }
      if (changed.length > 0) state.refreshers.get(ref)?.(changed);
    }
  }

  private buildWorkersNamespace(): WorkersNamespace {
    return {
      connected: async (): Promise<DataRecord[]> => {
        if (!this.dataQueryService) return [];
        const predicate =
          `modelType == "swamp/worker" && name == "state-main" && ` +
          `attributes.status != "disconnected"`;
        return await this.dataQueryService.query(predicate, {
          loadAttributes: true,
        }) as DataRecord[];
      },
    };
  }

  /**
   * uses the primary definition of that name, the same definitions the full
   * context's coordinates map is built from, so both contexts read the same
   * model
   */
  private async lookUpModelCoordinates(
    modelName: string,
  ): Promise<ModelCoordinates[]> {
    try {
      const found = await this.definitionRepo.findByNameGlobal(modelName);
      if (
        !found || isControlPlaneModelType(found.type.normalized) ||
        await this.definitionRepo.isAutoDefinition(
          found.definition,
          found.type,
        )
      ) {
        return [];
      }
      return [{ modelType: found.type, modelId: found.definition.id }];
    } catch (error) {
      getLogger(["swamp", "expressions"])
        .warn`Could not look up the definition of ${modelName}; reading its data by name tag only: ${
        error instanceof Error ? error.message : String(error)
      }`;
      return [];
    }
  }

  /**
   * lookUpIdentities: the full context passes every definition's coordinates,
   * so a name missing from coordsMap has no definition; the light context
   * passes none
   */
  private buildDataNamespace(
    ownNamespace: Namespace,
    coordsMap: ModelCoordinatesMap,
    lookUpIdentities = false,
    readSet?: ReadSetState,
  ): DataNamespace {
    // the modelName tag records the name at write time, so an own-namespace
    // read also selects by definition type and id, finding data written before
    // a rename
    const lookedUp = this.identityLookups;
    const lookUps = this.pendingIdentityLookups;
    const knownIdentities = (
      modelName: string,
    ): ModelCoordinates[] | undefined =>
      coordsMap.get(modelName) ?? lookedUp.get(modelName) ??
        (lookUpIdentities ? undefined : []);
    const resolveIdentities = (
      modelName: string,
    ): Promise<ModelCoordinates[]> => {
      const known = knownIdentities(modelName);
      if (known) return Promise.resolve(known);
      let pending = lookUps.get(modelName);
      if (!pending) {
        pending = this.lookUpModelCoordinates(modelName).then((coords) => {
          lookedUp.set(modelName, coords);
          return coords;
        });
        lookUps.set(modelName, pending);
      }
      return pending;
    };
    const identityPredicates = (
      coords: ModelCoordinates[],
      filter: string,
    ): string[] =>
      coords
        .filter(({ modelType }) =>
          !isControlPlaneModelType(modelType.normalized)
        )
        .map(({ modelType, modelId }) =>
          modelIdentityPredicate({
            modelType: modelType.normalized,
            modelId,
          }) + filter + ` && ns == "${escapeCelString(ownNamespace)}"`
        );

    return {
      namespace: ownNamespace,
      readsSoloNamespace:
        this.dataRepo?.fetchForeignContent?.readsSoloNamespace === true,
      version: async (
        rawModelName: string,
        dataName: string,
        version: number,
      ): Promise<DataRecord | null> => {
        if (!this.dataQueryService) return null;
        const ns = routeNamespace(rawModelName, ownNamespace);
        const predicate = `modelName == "${escapeCelString(ns.modelName)}" ` +
          `&& name == "${escapeCelString(dataName)}" && version == ${version}` +
          ns.namespacePredicate;
        const results = await this.dataQueryService.query(predicate, {
          limit: ns.isWildcard ? undefined : 1,
          loadAttributes: true,
          excludeModelTypes: CONTROL_PLANE_STORED_TYPES,
          includeContentPath: true,
        }) as DataRecord[];
        if (ns.isWildcard) {
          checkWildcardAmbiguity(results, rawModelName);
        }
        if (
          results.length === 0 &&
          parseNamespacedModelName(rawModelName).namespace === undefined
        ) {
          const coords = await resolveIdentities(ns.modelName);
          for (
            const predicate of identityPredicates(
              coords,
              ` && name == "${escapeCelString(dataName)}"` +
                ` && version == ${version}`,
            )
          ) {
            const [found] = await this.dataQueryService.query(predicate, {
              limit: 1,
              loadAttributes: true,
              excludeModelTypes: CONTROL_PLANE_STORED_TYPES,
              includeContentPath: true,
            }) as DataRecord[];
            if (found) {
              results.push(found);
              break;
            }
          }
        }
        if (results.length === 0) return null;
        await this.materializePath(results[0]);
        return results[0];
      },
      latest: async (
        rawModelName: string,
        dataName: string,
        _options?: DataReadOptions,
      ): Promise<DataRecord | null> => {
        if (!this.dataRepo) return null;
        const ns = routeNamespace(rawModelName, ownNamespace);
        // A stored read returns the record's references as written and
        // reads no vault; the typed expression path authorizes them itself
        // (typed-secrets 3.3).

        if (!ns.isWildcard) {
          // a namespaced name is never read through the caller's own definition
          // of that name: its coordinates select this repository's data
          // whatever namespace was asked for
          const coords =
            parseNamespacedModelName(rawModelName).namespace === undefined
              ? await resolveIdentities(ns.modelName)
              : undefined;
          if (coords && coords.length > 0) {
            for (const { modelType, modelId } of coords) {
              if (isControlPlaneModelType(modelType.normalized)) continue;
              const data = await this.dataRepo.findByName(
                modelType,
                modelId,
                dataName,
              );
              if (data) {
                if (
                  data.tags["specName"] &&
                  dataName === data.tags["specName"] &&
                  this.dataQueryService
                ) {
                  const targetNs = ns.namespacePredicate
                    ? ns.namespacePredicate.match(
                      /ns == "([^"]*)"/,
                    )?.[1]
                    : (ownNamespace || undefined);
                  this.dataQueryService.checkSpecNameAmbiguity(
                    data.tags["specName"],
                    ns.modelName,
                    targetNs,
                    CONTROL_PLANE_STORED_TYPES,
                    { modelType, modelId },
                  );
                }
                // dataToRecord reads content synchronously, so make it local
                // and current first or a lazy datastore returns empty
                // attributes.
                let available = false;
                try {
                  available = await this.dataRepo.ensureContentLocal(
                    modelType,
                    modelId,
                    dataName,
                    data.version,
                    data.size,
                  ) !== "missing";
                } catch (error) {
                  if (isUnreadableContentError(error)) throw error;
                  getLogger(["swamp", "expressions"])
                    .debug`Could not hydrate ${ns.modelName}/${data.name}@v${data.version}: ${
                    String(error)
                  }`;
                }
                const record = this.dataToRecord(
                  data,
                  modelType,
                  modelId,
                  dataName,
                  undefined,
                  ns.modelName,
                );
                // Content was ensured above, so the path only needs to name
                // a present file; it is not requested a second time.
                if (record?.path && (!available || !fileExists(record.path))) {
                  record.path = "";
                }
                return record;
              }
            }
          }

          if (this.dataQueryService) {
            const targetNs = ns.namespacePredicate
              ? ns.namespacePredicate.match(
                /ns == "([^"]*)"/,
              )?.[1]
              : (ownNamespace || undefined);
            const record = await this.dataQueryService.getLatestRecord(
              ns.modelName,
              dataName,
              targetNs,
              {
                includeContentPath: true,
                excludeModelTypes: CONTROL_PLANE_STORED_TYPES,
              },
            );
            // Resolve vault references through this resolver's vault service;
            // another namespace's record is returned as stored so its tags
            // cannot choose secrets.
            await this.materializePath(record);
            return record;
          }

          return null;
        }

        if (!this.dataQueryService) return null;
        const predicate = `modelName == "${escapeCelString(ns.modelName)}" ` +
          `&& name == "${escapeCelString(dataName)}"` +
          ns.namespacePredicate;
        const results = await this.dataQueryService.query(predicate, {
          loadAttributes: true,
          excludeModelTypes: CONTROL_PLANE_STORED_TYPES,
          includeContentPath: true,
        }) as DataRecord[];
        checkWildcardAmbiguity(results, rawModelName);
        if (results.length > 0) {
          const specName = results[0].specName;
          if (specName && dataName === specName) {
            this.dataQueryService.checkSpecNameAmbiguity(
              specName,
              ns.modelName,
              undefined,
              CONTROL_PLANE_STORED_TYPES,
            );
          }
          await this.materializePath(results[0]);
          return results[0];
        }
        return null;
      },
      listVersions: (rawModelName: string, dataName: string): number[] => {
        if (!this.dataQueryService) return [];
        const ns = routeNamespace(rawModelName, ownNamespace);
        const predicate = `modelName == "${escapeCelString(ns.modelName)}" ` +
          `&& name == "${escapeCelString(dataName)}" && version >= 0` +
          ns.namespacePredicate;
        if (ns.isWildcard) {
          const records = this.dataQueryService.querySync(predicate, {
            excludeModelTypes: CONTROL_PLANE_STORED_TYPES,
          }) as DataRecord[];
          checkWildcardAmbiguity(records, rawModelName);
          return records.map((r) => r.version).sort((a, b) => a - b);
        }
        const coords =
          parseNamespacedModelName(rawModelName).namespace === undefined
            ? knownIdentities(ns.modelName)
            : undefined;
        if (coords && coords.length > 0) {
          // full records, not select version: mergeModelData needs each
          // record's identity to drop ones both reads return; versions under an
          // earlier id sharing the name are still listed
          const queryService = this.dataQueryService;
          const predicates = [
            predicate,
            ...identityPredicates(
              coords,
              ` && name == "${escapeCelString(dataName)}" && version >= 0`,
            ),
          ];
          const records = mergeModelData(
            ...predicates.map((p) =>
              queryService.querySync(p, {
                excludeModelTypes: CONTROL_PLANE_STORED_TYPES,
              }) as DataRecord[]
            ),
          );
          return records.map((r) => r.version).sort((a, b) => a - b);
        }
        const results = this.dataQueryService.querySync(predicate, {
          select: "version",
          excludeModelTypes: CONTROL_PLANE_STORED_TYPES,
        }) as number[];
        return results.slice().sort((a, b) => a - b);
      },
      findByTag: async (
        tagKey: string,
        tagValue: string,
      ): Promise<DataRecord[]> => {
        if (!this.dataQueryService) return [];
        const nsPredicate = ` && ns == "${escapeCelString(ownNamespace)}"`;
        const predicate =
          `tags.${escapeCelString(tagKey)} == "${escapeCelString(tagValue)}"` +
          nsPredicate;
        const results = await this.dataQueryService.query(predicate, {
          loadAttributes: true,
          excludeModelTypes: CONTROL_PLANE_STORED_TYPES,
          includeContentPath: true,
          latestPerStep: true,
        }) as DataRecord[];
        return dropMissingPaths(deduplicateByName(results));
      },
      findBySpec: async (
        rawSpecModelName: string,
        specName: string,
      ): Promise<DataRecord[]> => {
        if (!this.dataQueryService) return [];
        const ns = routeNamespace(rawSpecModelName, ownNamespace);
        const predicate = `modelName == "${escapeCelString(ns.modelName)}" ` +
          `&& specName == "${escapeCelString(specName)}"` +
          ns.namespacePredicate;
        const options = {
          loadAttributes: true,
          excludeModelTypes: CONTROL_PLANE_STORED_TYPES,
          includeContentPath: true,
          latestPerStep: true,
        };
        let results = await this.dataQueryService.query(
          predicate,
          options,
        ) as DataRecord[];
        if (ns.isWildcard) {
          checkWildcardAmbiguity(results, rawSpecModelName);
        }
        if (
          parseNamespacedModelName(rawSpecModelName).namespace === undefined
        ) {
          const coords = await resolveIdentities(ns.modelName);
          const identityReads = identityPredicates(
            coords,
            ` && specName == "${escapeCelString(specName)}"`,
          );
          for (const identityPredicate of identityReads) {
            results = mergeModelData(
              results,
              await this.dataQueryService.query(
                identityPredicate,
                options,
              ) as DataRecord[],
            );
          }
          if (identityReads.length > 0) {
            // every record now belongs to this name, whatever its tag recorded;
            // on a tie the definition's own record wins, as latest() reads it
            // first
            const ownRecord = (record: DataRecord) =>
              coords.some(({ modelType, modelId }) =>
                record.modelType === modelType.normalized &&
                record.modelId === modelId
              );
            return dropMissingPaths(
              deduplicateByName(results, ns.modelName, ownRecord),
            );
          }
        }
        return dropMissingPaths(deduplicateByName(results));
      },
      specInstanceNames: (
        rawModelName: string,
        specName: string,
      ): string[] => {
        if (!this.dataQueryService) return [];
        const parsed = parseNamespacedModelName(rawModelName);
        // Same scope as latest(): own namespace by default, the named one
        // for an "ns:" prefix, every namespace for "*:".
        const targetNs = parsed.namespace === undefined
          ? ownNamespace
          : parsed.namespace === "*"
          ? undefined
          : parsed.namespace;
        return this.dataQueryService.latestDataNamesForSpec(
          parsed.modelName,
          specName,
          targetNs,
          CONTROL_PLANE_STORED_TYPES,
        );
      },
      query: async (
        predicate: string,
        select?: string,
        view?: QueryView,
      ): Promise<DataRecord[] | unknown[]> => {
        if (!this.dataQueryService) return [];
        const results = await this.dataQueryService.query(predicate, {
          select,
          excludeModelTypes: CONTROL_PLANE_STORED_TYPES,
          includeContentPath: true,
          view,
        });
        // Projections are opaque values, so a projected path is not
        // existence-checked; record results are.
        return select ? results : dropMissingPaths(results as DataRecord[]);
      },
      invalidateLatest: (_modelName: string, _dataName: string): void => {
        // No-op — latest() always reads from disk; no cache to invalidate.
      },
      prepare: async (expression: string): Promise<void> => {
        for (const name of extractOwnNamespaceDataModelNames(expression)) {
          await resolveIdentities(name);
        }
        if (readSet) await this.ensureReadSet(expression, readSet);
      },
    };
  }

  async resolveModel(modelRef: string): Promise<{
    definition: Definition;
    type: ModelType;
  }> {
    const byName = await this.definitionRepo.findByNameGlobal(modelRef);
    if (byName) {
      return {
        definition: byName.definition,
        type: byName.type,
      };
    }

    // Try by UUID - search across all types. The comparison below is strict
    // equality, so a non-UUID ref can never match; skipping the walk avoids
    // parsing every definition in the repo to prove a miss.
    if (isUuid(modelRef)) {
      const allDefinitions = await this.definitionRepo.findAllGlobal();
      for (const { definition, type } of allDefinitions) {
        if (definition.id === modelRef) {
          return { definition, type };
        }
      }
    }

    throw new ModelNotFoundError(modelRef);
  }

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
    let textContent: unknown = "";

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
            textContent = attributes;
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
      // dataToRecord is the eager-population path: it always loads the
      // latest version of each data item into context.model.*, so the
      // record here is by construction the latest.
      isLatest: true,
      createdAt: data.createdAt.toISOString(),
      namespace: this.dataRepo.namespace,
      attributes,
      tags: { ...data.tags },
      modelName: resolvedModelName,
      modelId: modelId,
      modelType: modelType.normalized,
      specName: data.tags["specName"] ?? "",
      dataType: data.tags["type"] ?? "",
      contentType: data.contentType,
      lifetime: data.lifetime,
      garbageCollection: data.garbageCollection,
      lifecycle: data.lifecycle,
      ownerType: data.ownerDefinition.ownerType,
      streaming: data.streaming,
      size: data.size ?? 0,
      content: textContent,
      path: localContentPath(
        this.dataRepo,
        modelType,
        modelId,
        dataName,
        resolvedVersion,
        this.dataRepo.namespace,
      ),
      ownerRef: data.ownerDefinition.ownerRef,
      workflowRunId: data.ownerDefinition.workflowRunId ?? "",
      workflowName: data.ownerDefinition.workflowName ?? "",
      jobName: data.ownerDefinition.jobName ?? "",
      stepName: data.ownerDefinition.stepName ?? "",
      source: data.ownerDefinition.source ?? "",
    };
  }

  /**
   * reads vault.get() values at delivery through this resolver's vault service,
   * the one its existence checks ask, so a refresh hook refreshes on load
   */
  secretLoader(redactor?: SecretRedactor): SecretLoader {
    return new SecretLoader(() => this.getVaultService(), redactor);
  }

  /**
   * the vault check scope of a typed evaluation: this resolver's vault service,
   * with the run's probe redactor (a probe's value goes to it and is dropped)
   * and the authored location
   */
  async vaultEvaluationScope(
    location: string,
    redactor?: ProbeRedactor,
  ): Promise<
    { service: VaultService; redactor: ProbeRedactor; location: string }
  > {
    return {
      service: await this.getVaultService(),
      redactor: redactor ?? { addSecret() {} },
      location,
    };
  }
}
