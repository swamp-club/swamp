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

import { ModelType } from "../domain/models/model_type.ts";
import {
  dispatchTraceCarrier,
  dispatchTraceCoverage,
  observeExecutionWork,
} from "../domain/remote/observability.ts";
import type { Data } from "../domain/data/data.ts";
import type {
  QueryCursorPosition,
  QuerySort,
} from "../domain/data/query_sort.ts";
import type { UnifiedDataRepository } from "../domain/data/repositories.ts";
import { createDataId } from "../domain/data/data_id.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import { runInRootUnitOfWork } from "../infrastructure/persistence/repo_unit_of_work.ts";
import { VaultService } from "../domain/vaults/vault_service.ts";
import { SecretRedactor } from "../domain/secrets/secret_redactor.ts";
import {
  type DefinitionLookupResult,
  findDefinitionByIdOrName,
  findDefinitionsByIdGlobal,
} from "../domain/models/model_lookup.ts";
import {
  type RunVaultAccess,
  runWithVaultAccess,
} from "../domain/vaults/run_vault_access.ts";
import { createModelOutputId } from "../domain/models/model_output.ts";
import { createDefinitionId } from "../domain/definitions/definition.ts";
import {
  type DeleteDataParams,
  DeleteDataParamsSchema,
  DISPATCH_SECRETS_PATH,
  type GetDataParams,
  GetDataParamsSchema,
  type GetDataResult,
  type ListVersionsParams,
  ListVersionsParamsSchema,
  type PutSecretParams,
  PutSecretParamsSchema,
  type QueryDataParams,
  QueryDataParamsSchema,
  type ReadDefinitionParams,
  ReadDefinitionParamsSchema,
  type ReadOutputParams,
  ReadOutputParamsSchema,
  RemoteMethod,
  type ResolveModelParams,
  ResolveModelParamsSchema,
  type ResolveSecretParams,
  ResolveSecretParamsSchema,
  shipsReferencesOnly,
} from "../domain/remote/protocol.ts";
import type {
  RpcChannel,
  RpcHandlerContext,
} from "../domain/remote/rpc_channel.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import { jsonSafeClone } from "./serializer.ts";
import type { ActiveDispatch, DispatchRegistry } from "./dispatch_registry.ts";
import {
  isHiddenFromWorker,
  workerHiddenStoredTypes,
} from "./worker_control_plane_visibility.ts";
import { parseUntrustedOrThrow } from "../domain/untrusted_parse.ts";
import {
  assertSecretKeyNotDenied,
  assertVaultNotDenied,
  ResourceClaimVerifier,
} from "./dispatch_secret_authorization.ts";

const capLogger = getSwampLogger(["serve", "capability"]);

function inVaultScope<T>(
  scope: RunVaultAccess | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return scope ? runWithVaultAccess(scope, fn) : fn();
}

const SLOW_HANDLER_WARN_MS = 5_000;

const MAX_CAPABILITY_PREDICATE_LENGTH = 4096;

/** records or outputs serve holds per worker list read at a time */
export const WORKER_READ_PAGE_SIZE = 1000;

// createdAt has an index and identity breaks ties, so pages form a total order
const WORKER_READ_SORT: QuerySort = { field: "createdAt", direction: "asc" };

const RPC_PATH_PATTERN =
  /(?:^|[\s"'`(])\/(?:opt|home|var|tmp|etc|usr|root|Users|private)\//;
const RPC_SWAMP_PATH_PATTERN = /\/.swamp\//;

export function sanitizeRpcError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (RPC_PATH_PATTERN.test(raw) || RPC_SWAMP_PATH_PATTERN.test(raw)) {
    return "Capability verb failed — internal error";
  }
  if (raw.length > 200) {
    return raw.slice(0, 200) + "...";
  }
  return raw;
}

export function dataContentPath(
  modelType: string,
  modelId: string,
  dataName: string,
  version: number,
): string {
  const type = encodeURIComponent(ModelType.create(modelType).normalized);
  return `/data/${type}/${encodeURIComponent(modelId)}/${
    encodeURIComponent(dataName)
  }/${version}`;
}

export interface CapabilityServiceOptions {
  repoDir: string;
  repoContext: RepositoryContext;
  dispatches?: DispatchRegistry;
  createVaultService?: () => Promise<VaultService>;
  readPageSize?: number;
}

/**
 * one instance serves every enrolled worker; beyond enrollment, authorization
 * is the data writer's declared-spec enforcement on the write path
 */
export class CapabilityService {
  readonly #repoDir: string;
  readonly #repoContext: RepositoryContext;
  readonly #dispatches: DispatchRegistry | undefined;
  readonly #createVaultService: () => Promise<VaultService>;
  #vaultService: Promise<VaultService> | null = null;
  readonly #claims: ResourceClaimVerifier;
  readonly #readPageSize: number;

  constructor(options: CapabilityServiceOptions) {
    this.#repoDir = options.repoDir;
    this.#readPageSize = options.readPageSize ?? WORKER_READ_PAGE_SIZE;
    this.#repoContext = options.repoContext;
    this.#dispatches = options.dispatches;
    this.#createVaultService = options.createVaultService ??
      (() => VaultService.fromRepository(this.#repoDir));
    this.#claims = new ResourceClaimVerifier({
      verb: "resolveSecret",
      repoFor: (dispatch) =>
        this.#repoForWorker(dispatch.workerName, dispatch.dispatchId),
    });
  }

  #vault(): Promise<VaultService> {
    this.#vaultService ??= this.#createVaultService().catch((error) => {
      this.#vaultService = null;
      throw error;
    });
    return this.#vaultService;
  }

  #assertDispatchScope(
    workerName: string,
    dispatchId: string | undefined,
    paramModelType: string,
    verb: string,
  ): void {
    if (!this.#dispatches) return;
    const dispatch = this.#resolveDispatch(workerName, dispatchId, verb);
    if (!dispatch) {
      throw new Error(
        `${verb}: worker '${workerName}' has no active dispatch`,
      );
    }
    const requested = ModelType.create(paramModelType).normalized;
    if (requested !== dispatch.modelType.normalized) {
      throw new Error(
        `${verb}: behavior type '${requested}' is outside the active dispatch scope`,
      );
    }
  }

  #resolveDispatch(
    workerName: string,
    dispatchId: string | undefined,
    verb: string,
  ): ActiveDispatch | null {
    if (!this.#dispatches) return null;
    if (dispatchId) {
      return this.#dispatches.forDispatch(workerName, dispatchId);
    }
    const dispatches = this.#dispatches.forWorker(workerName);
    if (dispatches.length === 1) return dispatches[0];
    if (dispatches.length === 0) return null;
    throw new Error(
      `${verb}: worker '${workerName}' has ${dispatches.length} active dispatches — dispatchId is required`,
    );
  }

  /**
   * never throws: a worker with no dispatch, or several and no dispatchId, gets
   * null and every control-plane type is hidden
   */
  #visibleDispatch(
    workerName: string,
    dispatchId: string | undefined,
  ): ActiveDispatch | null {
    try {
      return this.#resolveDispatch(workerName, dispatchId, "read");
    } catch {
      return null;
    }
  }

  /**
   * a paged read outlives the request that authorized it, so each later page
   * re-checks that its dispatch is still registered
   */
  #assertStillActive(dispatch: ActiveDispatch | null, verb: string): void {
    if (!this.#dispatches || !dispatch) return;
    if (
      this.#dispatches.forDispatch(dispatch.workerName, dispatch.dispatchId) ===
        null
    ) {
      throw new Error(`${verb}: the dispatch ended while its reply was read`);
    }
  }

  /**
   * the usual lookup returns the first match across types, so a control-plane
   * record named like a user model would shadow it; when hidden, look again
   * among visible ones, primary before auto, then by id
   */
  async #findVisibleDefinition(
    idOrName: string,
    dispatch: ActiveDispatch | null,
  ): Promise<DefinitionLookupResult | null> {
    const definitionRepo = this.#repoContext.definitionRepo;
    const found = await findDefinitionByIdOrName(definitionRepo, idOrName);
    if (!found || !isHiddenFromWorker(found.type.normalized, dispatch)) {
      return found;
    }
    const visible = (entry: DefinitionLookupResult) =>
      !isHiddenFromWorker(entry.type.normalized, dispatch);
    const all = definitionRepo.findAllIncludingAutoGlobal
      ? await definitionRepo.findAllIncludingAutoGlobal()
      : await definitionRepo.findAllGlobal();
    const byName = all.find((entry) =>
      entry.definition.name === idOrName && visible(entry)
    );
    if (byName) return byName;
    const byId = await findDefinitionsByIdGlobal(definitionRepo, idOrName);
    return byId.find(visible) ?? null;
  }

  #repoForWorker(
    workerName: string,
    dispatchId?: string,
  ): UnifiedDataRepository {
    if (this.#dispatches && dispatchId) {
      const dispatch = this.#dispatches.forDispatch(workerName, dispatchId);
      if (dispatch?.dataRepo) return dispatch.dataRepo;
    }
    if (this.#dispatches) {
      const dispatches = this.#dispatches.forWorker(workerName);
      if (dispatches.length === 1 && dispatches[0].dataRepo) {
        return dispatches[0].dataRepo;
      }
    }
    return this.#repoContext.unifiedDataRepo;
  }

  async getData(
    workerName: string,
    params: GetDataParams & { dispatchId?: string },
  ): Promise<GetDataResult> {
    this.#assertDispatchScope(
      workerName,
      params.dispatchId,
      params.modelType,
      "getData",
    );
    const type = ModelType.create(params.modelType);
    const repo = this.#repoForWorker(workerName, params.dispatchId);
    let data: Data | null = null;
    if (params.dataId !== undefined) {
      data = await repo.findById(
        type,
        params.modelId,
        createDataId(params.dataId),
        params.version,
      );
    } else if (params.dataName !== undefined) {
      data = await repo.findByName(
        type,
        params.modelId,
        params.dataName,
        params.version,
      );
    } else {
      throw new Error("getData requires dataName or dataId");
    }
    if (data === null) {
      return { found: false };
    }
    return {
      found: true,
      dataId: data.id,
      version: data.version,
      name: data.name,
      contentType: data.contentType,
      size: data.size,
      checksum: data.checksum,
      contentPath: dataContentPath(
        params.modelType,
        params.modelId,
        data.name,
        data.version,
      ),
      tags: data.tags,
    };
  }

  async queryData(
    workerName: string,
    params: QueryDataParams & { dispatchId?: string },
  ): Promise<unknown[]> {
    const records: unknown[] = [];
    for await (const page of this.streamQueryData(workerName, params)) {
      records.push(...page);
    }
    return records;
  }

  async *streamQueryData(
    workerName: string,
    params: QueryDataParams & { dispatchId?: string },
  ): AsyncGenerator<unknown[]> {
    if (params.options?.select) {
      throw new Error(
        "Select projections are not permitted from workers",
      );
    }
    if (params.predicate.length > MAX_CAPABILITY_PREDICATE_LENGTH) {
      throw new Error("Query predicate exceeds maximum length");
    }
    let dispatch: ActiveDispatch | null = null;
    if (this.#dispatches) {
      dispatch = this.#resolveDispatch(
        workerName,
        params.dispatchId,
        "queryData",
      );
      if (!dispatch) {
        throw new Error(
          `queryData: worker '${workerName}' has no active dispatch`,
        );
      }
    }
    // a negative limit would reach SQLite as LIMIT -1, which is unbounded
    let remaining = params.options?.limit ?? Infinity;
    if (!(remaining > 0)) return;
    const excludeModelTypes = workerHiddenStoredTypes(dispatch);
    // the request span has ended by the second page, so later pages trace
    // under the dispatch
    const laterPageParent = dispatchTraceCarrier(
      dispatch?.traceHeaders,
      undefined,
    );
    let after: QueryCursorPosition | undefined;
    for (let page = 0;; page++) {
      if (page > 0) this.#assertStillActive(dispatch, "queryData");
      const parent = page === 0 ? undefined : laterPageParent;
      const limit = Math.min(this.#readPageSize, remaining);
      // control-plane records are excluded in the query itself, before any
      // limit, set after the worker's options so a worker cannot replace it
      const { results: records, last } = await observeExecutionWork(
        "query.execute",
        { "swamp.query.page": page },
        () =>
          this.#repoContext.dataQueryService.queryPage(
            params.predicate,
            {
              ...params.options,
              limit,
              sort: WORKER_READ_SORT,
              after,
              excludeModelTypes,
            },
          ),
        parent,
      );
      // Post-query check: a hidden record in the results means the exclusion
      // above was bypassed. It judges each result's resolved modelType, in any
      // spelling, not the predicate text, so CEL tricks (string concatenation,
      // variables, ternaries) cannot get past it.
      const leaked = records.some((record) => {
        const rec = record as { modelType?: string };
        return rec.modelType !== undefined &&
          isHiddenFromWorker(rec.modelType, dispatch);
      });
      if (leaked) {
        throw new Error(
          "Query matched access-control or infrastructure behavior data which is not permitted from workers",
        );
      }
      const serialized = await observeExecutionWork(
        "query.serialize",
        { "swamp.query.page": page, "swamp.query.items": records.length },
        () => Promise.resolve(records.map((record) => jsonSafeClone(record))),
        parent,
      );
      if (serialized.length > 0) yield serialized;
      remaining -= records.length;
      if (records.length < limit || last === undefined || remaining <= 0) {
        return;
      }
      after = last;
    }
  }

  listVersions(
    workerName: string,
    params: ListVersionsParams & { dispatchId?: string },
  ): Promise<number[]> {
    if (
      isHiddenFromWorker(
        params.modelType,
        this.#visibleDispatch(workerName, params.dispatchId),
      )
    ) {
      return Promise.resolve([]);
    }
    const repo = this.#repoForWorker(workerName, params.dispatchId);
    return repo.listVersions(
      ModelType.create(params.modelType),
      params.modelId,
      params.dataName,
    );
  }

  async deleteData(
    workerName: string,
    params: DeleteDataParams & { dispatchId?: string },
  ): Promise<{ deleted: boolean }> {
    this.#assertDispatchScope(
      workerName,
      params.dispatchId,
      params.modelType,
      "deleteData",
    );
    const type = ModelType.create(params.modelType);
    const repo = this.#repoForWorker(workerName, params.dispatchId);
    // root unit of work with no push, so the mark stages into it instead of the
    // signalChange fallback; the dispatching run's push carries it
    await runInRootUnitOfWork(
      this.#repoContext,
      { flush: undefined },
      async () => {
        if (params.removeLatestMarkerOnly) {
          await repo.removeLatestMarker(
            type,
            params.modelId,
            params.dataName,
          );
        } else {
          await repo.delete(
            type,
            params.modelId,
            params.dataName,
            params.version,
          );
        }
      },
    );
    return { deleted: true };
  }

  #secretInAllowlist(
    dispatch: ActiveDispatch,
    vaultName: string,
    secretKey: string,
  ): boolean {
    const allowed = dispatch.allowedSecrets;
    if (!allowed || allowed.hasDynamicRefs) return true;
    return allowed.staticRefs.some(
      (ref) => ref.vaultName === vaultName && ref.secretKey === secretKey,
    );
  }

  async resolveSecret(
    workerName: string,
    params: ResolveSecretParams & { dispatchId?: string },
  ): Promise<{ value: unknown }> {
    assertVaultNotDenied(params.vaultName, "resolveSecret");
    assertSecretKeyNotDenied(params.secretKey, "resolveSecret");
    let dispatch: ActiveDispatch | null = null;
    if (this.#dispatches) {
      dispatch = this.#resolveDispatch(
        workerName,
        params.dispatchId,
        "resolveSecret",
      );
      if (!dispatch) {
        throw new Error(
          `resolveSecret: worker '${workerName}' has no active dispatch`,
        );
      }
      // a version 6 runner loads references and sensitive fields through the
      // protected route, so a claim never arrives for it; a method's own vault
      // read still does, held to the allowlist below
      if (
        params.resource !== undefined &&
        dispatch.protocolVersion !== undefined &&
        shipsReferencesOnly(dispatch.protocolVersion)
      ) {
        throw new Error(
          `resolveSecret: a protocol version ${dispatch.protocolVersion} dispatch reads a resource's sensitive fields through ${DISPATCH_SECRETS_PATH}, not resolveSecret`,
        );
      }
      if (params.resource !== undefined) {
        // A claim admits a secret value only; the reader never asks for an
        // annotation, so one with a claim is malformed and fails closed.
        if (params.annotation) {
          throw new Error(
            "resolveSecret: a resource claim admits a secret value, not an annotation",
          );
        }
        // A claim adds authority; it never removes access the arguments
        // already grant. This also preserves reads of legacy records whose
        // tags predate the write-path guards required for a verified claim.
        if (
          !this.#secretInAllowlist(
            dispatch,
            params.vaultName,
            params.secretKey,
          )
        ) {
          await this.#claims.verify(
            dispatch,
            params.resource,
            params.vaultName,
            params.secretKey,
          );
        }
      } else if (
        !this.#secretInAllowlist(
          dispatch,
          params.vaultName,
          params.secretKey,
        )
      ) {
        throw new Error(
          `resolveSecret: secret '${params.secretKey}' is not referenced by the dispatched step`,
        );
      }
    }
    const scope = dispatch?.vaultAccess;
    const vault = await this.#vault();
    // held to the dispatching run's vault scope, as the same read in-process
    // would be
    return await inVaultScope(scope, async () => {
      if (params.annotation) {
        const annotation = await vault.getAnnotation(
          params.vaultName,
          params.secretKey,
        );
        return { value: annotation };
      }
      const value = await vault.get(
        params.vaultName,
        params.secretKey,
        `serve:${workerName}`,
      );
      // the dispatch's redactor must know the value before the reply leaves,
      // since the data plane scrubs resource writes with it; a step with no
      // pre-dispatch secrets gets its redactor here
      if (dispatch) {
        (dispatch.redactor ??= new SecretRedactor()).addSecret(value);
      }
      return { value };
    });
  }

  async putSecret(
    workerName: string,
    params: PutSecretParams & { dispatchId?: string },
  ): Promise<{ ok: boolean }> {
    assertVaultNotDenied(params.vaultName, "putSecret");
    assertSecretKeyNotDenied(params.secretKey, "putSecret");
    let scope: RunVaultAccess | undefined;
    if (this.#dispatches) {
      const dispatch = this.#resolveDispatch(
        workerName,
        params.dispatchId,
        "putSecret",
      );
      if (!dispatch) {
        throw new Error(
          `putSecret: worker '${workerName}' has no active dispatch`,
        );
      }
      scope = dispatch.vaultAccess;
    }
    const vault = await this.#vault();
    const secretValue = params.secretValue;
    // held to the dispatching run's vault scope, as the same write in-process
    // would be
    return await inVaultScope(scope, async () => {
      if (params.deleteAnnotation) {
        await vault.deleteAnnotation(params.vaultName, params.secretKey);
        return { ok: true };
      }
      if (params.annotation !== undefined) {
        await vault.putAnnotation(
          params.vaultName,
          params.secretKey,
          params.annotation as unknown as Parameters<
            VaultService["putAnnotation"]
          >[2],
        );
        return { ok: true };
      }
      if (secretValue === undefined) {
        throw new Error(
          "putSecret requires secretValue, annotation, or deleteAnnotation",
        );
      }
      await vault.put(params.vaultName, params.secretKey, secretValue);
      return { ok: true };
    });
  }

  async readDefinition(
    workerName: string,
    params: ReadDefinitionParams & { dispatchId?: string },
  ): Promise<unknown> {
    if (
      isHiddenFromWorker(
        params.definitionType,
        this.#visibleDispatch(workerName, params.dispatchId),
      )
    ) {
      return { found: false, definition: null };
    }
    const type = ModelType.create(params.definitionType);
    const definition = await this.#repoContext.definitionRepo.findByName(
      type,
      params.idOrName,
    );
    return jsonSafeClone({ found: definition !== null, definition });
  }

  async readOutput(
    workerName: string,
    params: ReadOutputParams & { dispatchId?: string },
  ): Promise<unknown> {
    if (params.outputId !== undefined && params.methodName !== undefined) {
      if (this.#outputTypeHidden(workerName, params)) return { result: null };
      return jsonSafeClone({
        result: await this.#repoContext.outputRepo.findById(
          ModelType.create(params.modelType),
          params.methodName,
          createModelOutputId(params.outputId),
        ),
      });
    }
    if (params.definitionId !== undefined && params.latestOnly) {
      if (this.#outputTypeHidden(workerName, params)) return { result: null };
      return jsonSafeClone({
        result: await this.#repoContext.outputRepo.findLatestByDefinition(
          ModelType.create(params.modelType),
          createDefinitionId(params.definitionId),
        ),
      });
    }
    const result: unknown[] = [];
    for await (const page of this.streamOutputList(workerName, params)) {
      result.push(...page);
    }
    return { result };
  }

  /** the list shapes of readOutput: modelType, optionally with definitionId */
  async *streamOutputList(
    workerName: string,
    params: ReadOutputParams & { dispatchId?: string },
  ): AsyncGenerator<unknown[]> {
    const dispatch = this.#visibleDispatch(workerName, params.dispatchId);
    if (isHiddenFromWorker(params.modelType, dispatch)) return;
    const pages = this.#repoContext.outputRepo.findPages(
      ModelType.create(params.modelType),
      {
        definitionId: params.definitionId === undefined
          ? undefined
          : createDefinitionId(params.definitionId),
        pageSize: this.#readPageSize,
      },
    );
    try {
      for (let page = 0;; page++) {
        if (page > 0) this.#assertStillActive(dispatch, "readOutput");
        const next = await pages.next();
        if (next.done) return;
        yield next.value.map((output) => jsonSafeClone(output));
      }
    } finally {
      await pages.return(undefined);
    }
  }

  #outputTypeHidden(
    workerName: string,
    params: ReadOutputParams & { dispatchId?: string },
  ): boolean {
    return isHiddenFromWorker(
      params.modelType,
      this.#visibleDispatch(workerName, params.dispatchId),
    );
  }

  async resolveModel(
    workerName: string,
    params: ResolveModelParams & { dispatchId?: string },
  ): Promise<unknown> {
    const resolved = await this.#findVisibleDefinition(
      params.modelIdOrName,
      this.#visibleDispatch(workerName, params.dispatchId),
    );
    if (!resolved) {
      return { found: false };
    }
    return jsonSafeClone({
      found: true,
      modelType: resolved.type.normalized,
      definition: resolved.definition,
    });
  }

  /**
   * handler errors are sanitized so internal paths do not leak in rpc.error
   * frames sent to workers
   */
  registerHandlers(channel: RpcChannel, workerName: string): void {
    const safe = <T>(
      verb: string,
      fn: (params: unknown) => Promise<T>,
    ): (params: unknown, ctx: RpcHandlerContext) => Promise<T> =>
    async (params, ctx) => {
      const start = performance.now();
      capLogger.debug(
        "Handler start: {verb} for worker {worker} (request {requestId})",
        { verb, worker: workerName, requestId: ctx.requestId },
      );
      try {
        const dispatchId = (params as Record<string, unknown> | null)
          ?.dispatchId;
        const dispatch = typeof dispatchId === "string"
          ? this.#dispatches?.forDispatch(workerName, dispatchId)
          : undefined;
        const result = await observeExecutionWork(
          "rpc.server",
          {
            "swamp.rpc.request_id": ctx.requestId,
            "swamp.trace.coverage": dispatchTraceCoverage(
              dispatch?.traceHeaders,
              ctx.trace,
            ),
            ...(dispatch
              ? {
                "swamp.dispatch.id": dispatch.dispatchId,
                "swamp.lease.id": dispatch.leaseId,
              }
              : {}),
          },
          (observation) => {
            ctx.responseTrace = observation.carrier;
            return fn(params);
          },
          dispatchTraceCarrier(dispatch?.traceHeaders, ctx.trace),
        );
        const elapsedMs = Math.round(performance.now() - start);
        if (elapsedMs >= SLOW_HANDLER_WARN_MS) {
          capLogger.warn(
            "Handler slow: {verb} for worker {worker} took {elapsedMs}ms (request {requestId})",
            { verb, worker: workerName, elapsedMs, requestId: ctx.requestId },
          );
        } else {
          capLogger.debug(
            "Handler done: {verb} for worker {worker} in {elapsedMs}ms (request {requestId})",
            { verb, worker: workerName, elapsedMs, requestId: ctx.requestId },
          );
        }
        return result;
      } catch (error) {
        const elapsedMs = Math.round(performance.now() - start);
        capLogger.warn(
          "Handler error: {verb} for worker {worker} after {elapsedMs}ms (request {requestId}): {error}",
          {
            verb,
            worker: workerName,
            elapsedMs,
            requestId: ctx.requestId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        throw new Error(sanitizeRpcError(error));
      }
    };

    const extractDispatchId = (params: unknown): string | undefined =>
      (params as Record<string, unknown> | null)?.dispatchId as
        | string
        | undefined;

    channel.register(
      RemoteMethod.getData,
      safe(RemoteMethod.getData, (params) =>
        this.getData(workerName, {
          ...parseUntrustedOrThrow(GetDataParamsSchema, params),
          dispatchId: extractDispatchId(params),
        })),
    );
    channel.register(
      RemoteMethod.queryData,
      safe(RemoteMethod.queryData, (params) =>
        this.queryData(workerName, {
          ...parseUntrustedOrThrow(QueryDataParamsSchema, params),
          dispatchId: extractDispatchId(params),
        })),
    );
    channel.register(
      RemoteMethod.listVersions,
      safe(
        RemoteMethod.listVersions,
        (params) =>
          this.listVersions(workerName, {
            ...parseUntrustedOrThrow(ListVersionsParamsSchema, params),
            dispatchId: extractDispatchId(params),
          }),
      ),
    );
    channel.register(
      RemoteMethod.deleteData,
      safe(RemoteMethod.deleteData, (params) =>
        this.deleteData(workerName, {
          ...parseUntrustedOrThrow(DeleteDataParamsSchema, params),
          dispatchId: extractDispatchId(params),
        })),
    );
    channel.register(
      RemoteMethod.resolveSecret,
      safe(
        RemoteMethod.resolveSecret,
        (params) =>
          this.resolveSecret(workerName, {
            ...parseUntrustedOrThrow(ResolveSecretParamsSchema, params),
            dispatchId: extractDispatchId(params),
          }),
      ),
    );
    channel.register(
      RemoteMethod.putSecret,
      safe(RemoteMethod.putSecret, (params) =>
        this.putSecret(workerName, {
          ...parseUntrustedOrThrow(PutSecretParamsSchema, params),
          dispatchId: extractDispatchId(params),
        })),
    );
    channel.register(
      RemoteMethod.readDefinition,
      safe(
        RemoteMethod.readDefinition,
        (params) =>
          this.readDefinition(workerName, {
            ...parseUntrustedOrThrow(ReadDefinitionParamsSchema, params),
            dispatchId: extractDispatchId(params),
          }),
      ),
    );
    channel.register(
      RemoteMethod.readOutput,
      safe(
        RemoteMethod.readOutput,
        (params) =>
          this.readOutput(workerName, {
            ...parseUntrustedOrThrow(ReadOutputParamsSchema, params),
            dispatchId: extractDispatchId(params),
          }),
      ),
    );
    channel.register(
      RemoteMethod.resolveModel,
      safe(
        RemoteMethod.resolveModel,
        (params) =>
          this.resolveModel(workerName, {
            ...parseUntrustedOrThrow(ResolveModelParamsSchema, params),
            dispatchId: extractDispatchId(params),
          }),
      ),
    );
  }
}
