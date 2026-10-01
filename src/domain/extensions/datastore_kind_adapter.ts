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

import { z } from "zod";
import { isZodSchemaLike } from "../zod_compat.ts";
import type { DatastoreProvider } from "../datastore/datastore_provider.ts";
import { withCoreLockErrors } from "../datastore/distributed_lock.ts";
import { datastoreTypeRegistry } from "../datastore/datastore_type_registry.ts";
import type { ExtensionTypeRow } from "../../infrastructure/persistence/extension_catalog_store.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import {
  EXPORT_DECLARATION_PATTERNS,
  sourceFromExportDeclaration,
} from "./export_declaration.ts";
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

/**
 * Wraps an extension's `createProvider` so every lock its providers create
 * rejects with the core `LockTimeoutError` on timeout. This is the one place
 * extension datastores enter core, so every lock call site — per-model,
 * global and push locks in the CLI and serve — gets core semantics (exit
 * code 75, `lock_timeout`) without knowing the backend (swamp-club#2553).
 *
 * The provider is proxied rather than copied: extension providers may be
 * class instances, and a spread would drop their prototype methods. The
 * proxy target is an empty object inheriting from the provider, not the
 * provider itself. Proxy invariants forbid returning a different value for a
 * frozen own property, so proxying a frozen provider directly would throw.
 */
function wrapExtensionProvider(
  createProvider: (config: Record<string, unknown>) => DatastoreProvider,
): (config: Record<string, unknown>) => DatastoreProvider {
  return (config) => {
    const provider = createProvider(config);
    return new Proxy(Object.create(provider) as DatastoreProvider, {
      get(_target, prop) {
        if (prop === "createLock") {
          return (...args: Parameters<DatastoreProvider["createLock"]>) =>
            withCoreLockErrors(provider.createLock(...args));
        }
        const value = Reflect.get(provider, prop, provider);
        return typeof value === "function" ? value.bind(provider) : value;
      },
    });
  };
}

export const datastoreKindAdapter: KindAdapter = {
  kind: "datastore",
  bundleSubdir: SWAMP_SUBDIRS.datastoreBundles,
  catalogKinds: ["datastore"],
  primaryExportKey: "datastore",
  exportRegex: EXPORT_DECLARATION_PATTERNS.datastore,
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
    const declaration = sourceFromExportDeclaration(
      source,
      EXPORT_DECLARATION_PATTERNS.datastore,
    );
    if (declaration === null) return null;
    const typeMatch = declaration.match(
      /export\s+const\s+datastore\b[\s\S]*?=\s*\{[\s\S]*?type\s*:\s*["']([^"']+)["']/,
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
      createProvider: wrapExtensionProvider(v.createProvider),
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
      createProvider: wrapExtensionProvider(v.createProvider),
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
