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

import type { CatalogRow } from "../../infrastructure/persistence/catalog_store.ts";
import type { DataRecord } from "./data_record.ts";
import type { Data } from "./data.ts";
import { ModelType } from "../models/model_type.ts";
import type { UnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import type { VaultService } from "../vaults/vault_service.ts";
import type { SecretRedactor } from "../secrets/mod.ts";
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
 * Converts a CatalogRow to a DataRecord. This is the primary runtime path
 * since most data access functions delegate to DataQueryService.query().
 *
 * Content is loaded from disk only when needed (controlled by loadAttributes
 * and loadContent flags, driven by AST analysis of the query predicate).
 */
export async function fromRow(
  row: CatalogRow,
  dataRepo: UnifiedDataRepository,
  loadAttributes: boolean,
  loadContent: boolean,
  options: DataRecordMapperOptions = {},
): Promise<DataRecord> {
  const needsBytes = (loadAttributes &&
    row.content_type === "application/json") ||
    (loadContent && isTextContentType(row.content_type));

  let rawBytes: Uint8Array | null = null;
  if (needsBytes) {
    rawBytes = dataRepo.getContentSync(
      ModelType.create(row.type_normalized),
      row.model_id,
      row.data_name,
    );
  }

  const { attributes, textContent } = parseContent(
    rawBytes,
    row.content_type,
    loadAttributes,
    loadContent,
  );

  await resolveVaultRefs(attributes, options);

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
    createdAt: row.created_at,
    attributes,
    tags,
    modelName: row.model_name,
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
 * Used by data.version() and data.listVersions() which remain file-system-based
 * because the catalog only stores the latest version per item.
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
