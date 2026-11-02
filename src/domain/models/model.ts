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

import { z } from "zod";
import { isZodSchemaLike } from "../zod_compat.ts";
import { boundedRecord } from "../untrusted_parse.ts";
import type { CloudControlClient } from "@aws-sdk/client-cloudcontrol";
import type { Environment } from "cel-js";
import { getLogger, type Logger } from "@logtape/logtape";
import { ModelType } from "./model_type.ts";
import { isControlPlaneModelType } from "./control_plane_types.ts";
import type { VaultService } from "../vaults/vault_service.ts";
import type { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import type { SecretOccurrences } from "../vaults/secret_occurrences.ts";
import type { DataRange } from "../expressions/provenance_map.ts";
import type { SecretRedactor } from "../secrets/mod.ts";
import { assertModelSecretsMetadataValid } from "./secret_destinations.ts";
import type { MethodExecutionEvent } from "./method_events.ts";
import { CalVer } from "./calver.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
import type { DataQueryService } from "../data/data_query_service.ts";
import {
  type DataId,
  type DataMetadata,
  type GarbageCollectionPolicy,
  GarbageCollectionSchema,
  type Lifetime,
  LifetimeSchema,
  type OutputLifetime,
  type OwnerDefinition,
} from "../data/mod.ts";
import type { UnifiedDataRepository } from "../data/repositories.ts";
import type { OutputRepository } from "./repositories.ts";
import type { DataRecord } from "../data/data_record.ts";

export interface ResourceOutputSpec {
  description?: string;

  schema: z.ZodTypeAny;

  lifetime: Lifetime;

  garbageCollection: GarbageCollectionPolicy;

  tags?: Record<string, string>;

  sensitiveOutput?: boolean;

  vaultName?: string;
}

export interface FileOutputSpec {
  description?: string;

  contentType: string;

  lifetime: Lifetime;

  garbageCollection: GarbageCollectionPolicy;

  streaming?: boolean;

  tags?: Record<string, string>;
}

export const ResourceOutputSpecSchema = z.object({
  description: z.string().optional(),
  // Duck-typed so schemas from user-bundled zod instances validate.
  schema: z.custom<z.ZodTypeAny>(isZodSchemaLike),
  lifetime: LifetimeSchema,
  garbageCollection: GarbageCollectionSchema,
  tags: z.record(z.string(), z.string()).optional(),
  sensitiveOutput: z.boolean().optional(),
  vaultName: z.string().optional(),
});

export const FileOutputSpecSchema = z.object({
  description: z.string().optional(),
  contentType: z.string(),
  lifetime: LifetimeSchema,
  garbageCollection: GarbageCollectionSchema,
  streaming: z.boolean().optional(),
  tags: z.record(z.string(), z.string()).optional(),
});

export interface ResourceWriteOverrides {
  lifetime?: Lifetime;
  garbageCollection?: GarbageCollectionPolicy;
  tags?: Record<string, string>;
}

export interface FileWriterOverrides {
  contentType?: string;
  lifetime?: Lifetime;
  garbageCollection?: GarbageCollectionPolicy;
  streaming?: boolean;
  tags?: Record<string, string>;
}

/**
 * unknown keys are stripped, not refused, so a newer worker stays compatible
 * with an older serve
 */
export const ResourceWriteOverridesSchema = z.object({
  lifetime: LifetimeSchema.optional(),
  garbageCollection: GarbageCollectionSchema.optional(),
  tags: boundedRecord(z.string(), z.string()).optional(),
});

export const FileWriterOverridesSchema = z.object({
  contentType: z.string().optional(),
  lifetime: LifetimeSchema.optional(),
  garbageCollection: GarbageCollectionSchema.optional(),
  streaming: z.boolean().optional(),
  tags: boundedRecord(z.string(), z.string()).optional(),
});

// Compile-time guards: each schema must parse to its interface and cover
// every key of it, so a new override field cannot be silently dropped on the
// wire.
type SameKeys<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A] ? true : false
  : false;
const _resourceOverridesMatch:
  & SameKeys<
    ResourceWriteOverrides,
    z.infer<typeof ResourceWriteOverridesSchema>
  >
  & (z.infer<typeof ResourceWriteOverridesSchema> extends ResourceWriteOverrides
    ? true
    : false) = true;
const _fileOverridesMatch:
  & SameKeys<FileWriterOverrides, z.infer<typeof FileWriterOverridesSchema>>
  & (z.infer<typeof FileWriterOverridesSchema> extends FileWriterOverrides
    ? true
    : false) = true;

export interface MethodContext {
  /**
   * always present; simply never aborted if the caller does not need
   * cancellation
   */
  signal: AbortSignal;

  repoDir: string;

  modelType: ModelType;

  modelId: string;

  globalArgs: Record<string, unknown>;

  definition: {
    id: string;
    name: string;
    version: number;
    tags: Record<string, string>;
  };

  methodName: string;

  /**
   * W3C trace headers for this execution; pass them to spawned subprocesses or
   * outbound requests. Always this execution's own context, even with
   * concurrent methods. Empty when tracing is off.
   */
  traceHeaders?: Readonly<Record<string, string>>;

  cloudControlClientFactory?: () => CloudControlClient;

  dataRepository: UnifiedDataRepository;

  definitionRepository: DefinitionRepository;

  outputRepository?: OutputRepository;

  vaultService?: VaultService;

  logger: Logger;

  writeResource?: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
    overrides?: ResourceWriteOverrides,
  ) => Promise<DataHandle>;

  readResource?: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;

  deleteResource?: (instanceName: string) => Promise<void>;

  readModelData?: (
    modelName: string,
    specName?: string,
  ) => Promise<DataRecord[]>;

  queryData?: (
    predicate: string,
    select?: string,
  ) => Promise<DataRecord[] | unknown[]>;

  createFileWriter?: (
    specName: string,
    name: string,
    overrides?: FileWriterOverrides,
  ) => DataWriter;

  redactor?: SecretRedactor;

  dataQueryService?: DataQueryService;

  /**
   * when present, the method body dispatches to a matching worker; checks,
   * reports and output records still run at the orchestrator
   */
  placement?: {
    target?: string;
    labels?: Record<string, string>;
    platform?: string;
    queueTimeoutMs?: number;
    affinityKey?: string;
  };

  /**
   * the step declared external writes the data-plane write path does not track;
   * forces fail-instead-of-redispatch on worker disconnect
   */
  declaredWrites?: boolean;

  onEvent?: (event: MethodExecutionEvent) => void;

  tagOverrides?: Record<string, string>;

  /** applied after specName and tagOverrides, before data output overrides */
  runtimeTags?: Record<string, string>;

  dataOutputOverrides?: Array<{
    specName: string;
    lifetime?: Lifetime;
    garbageCollection?: GarbageCollectionPolicy;
    tags?: Record<string, string>;
    resolvedVarySuffix?: string;
    vaultName?: string;
  }>;

  skipCheckNames?: string[];
  skipCheckLabels?: string[];
  skipAllChecks?: boolean;

  skipReportNames?: string[];
  skipReportLabels?: string[];
  skipAllReports?: boolean;
  reportNames?: string[];
  reportLabels?: string[];

  vaultSecrets?: VaultSecretBag;

  unresolvedMethodArgs?: Record<string, unknown>;

  /**
   * resolves an asset declared in the extension's additionalFiles to an
   * absolute path; throws if not shipped as an extension, if relPath is unsafe,
   * or if the file is missing
   */
  extensionFile: (relPath: string) => string;

  /**
   * fresh, isolated cel-js Environment with baseline arithmetic overloads; it
   * lacks swamp's internal namespace types, and registrations on one instance
   * do not affect another
   */
  createCelEnvironment: () => Environment;

  /**
   * calls another model's method inline; the caller's extension must declare
   * the target in manifest dependencies (built-ins, user models and
   * same-extension calls are exempt). Not available remotely.
   */
  runModel?: (options: RunModelOptions) => Promise<RunModelResult>;

  /**
   * approves a suspended manual_approval gate; the workflow stays suspended
   * until resumed. decidedBy is set from the calling model and method and
   * cannot be overridden. Not available remotely.
   */
  approveWorkflowGate?: (
    options: WorkflowGateApproveOptions,
  ) => Promise<WorkflowGateResult>;

  /**
   * rejects a suspended manual_approval gate, failing the step, job and run.
   * decidedBy is set from the calling model and method and cannot be
   * overridden. Not available remotely.
   */
  rejectWorkflowGate?: (
    options: WorkflowGateRejectOptions,
  ) => Promise<WorkflowGateResult>;

  _invocationTracking?: InvocationTracking;

  _currentOutputId?: string;

  _invocationProvenance?: {
    triggeredBy: "model";
    parentOutputId?: string;
    callerExtension?: string;
  };
}

export type RunModelOptions =
  | RunModelByDefinition
  | RunModelByType;

export interface RunModelByDefinition {
  definition: string;
  method: string;
  arguments?: Record<string, unknown>;
}

export interface RunModelByType {
  modelType: string;
  name: string;
  method: string;
  arguments?: Record<string, unknown>;
}

export type RunModelResult =
  | RunModelSuccess
  | RunModelFailure;

export interface RunModelSuccess {
  ok: true;
  resources: DataHandle[];
}

export interface RunModelFailure {
  ok: false;
  error: { message: string; stack?: string };
}

export interface WorkflowGateApproveOptions {
  workflowIdOrName: string;
  stepName: string;
  runId?: string;
  reason?: string;
}

export interface WorkflowGateRejectOptions {
  workflowIdOrName: string;
  stepName: string;
  runId?: string;
  reason?: string;
}

export type WorkflowGateResult =
  | WorkflowGateSuccess
  | WorkflowGateFailure;

export interface WorkflowGateSuccess {
  ok: true;
  runId: string;
  workflowName: string;
  stepName: string;
  approved: boolean;
  decidedBy: string;
  /**
   * on a reject that ended the run: nested workflow runs its steps waited on
   * are left suspended; cancelling them is a separate step
   */
  detachedNestedRuns?: {
    workflowName: string;
    runId: string;
    cancelCommand: string;
  }[];
}

export interface WorkflowGateFailure {
  ok: false;
  error: { message: string };
}

export interface InvocationTracking {
  depth: number;
  ancestors: ReadonlySet<string>;
  breadthCounter: { count: number };
}

export interface DataHandle {
  name: string;
  specName: string;
  kind: "resource" | "file";
  dataId: DataId;
  version: number;
  size: number;
  /** the SHA-256 of the content, when the save reported one */
  sha256?: string;
  tags: Record<string, string>;
  metadata: Omit<
    DataMetadata,
    "id" | "name" | "version" | "createdAt" | "size" | "checksum"
  >;
  attributes?: Record<string, unknown>;
}

export interface ResolvedDataWriterOptions {
  name: string;
  specName: string;
  kind: "resource" | "file";
  contentType: string;
  lifetime: Lifetime;
  garbageCollection: GarbageCollectionPolicy;
  streaming?: boolean;
  tags: Record<string, string>;
  ownerDefinition?: OwnerDefinition;
}

export interface DataWriter {
  readonly dataId: DataId;
  readonly name: string;

  writeAll(content: Uint8Array): Promise<DataHandle>;
  writeText(text: string): Promise<DataHandle>;
  writeLine(line: string): Promise<void>;
  writeStream(
    stream: ReadableStream<Uint8Array>,
    options?: { onLine?: (line: string) => void },
  ): Promise<DataHandle>;
  getFilePath(): Promise<string>;
  finalize(): Promise<DataHandle>;
}

export interface DataWriterCallbacks {
  onLine?: (dataName: string, line: string) => void;
  onEvent?: (event: MethodExecutionEvent) => void;
}

export interface MethodResult {
  dataHandles?: DataHandle[];

  /**
   * "loopback" for in-process, or the worker name for a remote dispatch; set by
   * the execution service for telemetry, never by methods
   */
  executor?: string;
}

export type MethodKind =
  | "create"
  | "read"
  | "update"
  | "delete"
  | "list"
  | "action";

export function inferMethodKind(
  methodName: string,
  definition?: { kind?: MethodKind },
): MethodKind | undefined {
  if (definition?.kind) {
    return definition.kind;
  }

  const lower = methodName.toLowerCase();

  if (lower === "create") return "create";
  if (
    lower === "get" || lower === "read" || lower === "describe" ||
    lower === "show"
  ) {
    return "read";
  }
  if (lower === "update" || lower === "patch") return "update";
  if (lower === "delete" || lower === "destroy" || lower === "remove") {
    return "delete";
  }
  if (lower === "list" || lower === "search" || lower === "find") return "list";

  return undefined;
}

export type MethodKindSource = "declared" | "inferred" | "none";

export interface ResolvedMethodKind {
  kind?: MethodKind;
  source: MethodKindSource;
}

export function resolveMethodKind(
  methodName: string,
  definition?: { kind?: MethodKind },
): ResolvedMethodKind {
  const kind = inferMethodKind(methodName, definition);
  if (kind === undefined) return { source: "none" };
  return { kind, source: definition?.kind ? "declared" : "inferred" };
}

export interface CheckResult {
  pass: boolean;
  errors?: string[];
}

export interface CheckDefinition {
  description: string;
  labels?: string[];
  appliesTo?: string[];
  execute(context: MethodContext): Promise<CheckResult>;
}

export function isMutatingKind(kind: MethodKind | undefined): boolean {
  return kind !== "read" && kind !== "list";
}

export interface MethodDefinition<
  TArgs extends z.ZodTypeAny = z.ZodTypeAny,
> {
  description: string;

  kind?: MethodKind;

  /**
   * writes use deferred-latest: data persists but the latest marker advances
   * only on success; on failure all written version directories are deleted
   */
  rollbackOnFailure?: boolean;

  /**
   * retention ceiling for this method's output records ("1d", "7d" or
   * "infinite"); gc deletes older outputs regardless of the global retention
   * flag
   */
  outputLifetime?: OutputLifetime;

  arguments: TArgs;

  execute(
    args: z.infer<TArgs>,
    context: MethodContext,
  ): Promise<MethodResult>;

  /**
   * refuses a secret at a destination the argument schema cannot describe,
   * before any secret is loaded; called for locally placed steps of a typed
   * run. Throws SecretDestinationRefusedError to refuse.
   */
  refuseSecretDestinations?(args: SecretDestinationArgs): void;

  /**
   * rewrites arguments holding data-origin text where the method would parse it
   * as syntax, once per dispatch attempt, for the platform that runs the body.
   * Returns changed args by name; throws UserError to refuse.
   */
  placeDataSplices?(args: DataSpliceArgs): Record<string, unknown>;
}

export interface DataSpliceArgs {
  /**
   * the arguments as unresolvedMethodArgs carries them, sentinels in place of
   * secrets; read before coercion and validation, so any shape is possible
   */
  readonly arguments: Record<string, unknown>;
  dataRangesOf(key: string): readonly DataRange[];
  readonly platform: string;
}

export interface SecretDestinationArgs {
  /**
   * raw per-method arguments over raw global arguments that hold no unresolved
   * expression; read before coercion and validation, so any shape is possible
   */
  readonly arguments: Record<string, unknown>;
  readonly secrets: SecretOccurrences;
}

export interface VersionUpgrade {
  toVersion: string;
  description: string;
  upgradeAttributes: (
    oldAttributes: Record<string, unknown>,
  ) => Record<string, unknown>;
}

export interface ModelDefinition<
  TGlobalArgs extends z.ZodTypeAny = z.ZodTypeAny,
> {
  type: ModelType;

  version: string;

  globalArguments?: TGlobalArgs;

  resources?: Record<string, ResourceOutputSpec>;

  files?: Record<string, FileOutputSpec>;

  methods: Record<string, MethodDefinition>;

  checks?: Record<string, CheckDefinition>;

  reports?: string[];

  /**
   * ordered chronologically by toVersion; the last entry's toVersion must equal
   * version
   */
  upgrades?: VersionUpgrade[];

  /**
   * lazily builds the bundle for out-of-process execution when a step
   * dispatches to a remote worker; memoized so one process bundles a model once
   */
  bundleSourceFactory?: () => Promise<string>;

  /**
   * root that additionalFiles entries resolve from at runtime; undefined for
   * built-in types and source-loaded directories without a manifest.yaml
   */
  extensionFilesRoot?: string;

  /**
   * reads the manifest's declared additionalFiles as they are now; only these
   * ship to remote workers. Undefined for built-in types and directories
   * without a manifest.yaml.
   */
  readExtensionAdditionalFiles?: () => Promise<string[]>;

  /**
   * scoped name of the providing extension, set by the loader at registration;
   * undefined for built-in and user-authored models. Used for runtime
   * dependency authorization.
   */
  extensionName?: string;

  /**
   * SHA-256 of the bundled extension source, set at registration and recorded
   * in ExecutionProvenance to verify which code produced an output
   */
  sourceFingerprint?: string;
}

export interface ExtensionMemberSet {
  methods?: Record<string, MethodDefinition>;
  checks?: Record<string, CheckDefinition>;
  resources?: Record<string, ResourceOutputSpec>;
}

export interface LazyModelEntry {
  type: ModelType;
  bundlePath: string;
  sourcePath: string;
  version: string;
  sourceFingerprint?: string;
  extensionName?: string;
}

const registryLogger = getLogger(["swamp", "models", "registry"]);

function normalizedExtensionName(name: string): string | undefined {
  try {
    const normalized = ModelType.create(name).normalized;
    return normalized.startsWith("@") ? normalized : `@${normalized}`;
  } catch {
    return undefined;
  }
}

export interface SourceRefreshOptions {
  /** runs a full pass even when no source file changed since the last one */
  force?: boolean;
}

export class ModelRegistry {
  private models = new Map<string, ModelDefinition>();
  private lazyTypes = new Map<string, LazyModelEntry>();
  /**
   * Normalized name of the extension that provides each type, from the
   * bundle catalog's lazy entries. Kept when a lazy type is imported, as
   * the loaded definition's own `extensionName` is derived from its path.
   */
  private providingExtensions = new Map<string, string>();
  private internalTypes = new Set<string>();
  private builtInTypes = new Set<string>();
  private extensionLoader: (() => Promise<void>) | null = null;
  private extensionLoadPromise: Promise<void> | null = null;
  private extensionsLoaded = false;
  private typeLoadPromises = new Map<string, Promise<void>>();
  private typeLoader:
    | ((type: string, lazyEntry?: LazyModelEntry) => Promise<void>)
    | null = null;
  private extensionAttacher: ((type: string) => Promise<void>) | null = null;
  private extensionsAttached = new Set<string>();
  private extensionAttachWarned = new Set<string>();
  private sourceRefresher:
    | ((options?: SourceRefreshOptions) => Promise<void>)
    | null = null;
  private sourceRefreshRunning: Promise<void> | null = null;
  private sourceRefreshQueued: Promise<void> | null = null;
  private sourceRefreshForceQueued = false;

  setSourceRefresher(
    refresher: ((options?: SourceRefreshOptions) => Promise<void>) | null,
  ): void {
    this.sourceRefresher = refresher;
  }

  /**
   * swaps changed types for long-lived processes. Passes never overlap: calls
   * during one pass share the next one, which is forced if any caller forced.
   */
  refreshSources(
    schedule: (pass: () => Promise<void>) => Promise<void> = (pass) => pass(),
    options?: SourceRefreshOptions,
  ): Promise<void> {
    const refresher = this.sourceRefresher;
    if (!refresher) return Promise.resolve();
    if (this.sourceRefreshQueued) {
      if (options?.force) this.sourceRefreshForceQueued = true;
      return this.sourceRefreshQueued;
    }
    const run = (force: boolean): Promise<void> => {
      const pass = schedule(() => refresher(force ? { force } : undefined))
        .finally(() => {
          if (this.sourceRefreshRunning === pass) {
            this.sourceRefreshRunning = null;
          }
        });
      this.sourceRefreshRunning = pass;
      return pass;
    };
    const running = this.sourceRefreshRunning;
    if (!running) return run(options?.force === true);
    this.sourceRefreshForceQueued = options?.force === true;
    // Consumed in this synchronous handoff, before schedule may wait, so a
    // caller queueing for the pass after this one keeps its own force.
    const next = () => {
      this.sourceRefreshQueued = null;
      const force = this.sourceRefreshForceQueued;
      this.sourceRefreshForceQueued = false;
      return run(force);
    };
    const queued = running.then(next, next);
    this.sourceRefreshQueued = queued;
    return queued;
  }

  setLoader(loader: () => Promise<void>): void {
    this.extensionLoader = loader;
  }

  setTypeLoader(
    loader: (type: string, lazyEntry?: LazyModelEntry) => Promise<void>,
  ): void {
    this.typeLoader = loader;
  }

  /**
   * attaches extensions to eagerly registered types (lazy types get theirs from
   * the type loader), once per type. A new attacher reads a new catalog, so
   * every type is checked again.
   */
  setExtensionAttacher(
    attacher: ((type: string) => Promise<void>) | null,
  ): void {
    this.extensionAttacher = attacher;
    this.extensionsAttached.clear();
    this.extensionAttachWarned.clear();
  }

  registerLazy(entry: LazyModelEntry): void {
    const key = entry.type.normalized;
    if (this.models.has(key) || this.lazyTypes.has(key)) return;
    this.lazyTypes.set(key, entry);
    const provider = entry.extensionName === undefined
      ? undefined
      : normalizedExtensionName(entry.extensionName);
    if (provider !== undefined) this.providingExtensions.set(key, provider);
  }

  isLazy(type: string | ModelType): boolean {
    const modelType = typeof type === "string" ? ModelType.create(type) : type;
    return this.lazyTypes.has(modelType.normalized);
  }

  /**
   * loads the type's own bundle when the index knows it, else every extension
   * (memoized). Undefined when no extension registers the type; never fetches
   * one.
   */
  async getOrLoad(
    type: string | ModelType,
  ): Promise<ModelDefinition | undefined> {
    await this.ensureTypeLoaded(type);
    const found = this.get(type);
    if (found) return found;
    await this.ensureLoaded();
    await this.ensureTypeLoaded(type);
    return this.get(type);
  }

  async ensureLoaded(): Promise<void> {
    if (this.extensionsLoaded) return;
    if (!this.extensionLoader) return;
    if (!this.extensionLoadPromise) {
      const loader = this.extensionLoader;
      this.extensionLoadPromise = loader().then(() => {
        this.extensionsLoaded = true;
      });
    }
    await this.extensionLoadPromise;
  }

  resetLoadedFlag(): void {
    this.extensionsLoaded = false;
    this.extensionLoadPromise = null;
  }

  clearLoadersForTesting(): void {
    this.extensionLoader = null;
    this.typeLoader = null;
    this.sourceRefresher = null;
    this.extensionsLoaded = false;
    this.extensionLoadPromise = null;
  }

  invalidateType(type: string | ModelType): void {
    const modelType = typeof type === "string" ? ModelType.create(type) : type;
    const key = modelType.normalized;
    this.models.delete(key);
    this.lazyTypes.delete(key);
    this.providingExtensions.delete(key);
    this.typeLoadPromises.delete(key);
    this.extensionsAttached.delete(key);
    this.extensionAttachWarned.delete(key);
  }

  async ensureTypeLoaded(type: string | ModelType): Promise<void> {
    const modelType = typeof type === "string" ? ModelType.create(type) : type;
    const key = modelType.normalized;

    // a loaded type with a pending load may lack its extensions (the base type
    // registers before they attach), so await the pending promise rather than
    // return a base-only definition
    if (this.models.has(key)) {
      const pending = this.typeLoadPromises.get(key);
      if (pending) {
        await pending;
        return;
      }
      await this.attachExtensionsOnce(key);
      return;
    }

    if (!this.lazyTypes.has(key)) return;

    if (!this.typeLoader) {
      await this.ensureLoaded();
      return;
    }

    // Deduplicate concurrent loads for the same type.
    // On rejection, remove the cached promise so subsequent calls retry
    // rather than permanently failing (e.g. transient I/O error).
    let promise = this.typeLoadPromises.get(key);
    if (!promise) {
      const loader = this.typeLoader;
      const lazyEntry = this.lazyTypes.get(key);
      promise = loader(key, lazyEntry ?? undefined).then(() => {
        // promoteFromLazy() deletes the lazy entry on success.
        // If the loader skipped a broken bundle (no primary export),
        // the type was never promoted — discard the lazy entry so
        // subsequent calls treat it as unknown instead of retrying.
        if (!this.models.has(key)) {
          this.lazyTypes.delete(key);
        } else {
          this.extensionsAttached.add(key);
        }
        this.typeLoadPromises.delete(key);
      }).catch((err) => {
        this.typeLoadPromises.delete(key);
        throw err;
      });
      this.typeLoadPromises.set(key, promise);
    }
    await promise;
  }

  /**
   * built-in types skip the type loader, so attach their extensions on first
   * use. A failed attach never fails the base type; it is logged and retried on
   * the next call. Control-plane types are never extended.
   */
  private async attachExtensionsOnce(key: string): Promise<void> {
    const attacher = this.extensionAttacher;
    if (!attacher || this.extensionsAttached.has(key)) return;
    if (isControlPlaneModelType(key)) return;

    // Wrapped so an attacher that throws synchronously is handled the same.
    const promise = new Promise<void>((resolve) => resolve(attacher(key))).then(
      () => {
        this.extensionsAttached.add(key);
      },
      (error: unknown) => {
        if (this.extensionAttachWarned.has(key)) {
          registryLogger
            .debug`Attaching extensions to ${key} failed again: ${error}`;
          return;
        }
        this.extensionAttachWarned.add(key);
        registryLogger
          .warn`Could not attach extensions to ${key}; using it without them: ${error}`;
      },
    ).finally(() => {
      if (this.typeLoadPromises.get(key) === promise) {
        this.typeLoadPromises.delete(key);
      }
    });
    this.typeLoadPromises.set(key, promise);
    await promise;
  }

  promoteFromLazy(model: ModelDefinition): void {
    const key = model.type.normalized;
    this.lazyTypes.delete(key);
    if (!this.models.has(key)) {
      this.register(model);
    }
  }

  register(model: ModelDefinition): void {
    const key = model.type.normalized;
    if (this.models.has(key)) {
      throw new Error(`Behavior type already registered: ${key}`);
    }

    if (!CalVer.isValid(model.version)) {
      throw new Error(
        `Invalid CalVer version "${model.version}" for behavior type "${key}". ` +
          `Expected format YYYY.MM.DD.MICRO (e.g., "2025.01.15.1")`,
      );
    }

    if (model.upgrades && model.upgrades.length > 0) {
      for (let i = 0; i < model.upgrades.length; i++) {
        const upgrade = model.upgrades[i];

        if (!CalVer.isValid(upgrade.toVersion)) {
          throw new Error(
            `Invalid CalVer version "${upgrade.toVersion}" in upgrade at index ${i} ` +
              `for behavior type "${key}"`,
          );
        }

        if (i > 0) {
          const prev = CalVer.create(model.upgrades[i - 1].toVersion);
          const curr = CalVer.create(upgrade.toVersion);
          if (CalVer.compare(prev, curr) >= 0) {
            throw new Error(
              `Upgrades for behavior type "${key}" are not in chronological order: ` +
                `"${prev.value}" must be before "${curr.value}"`,
            );
          }
        }
      }

      const lastUpgrade = model.upgrades[model.upgrades.length - 1];
      if (lastUpgrade.toVersion !== model.version) {
        throw new Error(
          `Last upgrade toVersion "${lastUpgrade.toVersion}" does not match behavior ` +
            `version "${model.version}" for behavior type "${key}"`,
        );
      }
    }

    // a field marked both sensitive and secrets: "refuse" is a schema error
    assertModelSecretsMetadataValid(model);

    this.models.set(key, model);
  }

  extend(
    type: string | ModelType,
    methods: Record<string, MethodDefinition>,
    checks?: Record<string, CheckDefinition>,
    resources?: Record<string, ResourceOutputSpec>,
    reports?: string[],
  ): void {
    const modelType = typeof type === "string" ? ModelType.create(type) : type;
    const key = modelType.normalized;
    const existing = this.models.get(key);

    if (!existing) {
      throw new Error(`Cannot extend unregistered behavior type: ${key}`);
    }
    if (isControlPlaneModelType(key)) {
      throw new Error(`Cannot extend control-plane behavior type: ${key}`);
    }

    for (const methodName of Object.keys(methods)) {
      if (existing.methods[methodName]) {
        throw new Error(
          `Method '${methodName}' already exists on behavior type '${key}'`,
        );
      }
    }

    if (checks) {
      for (const checkName of Object.keys(checks)) {
        if (existing.checks?.[checkName]) {
          throw new Error(
            `Check '${checkName}' already exists on behavior type '${key}'`,
          );
        }
      }
    }

    if (resources) {
      for (const specName of Object.keys(resources)) {
        if (existing.resources?.[specName]) {
          throw new Error(
            `Resource spec '${specName}' already exists on behavior type '${key}'`,
          );
        }
      }
    }

    assertModelSecretsMetadataValid({ type: modelType, methods });

    const merged: ModelDefinition = {
      ...existing,
      methods: { ...existing.methods, ...methods },
      ...(checks || existing.checks
        ? { checks: { ...(existing.checks ?? {}), ...(checks ?? {}) } }
        : {}),
      ...(resources || existing.resources
        ? {
          resources: {
            ...(existing.resources ?? {}),
            ...(resources ?? {}),
          },
        }
        : {}),
      ...(reports || existing.reports
        ? {
          reports: [
            ...(existing.reports ?? []),
            ...(reports ?? []),
          ],
        }
        : {}),
    };

    this.models.set(key, merged);
  }

  /**
   * applies extension members in one immutable merge: additions are new,
   * overrides replace existing members. All validated first, so a rejected call
   * leaves the type untouched; extend() still refuses replacement.
   */
  applyExtensionMembers(
    type: string | ModelType,
    additions: ExtensionMemberSet,
    overrides: ExtensionMemberSet,
  ): void {
    const modelType = typeof type === "string" ? ModelType.create(type) : type;
    const key = modelType.normalized;
    const existing = this.models.get(key);

    if (!existing) {
      throw new Error(`Cannot extend unregistered behavior type: ${key}`);
    }
    if (isControlPlaneModelType(key)) {
      throw new Error(`Cannot extend control-plane behavior type: ${key}`);
    }

    const current: Record<keyof ExtensionMemberSet, Record<string, unknown>> = {
      methods: existing.methods,
      checks: existing.checks ?? {},
      resources: existing.resources ?? {},
    };
    const labels: Record<keyof ExtensionMemberSet, string> = {
      methods: "Method",
      checks: "Check",
      resources: "Resource spec",
    };
    for (const kind of ["methods", "checks", "resources"] as const) {
      for (const name of Object.keys(additions[kind] ?? {})) {
        if (Object.hasOwn(current[kind], name)) {
          throw new Error(
            `${
              labels[kind]
            } '${name}' already exists on behavior type '${key}'`,
          );
        }
      }
      for (const name of Object.keys(overrides[kind] ?? {})) {
        if (!Object.hasOwn(current[kind], name)) {
          throw new Error(
            `${
              labels[kind]
            } '${name}' does not exist on behavior type '${key}'; nothing to override`,
          );
        }
      }
    }

    assertModelSecretsMetadataValid({
      type: modelType,
      methods: { ...(additions.methods ?? {}), ...(overrides.methods ?? {}) },
    });

    const hasChecks = existing.checks || additions.checks || overrides.checks;
    const hasResources = existing.resources || additions.resources ||
      overrides.resources;
    const merged: ModelDefinition = {
      ...existing,
      methods: {
        ...existing.methods,
        ...(additions.methods ?? {}),
        ...(overrides.methods ?? {}),
      },
      ...(hasChecks
        ? {
          checks: {
            ...(existing.checks ?? {}),
            ...(additions.checks ?? {}),
            ...(overrides.checks ?? {}),
          },
        }
        : {}),
      ...(hasResources
        ? {
          resources: {
            ...(existing.resources ?? {}),
            ...(additions.resources ?? {}),
            ...(overrides.resources ?? {}),
          },
        }
        : {}),
    };

    this.models.set(key, merged);
  }

  /**
   * reverse of applyExtensionMembers: a member is removed only while the type
   * still holds the exact definition passed, so a base member or a later
   * override of the same name stays
   */
  removeExtensionMembers(
    type: string | ModelType,
    members: ExtensionMemberSet,
  ): ExtensionMemberSet {
    const modelType = typeof type === "string" ? ModelType.create(type) : type;
    const key = modelType.normalized;
    const existing = this.models.get(key);
    const removed: ExtensionMemberSet = {};
    if (!existing) return removed;

    const current: Record<keyof ExtensionMemberSet, Record<string, unknown>> = {
      methods: { ...existing.methods },
      checks: { ...(existing.checks ?? {}) },
      resources: { ...(existing.resources ?? {}) },
    };
    let changed = false;
    for (const kind of ["methods", "checks", "resources"] as const) {
      for (const [name, definition] of Object.entries(members[kind] ?? {})) {
        if (
          !Object.hasOwn(current[kind], name) ||
          current[kind][name] !== definition
        ) continue;
        delete current[kind][name];
        const bucket = (removed[kind] ??= {}) as Record<string, unknown>;
        bucket[name] = definition;
        changed = true;
      }
    }
    if (!changed) return removed;

    this.models.set(key, {
      ...existing,
      methods: current.methods as Record<string, MethodDefinition>,
      ...(existing.checks
        ? { checks: current.checks as Record<string, CheckDefinition> }
        : {}),
      ...(existing.resources
        ? {
          resources: current.resources as Record<string, ResourceOutputSpec>,
        }
        : {}),
    });
    return removed;
  }

  get(type: string | ModelType): ModelDefinition | undefined {
    const modelType = typeof type === "string" ? ModelType.create(type) : type;
    return this.models.get(modelType.normalized);
  }

  has(type: string | ModelType): boolean {
    const modelType = typeof type === "string" ? ModelType.create(type) : type;
    const key = modelType.normalized;
    return this.models.has(key) || this.lazyTypes.has(key);
  }

  types(): ModelType[] {
    const loaded = Array.from(this.models.values()).map((m) => m.type);
    const lazy = Array.from(this.lazyTypes.values())
      .filter((entry) => !this.models.has(entry.type.normalized))
      .map((entry) => entry.type);
    return [...loaded, ...lazy];
  }

  publicTypes(): ModelType[] {
    return this.types().filter((t) => !this.internalTypes.has(t.normalized));
  }

  typesProvidedByExtension(extensionName: string): ModelType[] {
    const wanted = normalizedExtensionName(extensionName);
    if (wanted === undefined) return [];
    return this.types()
      .filter((t) =>
        !this.internalTypes.has(t.normalized) &&
        this.providingExtensions.get(t.normalized) === wanted
      )
      .sort((a, b) => a.normalized.localeCompare(b.normalized));
  }

  markInternal(type: ModelType | string): void {
    const normalized = typeof type === "string"
      ? ModelType.create(type).normalized
      : type.normalized;
    this.internalTypes.add(normalized);
  }

  /**
   * marks a type as built in, so no pulled extension may replace or remove it;
   * defineModel calls it, and invalidateType does not clear the mark
   */
  markBuiltIn(type: ModelType | string): void {
    const normalized = typeof type === "string"
      ? ModelType.create(type).normalized
      : type.normalized;
    this.builtInTypes.add(normalized);
  }

  isBuiltIn(type: ModelType | string): boolean {
    const normalized = typeof type === "string"
      ? ModelType.create(type).normalized
      : type.normalized;
    return this.builtInTypes.has(normalized);
  }

  isInternal(type: ModelType | string): boolean {
    const normalized = typeof type === "string"
      ? ModelType.create(type).normalized
      : type.normalized;
    return this.internalTypes.has(normalized);
  }
}

/**
 * held on globalThis so a bundle with its own copy of this module shares the
 * registry with extension models loaded outside it
 */
const MODEL_REGISTRY_KEY = "__swampModelRegistry";
// deno-lint-ignore no-explicit-any
export const modelRegistry: ModelRegistry = (globalThis as any)[
  MODEL_REGISTRY_KEY
] ??= new ModelRegistry();

export function defineModel<
  TGlobalArgs extends z.ZodTypeAny,
>(
  definition: ModelDefinition<TGlobalArgs>,
): ModelDefinition<TGlobalArgs> {
  if (!modelRegistry.has(definition.type)) {
    modelRegistry.register(definition);
    modelRegistry.markBuiltIn(definition.type);
  }
  return definition;
}
