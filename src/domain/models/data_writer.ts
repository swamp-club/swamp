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

import type { z } from "zod";
import type { ModelData } from "./model_data.ts";
import type { ModelResource } from "./model_resource.ts";
import type { ModelType } from "./model_type.ts";
import type { VaultService } from "../vaults/vault_service.ts";
import {
  extractSensitiveFields,
  getNestedValue,
  type SensitiveFieldInfo,
  setNestedValue,
} from "./sensitive_field_extractor.ts";

/**
 * Common options for sensitive field processing.
 */
interface SensitiveFieldsBaseOptions {
  /** The Zod schema for the attributes (used to find sensitive fields) */
  schema: z.ZodTypeAny;
  /** The vault service for storing sensitive values */
  vaultService: VaultService;
  /** The model type (used for vault key generation) */
  modelType: ModelType;
  /** The model input ID (used for vault key generation) */
  modelId: string;
  /** The method name (used for vault key generation) */
  methodName: string;
  /** When true, all top-level fields are treated as sensitive */
  sensitiveOutput?: boolean;
  /** Method-level vault name override */
  methodVaultName?: string;
  /** Default vault name from context */
  defaultVaultName?: string;
}

/**
 * Options for processing sensitive fields in model data.
 */
export interface ProcessSensitiveFieldsOptions
  extends SensitiveFieldsBaseOptions {
  /** The model data to process */
  data: ModelData;
}

/**
 * Options for processing sensitive fields in model resources.
 */
export interface ProcessSensitiveResourceFieldsOptions
  extends SensitiveFieldsBaseOptions {
  /** The model resource to process */
  resource: ModelResource;
}

/**
 * Resolves the list of sensitive fields to process, including sensitiveOutput expansion.
 * Snapshots values from the original attributes before any mutation.
 *
 * Returns fields paired with their original values.
 */
function resolveSensitiveFields(
  schema: z.ZodTypeAny,
  attributes: Record<string, unknown>,
  sensitiveOutput?: boolean,
): { field: SensitiveFieldInfo; originalValue: unknown }[] {
  const sensitiveFields = extractSensitiveFields(schema);

  if (sensitiveOutput) {
    const existingPaths = new Set(sensitiveFields.map((f) => f.path));
    for (const key of Object.keys(attributes)) {
      if (!existingPaths.has(key)) {
        sensitiveFields.push({ path: key });
      }
    }
  }

  // Snapshot original values and filter out undefined/null.
  // Deep clone so we capture values before any mutation.
  const snapshot = structuredClone(attributes);
  const result: { field: SensitiveFieldInfo; originalValue: unknown }[] = [];
  for (const field of sensitiveFields) {
    const value = getNestedValue(snapshot, field.path);
    if (value !== undefined && value !== null) {
      result.push({ field, originalValue: value });
    }
  }

  return result;
}

/**
 * Validates vault availability and throws a clear error if no vaults are configured.
 */
function validateVaultAvailability(
  vaultService: VaultService,
  sensitiveFields: SensitiveFieldInfo[],
): string[] {
  const vaultNames = vaultService.getVaultNames();
  if (vaultNames.length === 0) {
    const fieldList = sensitiveFields.map((f) => `'${f.path}'`).join(", ");
    throw new Error(
      `Cannot persist data: fields ${fieldList} are marked as sensitive ` +
        `but no vault is configured. Create a vault using: swamp vault create <type> <name>`,
    );
  }
  return vaultNames;
}

/**
 * Stores a value in the vault and returns the vault reference expression.
 */
async function storeAndCreateRef(
  vaultService: VaultService,
  targetVault: string,
  vaultKey: string,
  value: unknown,
): Promise<string> {
  const stringValue = typeof value === "string" ? value : JSON.stringify(value);
  await vaultService.put(targetVault, vaultKey, stringValue);
  return `\${{ vault.get('${targetVault}', '${vaultKey}') }}`;
}

/**
 * Applies a vault reference to an attribute set via ModelData.setAttribute or ModelResource.setAttribute.
 */
function applyVaultRef(
  setAttribute: (key: string, value: unknown) => void,
  getAttributes: () => Record<string, unknown>,
  fieldPath: string,
  vaultRef: string,
): void {
  if (fieldPath.includes(".")) {
    const attrs = getAttributes();
    setNestedValue(attrs, fieldPath, vaultRef);
    const topLevelKey = fieldPath.split(".")[0];
    setAttribute(topLevelKey, attrs[topLevelKey]);
  } else {
    setAttribute(fieldPath, vaultRef);
  }
}

/**
 * Processes sensitive fields in model data before persistence.
 *
 * For each field marked with `{ sensitive: true }` metadata in the schema
 * (or all fields when `sensitiveOutput` is true):
 * 1. Stores the actual value in the vault
 * 2. Replaces the value with a vault reference expression
 *
 * Values are snapshotted before processing, so mutation of one field
 * does not affect the value stored for another.
 *
 * @param options - Processing options
 * @returns The processed ModelData with sensitive values replaced by vault references
 * @throws Error if sensitive fields are found but no vault is available
 */
export async function processSensitiveFields(
  options: ProcessSensitiveFieldsOptions,
): Promise<ModelData> {
  const {
    data,
    schema,
    vaultService,
    modelType,
    modelId,
    methodName,
    sensitiveOutput,
    methodVaultName,
    defaultVaultName,
  } = options;

  const fieldsWithValues = resolveSensitiveFields(
    schema,
    data.attributes,
    sensitiveOutput,
  );

  if (fieldsWithValues.length === 0) {
    return data;
  }

  const vaultNames = validateVaultAvailability(
    vaultService,
    fieldsWithValues.map((f) => f.field),
  );

  for (const { field, originalValue } of fieldsWithValues) {
    const targetVault = field.vaultName ?? methodVaultName ??
      defaultVaultName ?? vaultNames[0];
    const vaultKey = field.vaultKey ??
      `${modelType.normalized}/${modelId}/${methodName}/${field.path}`;

    const vaultRef = await storeAndCreateRef(
      vaultService,
      targetVault,
      vaultKey,
      originalValue,
    );

    applyVaultRef(
      (key, value) => data.setAttribute(key, value),
      () => data.attributes,
      field.path,
      vaultRef,
    );
  }

  return data;
}

/**
 * Processes sensitive fields in model resource before persistence.
 *
 * Same behavior as processSensitiveFields but operates on ModelResource.
 *
 * @param options - Processing options
 * @returns The processed ModelResource with sensitive values replaced by vault references
 * @throws Error if sensitive fields are found but no vault is available
 */
export async function processSensitiveResourceFields(
  options: ProcessSensitiveResourceFieldsOptions,
): Promise<ModelResource> {
  const {
    resource,
    schema,
    vaultService,
    modelType,
    modelId,
    methodName,
    sensitiveOutput,
    methodVaultName,
    defaultVaultName,
  } = options;

  const fieldsWithValues = resolveSensitiveFields(
    schema,
    resource.attributes,
    sensitiveOutput,
  );

  if (fieldsWithValues.length === 0) {
    return resource;
  }

  const vaultNames = validateVaultAvailability(
    vaultService,
    fieldsWithValues.map((f) => f.field),
  );

  for (const { field, originalValue } of fieldsWithValues) {
    const targetVault = field.vaultName ?? methodVaultName ??
      defaultVaultName ?? vaultNames[0];
    const vaultKey = field.vaultKey ??
      `${modelType.normalized}/${modelId}/${methodName}/${field.path}`;

    const vaultRef = await storeAndCreateRef(
      vaultService,
      targetVault,
      vaultKey,
      originalValue,
    );

    applyVaultRef(
      (key, value) => resource.setAttribute(key, value),
      () => resource.attributes,
      field.path,
      vaultRef,
    );
  }

  return resource;
}
