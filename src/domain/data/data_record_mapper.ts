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

import type { CatalogRow } from "../../infrastructure/persistence/catalog_store.ts";
import type { DataRecord, FileDataRecord } from "./data_record.ts";
import type { Data } from "./data.ts";
import { ModelType } from "../models/model_type.ts";
import type { UnifiedDataRepository } from "./repositories.ts";
import type { VaultService } from "../vaults/vault_service.ts";
import type { SecretRedactor } from "../secrets/mod.ts";
import type { DataHandle } from "../models/model.ts";
import { isTextContentType } from "./content_type.ts";
import { resolveVaultRefsInData } from "../models/data_writer.ts";

export interface DataRecordMapperOptions {
  vaultService?: VaultService;
  redactor?: SecretRedactor;
}

/**
 * Loads content bytes and parses attributes/text from a data artifact.
 * Shared by both fromRow and fromData paths.
 */
function parseContent(
  rawBytes: Uint8Array | null,
  contentType: string,
  loadAttributes: boolean,
  loadContent: boolean,
): { attributes: Record<string, unknown>; textContent: string } {
  let attributes: Record<string, unknown> = {};
  let textContent = "";

  if (!rawBytes) return { attributes, textContent };

  const decoded = new TextDecoder().decode(rawBytes);

  if (loadContent && isTextContentType(contentType)) {
    textContent = decoded;
  }
  if (loadAttributes && contentType === "application/json") {
    try {
      attributes = JSON.parse(decoded) as Record<string, unknown>;
    } catch {
      // Not valid JSON, use empty attributes
    }
  }

  return { attributes, textContent };
}

/**
 * Attempts vault resolution on attributes. If resolution fails for any
 * individual reference, that reference is left unresolved — the record
 * is never failed entirely.
 */
async function resolveVaultRefs(
  attributes: Record<string, unknown>,
  options: DataRecordMapperOptions,
): Promise<void> {
  if (
    !options.vaultService || Object.keys(attributes).length === 0
  ) {
    return;
  }
  try {
    await resolveVaultRefsInData(
      attributes,
      options.vaultService,
      options.redactor,
    );
  } catch {
    // Vault unavailable or specific keys failed — leave unresolved
  }
}

/**
 * Converts a CatalogRow to a DataRecord synchronously. This is the primary
 * runtime path since most data access functions delegate to
 * DataQueryService.query().
 *
 * Content is loaded from disk only when needed (controlled by loadAttributes
 * and loadContent flags, driven by AST analysis of the query predicate).
 *
 * Vault resolution is NOT performed here — callers that need it (e.g.
 * DataQueryService.query) handle it after the query loop.
 */
export function fromRow(
  row: CatalogRow,
  dataRepo: UnifiedDataRepository,
  loadAttributes: boolean,
  loadContent: boolean,
): DataRecord {
  const needsBytes = (loadAttributes &&
    row.content_type === "application/json") ||
    (loadContent && isTextContentType(row.content_type));

  let rawBytes: Uint8Array | null = null;
  if (needsBytes) {
    rawBytes = dataRepo.getContentSync(
      ModelType.create(row.type_normalized),
      row.model_id,
      row.data_name,
      row.version,
    );
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
    ownerType: row.owner_type,
    streaming: row.streaming === 1,
    size: row.size,
    content: textContent,
    ownerRef: row.owner_ref,
    workflowRunId: row.workflow_run_id,
    workflowName: row.workflow_name,
    jobName: row.job_name,
    stepName: row.step_name,
    source: row.source,
  };
}

/**
 * Converts a Data entity to a DataRecord asynchronously.
 * Used by helpers that hold a Data entity loaded outside the catalog path.
 *
 * Callers that know whether the version is currently the latest for its
 * (type, model, name) triple should pass `isLatest`. When omitted, the
 * record reports `isLatest: false`.
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

  await resolveVaultRefs(attributes, options);

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
 * Converts a DataHandle to a DataRecord for use in the workflow
 * step's expressionContext.model[...].resource[...] view.
 *
 * Used in the success path of step execution where the handle has
 * just been produced by the method's DataWriter. Differs from
 * {@link fromData}:
 * - `isLatest` is always true (the handle was just produced).
 * - `attributes` is parsed from JSON content for `application/json`
 *   only — other content types yield empty attributes. Downstream
 *   CEL access patterns reference `attributes.<field>`; raw text
 *   content is intentionally not eagerly loaded into the record.
 * - `content` is always "" (parsing into attributes is sufficient
 *   for downstream CEL).
 * - `dataType` defaults to "resource" rather than "" because the
 *   caller already knows the handle is a resource.
 *
 * Returns the constructed DataRecord. Never null — handles always
 * carry their own metadata.
 */
export async function fromResourceHandle(
  handle: DataHandle,
  modelType: ModelType,
  modelId: string,
  fallbackModelName: string,
  dataRepo: UnifiedDataRepository,
): Promise<DataRecord> {
  let attributes: Record<string, unknown> = {};
  if (handle.metadata.contentType === "application/json") {
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
    ownerType: handle.metadata.ownerDefinition.ownerType,
    streaming: handle.metadata.streaming,
    size: handle.size,
    content: "",
    ownerRef: handle.metadata.ownerDefinition.ownerRef,
    workflowRunId: handle.metadata.ownerDefinition.workflowRunId ?? "",
    workflowName: handle.metadata.ownerDefinition.workflowName ?? "",
    jobName: handle.metadata.ownerDefinition.jobName ?? "",
    stepName: handle.metadata.ownerDefinition.stepName ?? "",
    source: handle.metadata.ownerDefinition.source ?? "",
  };
}

/**
 * Converts a file-kind DataHandle to a FileDataRecord for use in
 * the workflow step's expressionContext.model[...].file[...] view.
 *
 * Stats the on-disk content path to capture its size at record-build
 * time. Returns null if the file is no longer present (rare — the
 * DataWriter persisted it just before the handle was produced — but
 * the I/O can race with concurrent cleanup).
 */
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
