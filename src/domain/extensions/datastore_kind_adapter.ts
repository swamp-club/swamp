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

import { z } from "zod";
import { isZodSchemaLike } from "../zod_compat.ts";
import type { DatastoreProvider } from "../datastore/datastore_provider.ts";
import { datastoreTypeRegistry } from "../datastore/datastore_type_registry.ts";
import type { ExtensionTypeRow } from "../../infrastructure/persistence/extension_catalog_store.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import type { KindAdapter, ValidationResult } from "./kind_adapter.ts";

const USER_DATASTORE_TYPE_PATTERN = /^@?[a-z0-9_-]+\/[a-z0-9_-]+$/;

const UserDatastoreSchema = z.object({
  type: z.string().refine(
    (t) => USER_DATASTORE_TYPE_PATTERN.test(t),
    {
      message: "Datastore type must match @collective/name or collective/name",
    },
  ),
  name: z.string(),
  description: z.string(),
  configSchema: z.custom<z.ZodTypeAny>(isZodSchemaLike).optional(),
  createProvider: z.custom<
    (config: Record<string, unknown>) => DatastoreProvider
  >((val) => typeof val === "function"),
});

export const datastoreKindAdapter: KindAdapter = {
  kind: "datastore",
  bundleSubdir: SWAMP_SUBDIRS.datastoreBundles,
  catalogKinds: ["datastore"],
  primaryExportKey: "datastore",
  exportRegex: /export\s+const\s+datastore\s*[=:]/,
  useResolver: false,

  validatePrimaryExport(exported: unknown): ValidationResult {
    const result = UserDatastoreSchema.safeParse(exported);
    if (result.success) {
      return { success: true, data: result.data as Record<string, unknown> };
    }
    return { success: false, error: result.error };
  },

  formatValidationError(error: z.ZodError): string {
    return error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
  },

  normalizeType(validated: Record<string, unknown>): string {
    return String(validated.type).toLowerCase();
  },

  extractTypeFromSource(source: string) {
    if (!/export\s+const\s+datastore\s*[=:]/.test(source)) return null;
    const typeMatch = source.match(
      /export\s+const\s+datastore\s*=\s*\{[\s\S]*?type\s*:\s*["']([^"']+)["']/,
    );
    if (!typeMatch) return null;
    return {
      typeNormalized: typeMatch[1].toLowerCase(),
      version: "",
      kind: "datastore" as const,
      extendsType: "",
    };
  },

  register(
    _typeNormalized: string,
    validated: Record<string, unknown>,
    _module: Record<string, unknown>,
  ): void {
    const v = validated as z.infer<typeof UserDatastoreSchema>;
    datastoreTypeRegistry.register({
      type: v.type,
      name: v.name,
      description: v.description,
      configSchema: v.configSchema,
      createProvider: v.createProvider,
      isBuiltIn: false,
    });
  },

  registerLazy(entry: ExtensionTypeRow): void {
    datastoreTypeRegistry.registerLazy({
      type: entry.type_normalized,
      bundlePath: entry.bundle_path,
      sourcePath: entry.source_path,
      version: entry.version,
    });
  },

  promoteFromLazy(
    _typeNormalized: string,
    validated: Record<string, unknown>,
    _module: Record<string, unknown>,
  ): void {
    const v = validated as z.infer<typeof UserDatastoreSchema>;
    datastoreTypeRegistry.promoteFromLazy({
      type: v.type,
      name: v.name,
      description: v.description,
      configSchema: v.configSchema,
      createProvider: v.createProvider,
      isBuiltIn: false,
    });
  },

  hasType(typeNormalized: string): boolean {
    return datastoreTypeRegistry.has(typeNormalized);
  },

  isFullyLoaded(typeNormalized: string): boolean {
    return datastoreTypeRegistry.get(typeNormalized) !== undefined;
  },
};
