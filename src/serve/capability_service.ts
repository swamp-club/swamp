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

/**
 * Orchestrator-side implementation of the capability protocol's metadata
 * verbs (see design/enablers/remote-execution.md, "The capability protocol").
 *
 * Each verb runs a worker's proxied context call against the orchestrator's
 * real repositories and services. Byte transfer is NOT here — `getData`
 * answers metadata plus a data-plane content path, and writes arrive as
 * data-plane HTTP requests (`src/serve/data_plane.ts`).
 */

import { ModelType } from "../domain/models/model_type.ts";
import {
  dispatchTraceCarrier,
  dispatchTraceCoverage,
  observeExecutionWork,
} from "../domain/remote/observability.ts";
import type { Data } from "../domain/data/data.ts";
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

/** Runs `fn` held to `scope`, or unscoped when there is none. */
function inVaultScope<T>(
  scope: RunVaultAccess | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return scope ? runWithVaultAccess(scope, fn) : fn();
}

const SLOW_HANDLER_WARN_MS = 5_000;

const MAX_CAPABILITY_PREDICATE_LENGTH = 4096;

const RPC_PATH_PATTERN =
  /(?:^|[\s"'`(])\/(?:opt|home|var|tmp|etc|usr|root|Users|private)\//;
const RPC_SWAMP_PATH_PATTERN = /\/.swamp\//;

function sanitizeRpcError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (RPC_PATH_PATTERN.test(raw) || RPC_SWAMP_PATH_PATTERN.test(raw)) {
    return "Capability verb failed — internal error";
  }
  if (raw.length > 200) {
    return raw.slice(0, 200) + "...";
  }
  return raw;
}

/** Builds the data-plane content path for an artifact version. */
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
  /** Overridable for tests; defaults to VaultService.fromRepository. */
  createVaultService?: () => Promise<VaultService>;
}

/**
 * Application service answering capability verbs. One instance serves every
 * enrolled worker — verbs carry full addressing, and authorization beyond
 * enrollment is the data writer's declared-spec enforcement on the write
 * path (see the design doc's "Authenticating the data plane").
 */
export class CapabilityService {
  readonly #repoDir: string;
  readonly #repoContext: RepositoryContext;
  readonly #dispatches: DispatchRegistry | undefined;
  readonly #createVaultService: () => Promise<VaultService>;
  #vaultService: Promise<VaultService> | null = null;
  /** Verifies resource claims on resolveSecret (swamp-club#3529). */
  readonly #claims: ResourceClaimVerifier;

  constructor(options: CapabilityServiceOptions) {
    this.#repoDir = options.repoDir;
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
   * The dispatch a read belongs to, for deciding which control-plane records
   * it may see. Never throws: a worker with no dispatch, or with several and
   * no dispatchId, gets null, and every control-plane type is then hidden.
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
   * findDefinitionByIdOrName, skipping definitions hidden from the worker.
   * The usual lookup returns the first match across types, so a
   * control-plane record named like a user model would shadow it; when the
   * first match is hidden, look again among the visible ones, primary
   * definitions before auto-definitions, then by id. That fallback reads
   * every definition, but runs only when a control-plane record shares the
   * name or id asked for.
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
    // Control-plane records are left out of the query itself, before any
    // limit, so a broad predicate returns the rest rather than failing. The
    // exclusion is set here, after the worker's options, so a worker cannot
    // replace it (swamp-club#3129).
    const records = await observeExecutionWork(
      "query.execute",
      {},
      () =>
        this.#repoContext.dataQueryService.query(
          params.predicate,
          {
            ...params.options,
            excludeModelTypes: workerHiddenStoredTypes(dispatch),
          },
        ),
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
    return await observeExecutionWork("query.serialize", {
      "swamp.query.items": records.length,
    }, () => Promise.resolve(records.map((record) => jsonSafeClone(record))));
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
    // The delete runs in a root unit of work with no push, so its mark stages
    // into it instead of reaching the hook through signalChange's fallback
    // (swamp-club#3056). Nothing pushes here, as before: the dispatching
    // run's push carries it.
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
    // Held to the dispatching run's vault scope, as the same read in-process
    // would be (swamp-club#2676).
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
      // Serve is about to deliver this value to the dispatch, so the
      // dispatch's redactor must know it before the reply leaves: the data
      // plane scrubs the dispatch's resource writes with it
      // (swamp-club#3527). A step dispatched without pre-dispatch secrets
      // has no redactor yet, so the first delivery creates it.
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
    // Held to the dispatching run's vault scope, as the same write
    // in-process would be (swamp-club#2676).
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
    const hidden = isHiddenFromWorker(
      params.modelType,
      this.#visibleDispatch(workerName, params.dispatchId),
    );
    if (hidden) {
      // The shape each branch returns when nothing is stored.
      const single = params.outputId !== undefined &&
          params.methodName !== undefined ||
        params.definitionId !== undefined && params.latestOnly === true;
      return { result: single ? null : [] };
    }
    const type = ModelType.create(params.modelType);
    const outputRepo = this.#repoContext.outputRepo;
    let result: unknown;
    if (params.outputId !== undefined && params.methodName !== undefined) {
      result = await outputRepo.findById(
        type,
        params.methodName,
        createModelOutputId(params.outputId),
      );
    } else if (params.definitionId !== undefined) {
      const definitionId = createDefinitionId(params.definitionId);
      result = params.latestOnly
        ? await outputRepo.findLatestByDefinition(type, definitionId)
        : await outputRepo.findByDefinition(type, definitionId);
    } else {
      result = await outputRepo.findAll(type);
    }
    return jsonSafeClone({ result });
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
   * Register every capability verb on an enrolled worker's channel. Params
   * are schema-validated at the boundary; handler errors are sanitized to
   * avoid leaking internal paths in rpc.error frames sent to workers.
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
