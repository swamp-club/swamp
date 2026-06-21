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
 * The remote MethodContext (see design/remote-execution.md, "The remote
 * `MethodContext`" and "The capability protocol").
 *
 * Built from proxy adapters: metadata capability verbs ride the control
 * socket, artifact bytes ride the HTTP data plane, and writes flow through
 * orchestrator-side data writers (durable immediately). Method author APIs
 * are unchanged. Synchronous repository members and whole-store enumeration
 * cannot proxy and fail loudly with a clear unsupported-on-remote-worker
 * error — see the design doc's capability inventory.
 */

import { join } from "@std/path";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import type {
  DataHandle,
  DataWriter,
  MethodContext,
} from "../domain/models/model.ts";
import { ModelType } from "../domain/models/model_type.ts";
import type { UnifiedDataRepository } from "../domain/data/repositories.ts";
import type { Data } from "../domain/data/data.ts";
import { createDataId, generateDataId } from "../domain/data/data_id.ts";
import { SOLO_NAMESPACE } from "../domain/data/namespace.ts";
import type { DefinitionRepository } from "../domain/definitions/repositories.ts";
import type { OutputRepository } from "../domain/models/repositories.ts";
import type { DataQueryService } from "../domain/data/data_query_service.ts";
import type { VaultService } from "../domain/vaults/vault_service.ts";
import { SecretRedactor } from "../domain/secrets/mod.ts";
import { createExtensionCelEnvironment } from "../infrastructure/cel/cel_evaluator.ts";
import type { RpcChannel } from "../domain/remote/rpc_channel.ts";
import {
  type DispatchParams,
  type GetDataResult,
  RemoteMethod,
} from "../domain/remote/protocol.ts";
import type { DataPlaneClient, RemoteDataHandle } from "./data_plane_client.ts";

const logger = getSwampLogger(["worker", "method-context"]);

/** Raised when a method touches a capability that cannot proxy. */
export class UnsupportedOnRemoteWorkerError extends Error {
  constructor(member: string) {
    super(
      `${member} is not supported on a remote worker — it has no proxied ` +
        "capability verb (see design/remote-execution.md). Run this method " +
        "on the loopback executor instead.",
    );
    this.name = "UnsupportedOnRemoteWorkerError";
  }
}

function unsupported(member: string): never {
  throw new UnsupportedOnRemoteWorkerError(member);
}

function toDataHandle(remote: RemoteDataHandle): DataHandle {
  return {
    dataId: createDataId(remote.dataId),
    name: remote.name,
    specName: remote.specName,
    kind: remote.kind,
    version: remote.version,
    size: remote.size,
    tags: remote.tags ?? {},
    metadata: {} as DataHandle["metadata"],
  };
}

export interface RemoteContextOptions {
  channel: RpcChannel;
  client: DataPlaneClient;
  dispatch: DispatchParams;
  /** Per-dispatch scratch directory; doubles as the spool location. */
  scratchDir: string;
  /** Local root the bundle's co-located assets were prefetched to. */
  extensionFilesDir?: string;
  signal: AbortSignal;
  onEvent?: MethodContext["onEvent"];
}

/**
 * The data repository proxy: async reads ride the verbs + data plane; the
 * write path and synchronous members fail loudly (writes flow exclusively
 * through the remote writers below, never through raw repository saves).
 */
function createRemoteDataRepository(
  options: RemoteContextOptions,
): UnifiedDataRepository {
  const { channel, client, signal } = options;

  const getData = (
    params: Record<string, unknown>,
  ): Promise<GetDataResult> =>
    channel.call<GetDataResult>(RemoteMethod.getData, params, { signal });

  const toData = (result: GetDataResult): Data =>
    ({
      id: createDataId(result.dataId!),
      name: result.name!,
      version: result.version!,
      contentType: result.contentType ?? "application/octet-stream",
      size: result.size,
      checksum: result.checksum,
      tags: {},
      lifecycle: "active",
      isDeleted: false,
    }) as unknown as Data;

  return {
    namespace: SOLO_NAMESPACE,
    findByName: async (type, modelId, dataName, version) => {
      const result = await getData({
        modelType: (typeof type === "string" ? ModelType.create(type) : type)
          .normalized,
        modelId,
        dataName,
        version,
      });
      return result.found ? toData(result) : null;
    },
    findById: async (type, modelId, dataId, version) => {
      const result = await getData({
        modelType: type.normalized,
        modelId,
        dataId,
        version,
      });
      return result.found ? toData(result) : null;
    },
    getContent: async (type, modelId, dataName, version) => {
      const result = await getData({
        modelType: (typeof type === "string" ? ModelType.create(type) : type)
          .normalized,
        modelId,
        dataName,
        version,
      });
      if (!result.found || result.contentPath === undefined) {
        return null;
      }
      return await client.readArtifact(result.contentPath, signal);
    },
    stream: async function* (type, modelId, dataName, version) {
      const result = await getData({
        modelType: (typeof type === "string" ? ModelType.create(type) : type)
          .normalized,
        modelId,
        dataName,
        version,
      });
      if (result.found && result.contentPath !== undefined) {
        yield await client.readArtifact(result.contentPath, signal);
      }
    },
    listVersions: (type, modelId, dataName) =>
      channel.call<number[]>(RemoteMethod.listVersions, {
        modelType: type.normalized,
        modelId,
        dataName,
      }, { signal }),
    delete: async (type, modelId, dataName, version) => {
      await channel.call(RemoteMethod.deleteData, {
        modelType: type.normalized,
        modelId,
        dataName,
        version,
      }, { signal });
    },
    removeLatestMarker: async (type, modelId, dataName) => {
      await channel.call(RemoteMethod.deleteData, {
        modelType: type.normalized,
        modelId,
        dataName,
        removeLatestMarkerOnly: true,
      }, { signal });
    },
    nextId: () => generateDataId(),
    // Whole-store enumeration and the write/maintenance path have no verbs;
    // writes flow through the remote writers, never raw repository saves.
    findAllGlobal: () => unsupported("dataRepository.findAllGlobal"),
    findAllForModel: () => unsupported("dataRepository.findAllForModel"),
    save: () => unsupported("dataRepository.save"),
    append: () => unsupported("dataRepository.append"),
    allocateVersion: () => unsupported("dataRepository.allocateVersion"),
    finalizeVersion: () => unsupported("dataRepository.finalizeVersion"),
    rename: () => unsupported("dataRepository.rename"),
    collectGarbage: () => unsupported("dataRepository.collectGarbage"),
    getPath: () => unsupported("dataRepository.getPath"),
    getContentPath: () => unsupported("dataRepository.getContentPath"),
    // Synchronous members cannot make a network round-trip at all.
    getLatestVersionSync: () =>
      unsupported("dataRepository.getLatestVersionSync"),
    findByNameSync: () => unsupported("dataRepository.findByNameSync"),
    listVersionsSync: () => unsupported("dataRepository.listVersionsSync"),
    getContentSync: () => unsupported("dataRepository.getContentSync"),
    findAllForModelSync: () =>
      unsupported("dataRepository.findAllForModelSync"),
    findAllGlobalSync: () => unsupported("dataRepository.findAllGlobalSync"),
  } as UnifiedDataRepository;
}

function createRemoteVaultService(
  options: RemoteContextOptions,
): VaultService {
  const { channel, signal } = options;
  const resolveSecret = (params: Record<string, unknown>) =>
    channel.call<{ value: unknown }>(RemoteMethod.resolveSecret, params, {
      signal,
    });
  const putSecret = (params: Record<string, unknown>) =>
    channel.call<{ ok: boolean }>(RemoteMethod.putSecret, params, { signal });

  const proxy = {
    get: async (vaultName: string, secretKey: string) => {
      const result = await resolveSecret({ vaultName, secretKey });
      return result.value as string;
    },
    getAnnotation: async (vaultName: string, secretKey: string) => {
      const result = await resolveSecret({
        vaultName,
        secretKey,
        annotation: true,
      });
      return result.value;
    },
    put: async (vaultName: string, secretKey: string, secretValue: string) => {
      await putSecret({ vaultName, secretKey, secretValue });
    },
    putAnnotation: async (
      vaultName: string,
      secretKey: string,
      annotation: unknown,
    ) => {
      await putSecret({ vaultName, secretKey, annotation });
    },
    deleteAnnotation: async (vaultName: string, secretKey: string) => {
      await putSecret({ vaultName, secretKey, deleteAnnotation: true });
    },
    list: () => unsupported("vaultService.list"),
    supportsRefreshHooks: () => false,
    supportsAnnotations: () => true,
    getRefreshHook: () => Promise.resolve(null),
  };
  // VaultService is a concrete class; the proxy implements the surface
  // methods reach through MethodContext. Structural mismatch is deliberate.
  return proxy as unknown as VaultService;
}

function createRemoteDefinitionRepository(
  options: RemoteContextOptions,
): DefinitionRepository {
  const { channel, signal } = options;
  const readDefinition = async (
    definitionType: string,
    idOrName: string,
  ): Promise<unknown> => {
    const result = await channel.call<
      { found: boolean; definition: unknown }
    >(RemoteMethod.readDefinition, { definitionType, idOrName }, { signal });
    return result.found ? result.definition : null;
  };

  return {
    findByName: (type, name) =>
      readDefinition(type.normalized, name) as ReturnType<
        DefinitionRepository["findByName"]
      >,
    findById: (type, id) =>
      readDefinition(type.normalized, id) as ReturnType<
        DefinitionRepository["findById"]
      >,
    findByNameGlobal: async (name) => {
      const result = await channel.call<
        { found: boolean; modelType?: string; definition?: unknown }
      >(RemoteMethod.resolveModel, { modelIdOrName: name }, { signal });
      if (!result.found) {
        return null;
      }
      return {
        definition: result.definition,
        type: ModelType.create(result.modelType!),
      } as Awaited<ReturnType<DefinitionRepository["findByNameGlobal"]>>;
    },
    findAll: () => unsupported("definitionRepository.findAll"),
    findAllGlobal: () => unsupported("definitionRepository.findAllGlobal"),
    save: () => unsupported("definitionRepository.save"),
    delete: () => unsupported("definitionRepository.delete"),
    nextId: () => unsupported("definitionRepository.nextId"),
    getPath: () => unsupported("definitionRepository.getPath"),
  } as DefinitionRepository;
}

function createRemoteOutputRepository(
  options: RemoteContextOptions,
): OutputRepository {
  const { channel, signal } = options;
  const readOutput = (params: Record<string, unknown>) =>
    channel.call<{ result: unknown }>(RemoteMethod.readOutput, params, {
      signal,
    });

  return {
    findById: async (type: ModelType, methodName: string, outputId: string) =>
      (await readOutput({
        modelType: type.normalized,
        methodName,
        outputId,
      })).result as Awaited<ReturnType<OutputRepository["findById"]>>,
    findByDefinition: async (type: ModelType, definitionId: string) =>
      (await readOutput({
        modelType: type.normalized,
        definitionId,
      })).result as Awaited<ReturnType<OutputRepository["findByDefinition"]>>,
    findLatestByDefinition: async (type: ModelType, definitionId: string) =>
      (await readOutput({
        modelType: type.normalized,
        definitionId,
        latestOnly: true,
      })).result as Awaited<
        ReturnType<OutputRepository["findLatestByDefinition"]>
      >,
    findAll: async (type: ModelType) =>
      (await readOutput({ modelType: type.normalized })).result as Awaited<
        ReturnType<OutputRepository["findAll"]>
      >,
    findAllGlobal: () => unsupported("outputRepository.findAllGlobal"),
    findAllGlobalSince: () =>
      unsupported("outputRepository.findAllGlobalSince"),
    save: () => unsupported("outputRepository.save"),
    delete: () => unsupported("outputRepository.delete"),
    getPath: () => unsupported("outputRepository.getPath"),
  } as unknown as OutputRepository;
}

interface RemoteWriters {
  writeResource: NonNullable<MethodContext["writeResource"]>;
  createFileWriter: NonNullable<MethodContext["createFileWriter"]>;
  /** Handles for everything persisted, surviving write-then-throw. */
  getHandles: () => DataHandle[];
}

function createRemoteWriters(options: RemoteContextOptions): RemoteWriters {
  const { client, scratchDir, signal } = options;
  const handles: DataHandle[] = [];

  const writeResource: RemoteWriters["writeResource"] = async (
    specName,
    name,
    data,
    _overrides,
  ) => {
    const remote = await client.writeResource(
      { specName, name, data },
      signal,
    );
    const handle = toDataHandle(remote);
    handles.push(handle);
    return handle;
  };

  const createFileWriter: RemoteWriters["createFileWriter"] = (
    specName,
    name,
    _overrides,
  ) => {
    let opened: Promise<{ writerId: string; dataId: string }> | null = null;
    let spoolPath: string | null = null;
    let finalized = false;
    const placeholderDataId = generateDataId();

    const open = () => {
      opened ??= client.openWriter({ specName, name }, signal);
      return opened;
    };
    const track = (remote: RemoteDataHandle): DataHandle => {
      const handle = toDataHandle(remote);
      handles.push(handle);
      finalized = true;
      return handle;
    };
    const ensureNotFinalized = () => {
      if (finalized) {
        throw new Error(`DataWriter "${name}" has already been finalized`);
      }
    };

    const writer: DataWriter = {
      // The orchestrator assigns the durable data id at open; this local id
      // only identifies the writer object itself.
      dataId: placeholderDataId,
      name,
      writeAll: async (content) => {
        ensureNotFinalized();
        const { writerId } = await open();
        return track(await client.writeContent(writerId, content, signal));
      },
      writeText: async (text) => {
        ensureNotFinalized();
        const { writerId } = await open();
        return track(
          await client.writeContent(
            writerId,
            new TextEncoder().encode(text),
            signal,
          ),
        );
      },
      writeLine: async (line) => {
        ensureNotFinalized();
        const { writerId } = await open();
        // One request per line: durable at the orchestrator once resolved.
        await client.writeLine(writerId, line, signal);
      },
      writeStream: async (stream, _streamOptions) => {
        ensureNotFinalized();
        const { writerId } = await open();
        return track(await client.writeContent(writerId, stream, signal));
      },
      getFilePath: () => {
        ensureNotFinalized();
        // Worker-local spool file: bytes upload on finalize() — for this one
        // mode durability moves to finalize-time (see the design doc).
        if (spoolPath === null) {
          spoolPath = join(scratchDir, `spool-${crypto.randomUUID()}`);
          Deno.writeFileSync(spoolPath, new Uint8Array());
        }
        return Promise.resolve(spoolPath);
      },
      finalize: async () => {
        ensureNotFinalized();
        const { writerId } = await open();
        if (spoolPath !== null) {
          const file = await Deno.open(spoolPath, { read: true });
          return track(
            await client.writeContent(writerId, file.readable, signal),
          );
        }
        return track(await client.finalizeWriter(writerId, signal));
      },
    };
    return writer;
  };

  return { writeResource, createFileWriter, getHandles: () => [...handles] };
}

export interface RemoteMethodContextResult {
  context: MethodContext;
  /** Handles persisted so far — collected even when the method throws. */
  getHandles: () => DataHandle[];
}

/**
 * Assemble the full remote MethodContext for one dispatch. The method
 * author API is identical to a local run; only the implementations behind
 * the handles differ.
 */
export function createRemoteMethodContext(
  options: RemoteContextOptions,
): RemoteMethodContextResult {
  const { dispatch, channel, signal } = options;
  const execution = dispatch.execution;
  const modelType = ModelType.create(execution.modelType);
  const dataRepository = createRemoteDataRepository(options);
  const vaultService = createRemoteVaultService(options);
  const definitionRepository = createRemoteDefinitionRepository(options);
  const outputRepository = createRemoteOutputRepository(options);
  const writers = createRemoteWriters(options);

  const queryData = (predicate: string, select?: string) =>
    channel.call<unknown[]>(RemoteMethod.queryData, {
      predicate,
      options: select !== undefined ? { select } : undefined,
    }, { signal });

  const dataQueryService = {
    query: (
      predicate: string,
      queryOptions?: { limit?: number; select?: string },
    ) =>
      channel.call<unknown[]>(RemoteMethod.queryData, {
        predicate,
        options: queryOptions,
      }, { signal }),
  } as unknown as DataQueryService;

  const readResource = async (
    instanceName: string,
    version?: number,
  ): Promise<Record<string, unknown> | null> => {
    const content = await dataRepository.getContent(
      modelType,
      execution.modelId,
      instanceName,
      version,
    );
    if (content === null) {
      return null;
    }
    return JSON.parse(new TextDecoder().decode(content)) as Record<
      string,
      unknown
    >;
  };

  const deleteResource = async (instanceName: string): Promise<void> => {
    await options.client.deleteResource({ name: instanceName }, signal);
  };

  const readModelData = async (modelName: string, specName?: string) => {
    const predicate = specName === undefined
      ? `modelName == ${JSON.stringify(modelName)}`
      : `modelName == ${JSON.stringify(modelName)} && specName == ${
        JSON.stringify(specName)
      }`;
    return await channel.call<never[]>(RemoteMethod.queryData, {
      predicate,
      options: { loadAttributes: true },
    }, { signal });
  };

  const extensionFilesDir = options.extensionFilesDir;
  const context: MethodContext = {
    signal,
    // The scratch directory; workers carry no repository checkout, so repo
    // contents are not reachable through it (see the design doc).
    repoDir: options.scratchDir,
    modelType,
    modelId: execution.modelId,
    globalArgs: execution.globalArgs,
    definition: execution.definitionMeta,
    methodName: execution.methodName,
    logger,
    dataRepository,
    definitionRepository,
    outputRepository,
    vaultService,
    redactor: new SecretRedactor(),
    dataQueryService,
    writeResource: writers.writeResource,
    readResource,
    deleteResource,
    readModelData,
    queryData,
    createFileWriter: writers.createFileWriter,
    onEvent: options.onEvent,
    extensionFile: (relPath: string) => {
      if (extensionFilesDir === undefined) {
        throw new Error(
          "This model has no co-located extension files to resolve",
        );
      }
      return join(extensionFilesDir, ...relPath.split("/"));
    },
    createCelEnvironment: createExtensionCelEnvironment,
  };

  return { context, getHandles: writers.getHandles };
}
