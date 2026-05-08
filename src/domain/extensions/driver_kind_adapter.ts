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
import type { ExecutionDriver } from "../drivers/execution_driver.ts";
import { driverTypeRegistry } from "../drivers/driver_type_registry.ts";
import type { ExtensionTypeRow } from "../../infrastructure/persistence/extension_catalog_store.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import type { KindAdapter, ValidationResult } from "./kind_adapter.ts";

const USER_DRIVER_TYPE_PATTERN = /^@?[a-z0-9_-]+\/[a-z0-9_-]+$/;

const UserDriverSchema = z.object({
  type: z.string().refine(
    (t) => USER_DRIVER_TYPE_PATTERN.test(t),
    {
      message: "Driver type must match @collective/name or collective/name",
    },
  ),
  name: z.string(),
  description: z.string(),
  configSchema: z.custom<z.ZodTypeAny>(isZodSchemaLike).optional(),
  createDriver: z.custom<
    (config: Record<string, unknown>) => ExecutionDriver
  >((val) => typeof val === "function"),
});

export const driverKindAdapter: KindAdapter = {
  kind: "driver",
  bundleSubdir: SWAMP_SUBDIRS.driverBundles,
  catalogKinds: ["driver"],
  primaryExportKey: "driver",
  exportRegex: /export\s+const\s+driver\s*[=:]/,
  useResolver: true,

  validatePrimaryExport(exported: unknown): ValidationResult {
    const result = UserDriverSchema.safeParse(exported);
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
    if (!/export\s+const\s+driver\s*[=:]/.test(source)) return null;
    const typeMatch = source.match(/type\s*:\s*["']([^"']+)["']/);
    if (!typeMatch) return null;
    return {
      typeNormalized: typeMatch[1].toLowerCase(),
      version: "",
      kind: "driver" as const,
      extendsType: "",
    };
  },

  register(
    _typeNormalized: string,
    validated: Record<string, unknown>,
    _module: Record<string, unknown>,
  ): void {
    const v = validated as z.infer<typeof UserDriverSchema>;
    driverTypeRegistry.register({
      type: v.type,
      name: v.name,
      description: v.description,
      configSchema: v.configSchema,
      createDriver: v.createDriver,
      isBuiltIn: false,
    });
  },

  registerLazy(entry: ExtensionTypeRow): void {
    driverTypeRegistry.registerLazy({
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
    const v = validated as z.infer<typeof UserDriverSchema>;
    driverTypeRegistry.promoteFromLazy({
      type: v.type,
      name: v.name,
      description: v.description,
      configSchema: v.configSchema,
      createDriver: v.createDriver,
      isBuiltIn: false,
    });
  },

  hasType(typeNormalized: string): boolean {
    return driverTypeRegistry.has(typeNormalized);
  },

  isFullyLoaded(typeNormalized: string): boolean {
    return driverTypeRegistry.get(typeNormalized) !== undefined;
  },
};
