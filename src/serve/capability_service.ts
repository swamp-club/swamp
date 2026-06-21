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
  readonly #createVaultService: () => Promise<VaultService>;
  #vaultService: Promise<VaultService> | null = null;

  constructor(options: CapabilityServiceOptions) {
    this.#repoDir = options.repoDir;
    this.#repoContext = options.repoContext;
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

  async getData(params: GetDataParams): Promise<GetDataResult> {
    const type = ModelType.create(params.modelType);
    let data: Data | null = null;
    if (params.dataId !== undefined) {
      data = await this.#repoContext.unifiedDataRepo.findById(
        type,
        params.modelId,
        createDataId(params.dataId),
        params.version,
      );
    } else if (params.dataName !== undefined) {
      data = await this.#repoContext.unifiedDataRepo.findByName(
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

  async queryData(params: QueryDataParams): Promise<unknown[]> {
    const records = await this.#repoContext.dataQueryService.query(
      params.predicate,
      params.options,
    );
    return records.map((record) => jsonSafeClone(record));
  }

  listVersions(params: ListVersionsParams): Promise<number[]> {
    return this.#repoContext.unifiedDataRepo.listVersions(
      ModelType.create(params.modelType),
      params.modelId,
      params.dataName,
    );
  }

  async deleteData(params: DeleteDataParams): Promise<{ deleted: boolean }> {
    const type = ModelType.create(params.modelType);
    if (params.removeLatestMarkerOnly) {
      await this.#repoContext.unifiedDataRepo.removeLatestMarker(
        type,
        params.modelId,
        params.dataName,
      );
    } else {
      await this.#repoContext.unifiedDataRepo.delete(
        type,
        params.modelId,
        params.dataName,
        params.version,
      );
    }
    return { deleted: true };
  }

  async resolveSecret(
    params: ResolveSecretParams,
  ): Promise<{ value: unknown }> {
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

  async putSecret(params: PutSecretParams): Promise<{ ok: boolean }> {
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
   * are schema-validated at the boundary; handler errors surface to the
   * worker as rpc.error frames.
   */
  registerHandlers(channel: RpcChannel): void {
    channel.register(
      RemoteMethod.getData,
      (params) => this.getData(GetDataParamsSchema.parse(params)),
    );
    channel.register(
      RemoteMethod.queryData,
      (params) => this.queryData(QueryDataParamsSchema.parse(params)),
    );
    channel.register(
      RemoteMethod.listVersions,
      (params) => this.listVersions(ListVersionsParamsSchema.parse(params)),
    );
    channel.register(
      RemoteMethod.deleteData,
      (params) => this.deleteData(DeleteDataParamsSchema.parse(params)),
    );
    channel.register(
      RemoteMethod.resolveSecret,
      (params) => this.resolveSecret(ResolveSecretParamsSchema.parse(params)),
    );
    channel.register(
      RemoteMethod.putSecret,
      (params) => this.putSecret(PutSecretParamsSchema.parse(params)),
    );
    channel.register(
      RemoteMethod.readDefinition,
      (params) => this.readDefinition(ReadDefinitionParamsSchema.parse(params)),
    );
    channel.register(
      RemoteMethod.readOutput,
      (params) => this.readOutput(ReadOutputParamsSchema.parse(params)),
    );
    channel.register(
      RemoteMethod.resolveModel,
      (params) => this.resolveModel(ResolveModelParamsSchema.parse(params)),
    );
  }
}
