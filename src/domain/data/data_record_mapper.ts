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

import { isAbsolute } from "@std/path";
import type { CatalogRow } from "../../infrastructure/persistence/catalog_store.ts";
import type { DataRecord, FileDataRecord } from "./data_record.ts";
import type { Data } from "./data.ts";
import { ModelType } from "../models/model_type.ts";
import {
  isForeignNamespace,
  type UnifiedDataRepository,
} from "./repositories.ts";
import type { VaultService } from "../vaults/vault_service.ts";
import type { SecretRedactor } from "../secrets/mod.ts";
import type { DataHandle } from "../models/model.ts";
import { isJsonMediaType, isTextContentType } from "./content_type.ts";
import {
  garbageCollectionFromColumn,
  lifecycleFromColumn,
} from "./data_metadata.ts";
import {
  parseSensitiveFieldsTag,
  resolveSensitiveVaultRefsLeavingUnread,
} from "../models/data_writer.ts";

export interface DataRecordMapperOptions {
  vaultService?: VaultService;
  redactor?: SecretRedactor;
}

/**
 * empty when none is on this host: another namespace's record (fetched on
 * demand), a name the repository refuses, or non-disk content (ephemeral://
 * URI). Never touches the filesystem
 */
export function localContentPath(
  dataRepo: UnifiedDataRepository,
  modelType: ModelType,
  modelId: string,
  dataName: string,
  version: number,
  namespace: string,
): string {
  if (namespace !== dataRepo.namespace) return "";
  try {
    const path = dataRepo.getContentPath(modelType, modelId, dataName, version);
    return isAbsolute(path) ? path : "";
  } catch {
    return "";
  }
}

function parseContent(
  rawBytes: Uint8Array | null,
  contentType: string,
  loadAttributes: boolean,
  loadContent: boolean,
): { attributes: Record<string, unknown>; textContent: unknown } {
  let attributes: Record<string, unknown> = {};
  let textContent: unknown = "";

  if (!rawBytes) return { attributes, textContent };

  const decoded = new TextDecoder().decode(rawBytes);

  if (loadContent && isTextContentType(contentType)) {
    textContent = decoded;
  }
  if (loadAttributes && isJsonMediaType(contentType)) {
    try {
      attributes = JSON.parse(decoded) as Record<string, unknown>;
      textContent = attributes;
    } catch {
      // Not valid JSON, use empty attributes
    }
  }

  return { attributes, textContent };
}

/**
 * a reference that fails to resolve is left unresolved, logged and recorded,
 * never failing the record, except VaultAccessDeniedError which is rethrown
 */
async function resolveVaultRefs(
  attributes: Record<string, unknown>,
  tags: Record<string, string>,
  options: DataRecordMapperOptions,
): Promise<void> {
  if (
    !options.vaultService || Object.keys(attributes).length === 0
  ) {
    return;
  }
  const sensitiveFields = parseSensitiveFieldsTag(tags);
  if (!sensitiveFields) return;
  await resolveSensitiveVaultRefsLeavingUnread(
    attributes,
    sensitiveFields,
    options.vaultService,
    options.redactor,
  );
}

/** a repository without isContentAcceptedSync (a test double) accepts it */
function isAcceptedShortContent(
  dataRepo: UnifiedDataRepository,
  row: CatalogRow,
): boolean {
  if (typeof dataRepo.isContentAcceptedSync !== "function") return true;
  return dataRepo.isContentAcceptedSync(
    ModelType.create(row.type_normalized),
    row.model_id,
    row.data_name,
    row.version,
    row.size,
  );
}

/**
 * callers whose results cross a trust boundary leave path off so host paths
 * never leave the process; another namespace's row is never read from the own
 * layout, which may hold the repository's item at that path
 */
export function fromRow(
  row: CatalogRow,
  dataRepo: UnifiedDataRepository,
  loadAttributes: boolean,
  loadContent: boolean,
  includeContentPath = false,
  onMissingContent?: () => void,
): DataRecord {
  const needsBytes = !isForeignNamespace(row.namespace, dataRepo) &&
    ((loadAttributes && isJsonMediaType(row.content_type)) ||
      (loadContent && isTextContentType(row.content_type)));

  let rawBytes: Uint8Array | null = null;
  if (needsBytes) {
    rawBytes = dataRepo.getContentSync(
      ModelType.create(row.type_normalized),
      row.model_id,
      row.data_name,
      row.version,
    );
    if (rawBytes === null) {
      onMissingContent?.();
    } else if (
      rawBytes.length < row.size &&
      !isAcceptedShortContent(dataRepo, row)
    ) {
      rawBytes = null;
      onMissingContent?.();
    }
  }

  const { attributes, textContent } = parseContent(
    rawBytes,
    row.content_type,
    loadAttributes,
    loadContent,
  );

  let tags: Record<string, string> = {};
  try {
    tags = JSON.parse(row.tags) as Record<string, string>;
  } catch {
    // Invalid tags JSON, use empty
  }

  return {
    id: row.id,
    name: row.data_name,
    version: row.version,
    isLatest: row.is_latest === 1,
    createdAt: row.created_at,
    namespace: row.namespace,
    attributes,
    tags,
    modelName: row.model_name,
    modelId: row.model_id,
    modelType: row.type_normalized,
    specName: row.spec_name,
    dataType: row.data_type,
    contentType: row.content_type,
    lifetime: row.lifetime,
    garbageCollection: garbageCollectionFromColumn(row.garbage_collection),
    lifecycle: lifecycleFromColumn(row.lifecycle),
    ownerType: row.owner_type,
    streaming: row.streaming === 1,
    size: row.size,
    content: textContent,
    path: includeContentPath
      ? localContentPath(
        dataRepo,
        ModelType.create(row.type_normalized),
        row.model_id,
        row.data_name,
        row.version,
        row.namespace,
      )
      : "",
    ownerRef: row.owner_ref,
    workflowRunId: row.workflow_run_id,
    workflowName: row.workflow_name,
    jobName: row.job_name,
    stepName: row.step_name,
    source: row.source,
  };
}

/**
 * callers that know the version is the latest pass isLatest; when omitted the
 * record reports isLatest: false
 */
export async function fromData(
  data: Data,
  modelType: ModelType,
  modelId: string,
  dataRepo: UnifiedDataRepository,
  options: DataRecordMapperOptions & {
    version?: number;
    modelName?: string;
    dataName?: string;
    isLatest?: boolean;
  } = {},
): Promise<DataRecord | null> {
  const resolvedVersion = options.version ?? data.version;
  const resolvedName = options.dataName ?? data.name;

  let rawBytes: Uint8Array | null = null;
  if (isTextContentType(data.contentType)) {
    rawBytes = await dataRepo.getContent(
      modelType,
      modelId,
      resolvedName,
      resolvedVersion,
    );
  }

  const { attributes, textContent } = parseContent(
    rawBytes,
    data.contentType,
    true,
    true,
  );

  await resolveVaultRefs(attributes, data.tags, options);

  const resolvedModelName = options.modelName ?? data.tags["modelName"] ?? "";

  return {
    id: data.id,
    name: data.name,
    version: resolvedVersion,
    isLatest: options.isLatest ?? false,
    createdAt: data.createdAt.toISOString(),
    namespace: dataRepo.namespace,
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
    path: "",
    ownerRef: data.ownerDefinition.ownerRef,
    workflowRunId: data.ownerDefinition.workflowRunId ?? "",
    workflowName: data.ownerDefinition.workflowName ?? "",
    jobName: data.ownerDefinition.jobName ?? "",
    stepName: data.ownerDefinition.stepName ?? "",
    source: data.ownerDefinition.source ?? "",
  };
}

/**
 * attributes parse only for application/json since downstream CEL reads
 * attributes.<field>; raw text content is intentionally not eagerly loaded
 */
export async function fromResourceHandle(
  handle: DataHandle,
  modelType: ModelType,
  modelId: string,
  fallbackModelName: string,
  dataRepo: UnifiedDataRepository,
): Promise<DataRecord> {
  let attributes: Record<string, unknown> = {};
  if (isJsonMediaType(handle.metadata.contentType)) {
    try {
      const content = await dataRepo.getContent(
        modelType,
        modelId,
        handle.name,
        handle.version,
      );
      if (content) {
        const text = new TextDecoder().decode(content);
        attributes = JSON.parse(text) as Record<string, unknown>;
      }
    } catch {
      // Not valid JSON, skip attributes
    }
  }

  return {
    id: handle.dataId,
    name: handle.name,
    version: handle.version,
    isLatest: true,
    createdAt: new Date().toISOString(),
    namespace: dataRepo.namespace,
    attributes,
    tags: handle.tags,
    modelName: handle.tags["modelName"] ?? fallbackModelName,
    modelId: modelId,
    modelType: modelType.normalized,
    specName: handle.specName,
    dataType: handle.tags["type"] ?? "resource",
    contentType: handle.metadata.contentType,
    lifetime: handle.metadata.lifetime,
    garbageCollection: handle.metadata.garbageCollection,
    lifecycle: handle.metadata.lifecycle ?? "active",
    ownerType: handle.metadata.ownerDefinition.ownerType,
    streaming: handle.metadata.streaming,
    size: handle.size,
    content: isJsonMediaType(handle.metadata.contentType) ? attributes : "",
    path: "",
    ownerRef: handle.metadata.ownerDefinition.ownerRef,
    workflowRunId: handle.metadata.ownerDefinition.workflowRunId ?? "",
    workflowName: handle.metadata.ownerDefinition.workflowName ?? "",
    jobName: handle.metadata.ownerDefinition.jobName ?? "",
    stepName: handle.metadata.ownerDefinition.stepName ?? "",
    source: handle.metadata.ownerDefinition.source ?? "",
  };
}

/** returns null if the file is gone; the I/O can race with concurrent cleanup */
export async function fromFileHandle(
  handle: DataHandle,
  modelType: ModelType,
  modelId: string,
  dataRepo: UnifiedDataRepository,
): Promise<FileDataRecord | null> {
  const contentPath = dataRepo.getContentPath(
    modelType,
    modelId,
    handle.name,
    handle.version,
  );
  try {
    const stat = await Deno.stat(contentPath);
    return {
      id: handle.dataId,
      version: handle.version,
      createdAt: new Date().toISOString(),
      path: contentPath,
      size: stat.size,
      contentType: handle.metadata.contentType,
    };
  } catch {
    return null;
  }
}
