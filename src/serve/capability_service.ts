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
 * verbs (see design/remote-execution.md, "The capability protocol").
 *
 * Each verb runs a worker's proxied context call against the orchestrator's
 * real repositories and services. Byte transfer is NOT here — `getData`
 * answers metadata plus a data-plane content path, and writes arrive as
 * data-plane HTTP requests (`src/serve/data_plane.ts`).
 */

import { ModelType } from "../domain/models/model_type.ts";
import type { Data } from "../domain/data/data.ts";
import type { UnifiedDataRepository } from "../domain/data/repositories.ts";
import { createDataId } from "../domain/data/data_id.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import { VaultService } from "../domain/vaults/vault_service.ts";
import { findDefinitionByIdOrName } from "../domain/models/model_lookup.ts";
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
import type { RpcChannel } from "../domain/remote/rpc_channel.ts";
import { jsonSafeClone } from "./serializer.ts";
import type { ActiveDispatch, DispatchRegistry } from "./dispatch_registry.ts";
import { GRANT_MODEL_TYPE } from "../domain/models/access/grant_model.ts";
import { GROUP_MODEL_TYPE } from "../domain/models/access/group_model.ts";
import {
  SERVER_TOKEN_MODEL_TYPE,
  SERVER_TOKEN_SECRET_KEY_PREFIX,
} from "../domain/models/access/server_token_model.ts";
import {
  ENROLLMENT_TOKEN_MODEL_TYPE,
  WORKER_TOKEN_SECRET_KEY_PREFIX,
} from "../domain/models/worker/enrollment_token_model.ts";
import { WORKER_MODEL_TYPE } from "../domain/models/worker/worker_model.ts";
import { STEP_LEASE_MODEL_TYPE } from "../domain/models/worker/step_lease_model.ts";

const DENIED_SECRET_KEY_PREFIXES: readonly string[] = [
  SERVER_TOKEN_SECRET_KEY_PREFIX,
  WORKER_TOKEN_SECRET_KEY_PREFIX,
];

const DENIED_QUERY_MODEL_TYPES: readonly string[] = [
  GRANT_MODEL_TYPE.normalized,
  GROUP_MODEL_TYPE.normalized,
  SERVER_TOKEN_MODEL_TYPE.normalized,
  ENROLLMENT_TOKEN_MODEL_TYPE.normalized,
  WORKER_MODEL_TYPE.normalized,
  STEP_LEASE_MODEL_TYPE.normalized,
];

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

  constructor(options: CapabilityServiceOptions) {
    this.#repoDir = options.repoDir;
    this.#repoContext = options.repoContext;
    this.#dispatches = options.dispatches;
    this.#createVaultService = options.createVaultService ??
      (() => VaultService.fromRepository(this.#repoDir));
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
        `${verb}: model type '${requested}' is outside the active dispatch scope`,
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
    if (this.#dispatches) {
      const dispatch = this.#resolveDispatch(
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
    const records = await this.#repoContext.dataQueryService.query(
      params.predicate,
      params.options,
    );
    // Post-query filter: remove any records belonging to infrastructure
    // model types. This is robust against CEL-level bypasses (string
    // concatenation, variables, ternaries) because it operates on the
    // resolved modelType of each result, not on the predicate text.
    const filtered = records.filter((record) => {
      const rec = record as { modelType?: string };
      if (!rec.modelType) return true;
      const normalized = ModelType.create(rec.modelType).normalized;
      return !DENIED_QUERY_MODEL_TYPES.includes(normalized);
    });
    if (filtered.length < records.length) {
      throw new Error(
        "Query matched access-control or infrastructure model data which is not permitted from workers",
      );
    }
    return records.map((record) => jsonSafeClone(record));
  }

  listVersions(
    workerName: string,
    params: ListVersionsParams & { dispatchId?: string },
  ): Promise<number[]> {
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
    return { deleted: true };
  }

  #assertSecretKeyNotDenied(secretKey: string, verb: string): void {
    const normalized = secretKey.toLowerCase();
    if (DENIED_SECRET_KEY_PREFIXES.some((p) => normalized.startsWith(p))) {
      throw new Error(
        `${verb}: access denied — infrastructure secrets are not accessible from dispatched methods`,
      );
    }
  }

  #assertSecretInAllowlist(
    dispatch: ActiveDispatch,
    vaultName: string,
    secretKey: string,
    verb: string,
  ): void {
    const allowed = dispatch.allowedSecrets;
    if (!allowed) return;
    if (allowed.hasDynamicRefs) return;
    const isAllowed = allowed.staticRefs.some(
      (ref) => ref.vaultName === vaultName && ref.secretKey === secretKey,
    );
    if (!isAllowed) {
      throw new Error(
        `${verb}: secret '${secretKey}' is not referenced by the dispatched step`,
      );
    }
  }

  async resolveSecret(
    workerName: string,
    params: ResolveSecretParams & { dispatchId?: string },
  ): Promise<{ value: unknown }> {
    if (this.#dispatches) {
      const dispatch = this.#resolveDispatch(
        workerName,
        params.dispatchId,
        "resolveSecret",
      );
      if (!dispatch) {
        throw new Error(
          `resolveSecret: worker '${workerName}' has no active dispatch`,
        );
      }
      this.#assertSecretKeyNotDenied(params.secretKey, "resolveSecret");
      this.#assertSecretInAllowlist(
        dispatch,
        params.vaultName,
        params.secretKey,
        "resolveSecret",
      );
    }
    const vault = await this.#vault();
    if (params.annotation) {
      const annotation = await vault.getAnnotation(
        params.vaultName,
        params.secretKey,
      );
      return { value: annotation };
    }
    const value = await vault.get(params.vaultName, params.secretKey);
    return { value };
  }

  async putSecret(
    workerName: string,
    params: PutSecretParams & { dispatchId?: string },
  ): Promise<{ ok: boolean }> {
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
      this.#assertSecretKeyNotDenied(params.secretKey, "putSecret");
    }
    const vault = await this.#vault();
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
    if (params.secretValue === undefined) {
      throw new Error(
        "putSecret requires secretValue, annotation, or deleteAnnotation",
      );
    }
    await vault.put(params.vaultName, params.secretKey, params.secretValue);
    return { ok: true };
  }

  async readDefinition(params: ReadDefinitionParams): Promise<unknown> {
    const type = ModelType.create(params.definitionType);
    const definition = await this.#repoContext.definitionRepo.findByName(
      type,
      params.idOrName,
    );
    return jsonSafeClone({ found: definition !== null, definition });
  }

  async readOutput(params: ReadOutputParams): Promise<unknown> {
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

  async resolveModel(params: ResolveModelParams): Promise<unknown> {
    const resolved = await findDefinitionByIdOrName(
      this.#repoContext.definitionRepo,
      params.modelIdOrName,
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
      fn: (params: unknown) => Promise<T>,
    ): (params: unknown) => Promise<T> =>
    async (params) => {
      try {
        return await fn(params);
      } catch (error) {
        throw new Error(sanitizeRpcError(error));
      }
    };

    const extractDispatchId = (params: unknown): string | undefined =>
      (params as Record<string, unknown> | null)?.dispatchId as
        | string
        | undefined;

    channel.register(
      RemoteMethod.getData,
      safe((params) =>
        this.getData(workerName, {
          ...GetDataParamsSchema.parse(params),
          dispatchId: extractDispatchId(params),
        })
      ),
    );
    channel.register(
      RemoteMethod.queryData,
      safe((params) =>
        this.queryData(workerName, {
          ...QueryDataParamsSchema.parse(params),
          dispatchId: extractDispatchId(params),
        })
      ),
    );
    channel.register(
      RemoteMethod.listVersions,
      safe((params) =>
        this.listVersions(workerName, {
          ...ListVersionsParamsSchema.parse(params),
          dispatchId: extractDispatchId(params),
        })
      ),
    );
    channel.register(
      RemoteMethod.deleteData,
      safe((params) =>
        this.deleteData(workerName, {
          ...DeleteDataParamsSchema.parse(params),
          dispatchId: extractDispatchId(params),
        })
      ),
    );
    channel.register(
      RemoteMethod.resolveSecret,
      safe((params) =>
        this.resolveSecret(workerName, {
          ...ResolveSecretParamsSchema.parse(params),
          dispatchId: extractDispatchId(params),
        })
      ),
    );
    channel.register(
      RemoteMethod.putSecret,
      safe((params) =>
        this.putSecret(workerName, {
          ...PutSecretParamsSchema.parse(params),
          dispatchId: extractDispatchId(params),
        })
      ),
    );
    channel.register(
      RemoteMethod.readDefinition,
      safe((params) =>
        this.readDefinition(ReadDefinitionParamsSchema.parse(params))
      ),
    );
    channel.register(
      RemoteMethod.readOutput,
      safe((params) => this.readOutput(ReadOutputParamsSchema.parse(params))),
    );
    channel.register(
      RemoteMethod.resolveModel,
      safe((params) =>
        this.resolveModel(ResolveModelParamsSchema.parse(params))
      ),
    );
  }
}
