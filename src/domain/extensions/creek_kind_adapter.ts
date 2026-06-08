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
import { dirname, join, resolve } from "@std/path";
import type {
  CreekDefinition,
  CreekMethodContext,
  CreekMethodDefinition,
} from "../creeks/creek.ts";
import { creekRegistry } from "../creeks/creek_registry.ts";
import { isZodSchemaLike } from "../zod_compat.ts";
import type { ExtensionTypeRow } from "../../infrastructure/persistence/extension_catalog_store.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import type { KindAdapter, ValidationResult } from "./kind_adapter.ts";

/**
 * Walks up from the creek source file looking for `deno.json`/`deno.jsonc`
 * so the bundler can resolve `npm:`/`jsr:` imports and bare specifiers via
 * the user's import map. Stops at the repo root so we never escape the
 * project sandbox. Mirrors `findNearestDenoConfig` in `model_kind_adapter`.
 */
function findNearestDenoConfig(
  absolutePath: string,
  repoDir: string | null,
): string | undefined {
  let dir = dirname(absolutePath);
  const root = resolve("/");
  while (dir !== root) {
    if (repoDir && resolve(dir) === resolve(repoDir)) break;
    for (const name of ["deno.json", "deno.jsonc"]) {
      const candidate = join(dir, name);
      try {
        Deno.statSync(candidate);
        return candidate;
      } catch {
        // Not found — keep walking up
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Scoped-name pattern for creek types: `@collective/name` or `collective/name`. */
const USER_CREEK_TYPE_PATTERN = /^@?[a-z0-9_-]+\/[a-z0-9_-]+$/;

const UserMethodSchema = z.object({
  description: z.string(),
  arguments: z.custom<z.ZodTypeAny>(isZodSchemaLike),
  returns: z.custom<z.ZodTypeAny>(isZodSchemaLike).optional(),
  strictReturns: z.boolean().optional(),
  execute: z.custom<
    (args: unknown, ctx: CreekMethodContext) => Promise<unknown>
  >(
    (val) => typeof val === "function",
  ),
});

const UserCreekSchema = z.object({
  type: z.string().refine(
    (t) => USER_CREEK_TYPE_PATTERN.test(t.toLowerCase()),
    {
      message: "Creek type must match @collective/name or collective/name",
    },
  ),
  version: z.string(),
  description: z.string().optional(),
  methods: z.record(z.string(), UserMethodSchema).refine(
    (methods) => Object.keys(methods).length > 0,
    { message: "Creek must declare at least one method" },
  ),
});

function asCreekDefinition(
  validated: Record<string, unknown>,
): CreekDefinition {
  const v = validated as z.infer<typeof UserCreekSchema>;
  return {
    type: v.type,
    version: v.version,
    description: v.description,
    methods: v.methods as Record<string, CreekMethodDefinition>,
  };
}

export const creekKindAdapter: KindAdapter = {
  kind: "creek",
  bundleSubdir: SWAMP_SUBDIRS.creekBundles,
  catalogKinds: ["creek"],
  primaryExportKey: "creek",
  exportRegex: /export\s+const\s+creek\s*[=:]/,
  useResolver: false,

  validatePrimaryExport(exported: unknown): ValidationResult {
    const result = UserCreekSchema.safeParse(exported);
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
    if (!/export\s+const\s+creek\s*[=:]/.test(source)) return null;
    const typeMatch = source.match(
      /export\s+const\s+creek\s*=\s*[\s\S]*?type\s*:\s*["']([^"']+)["']/,
    );
    if (!typeMatch) return null;
    const versionMatch = source.match(/version\s*:\s*["']([^"']+)["']/);
    return {
      typeNormalized: typeMatch[1].toLowerCase(),
      version: versionMatch ? versionMatch[1] : "",
      kind: "creek" as const,
      extendsType: "",
    };
  },

  register(
    _typeNormalized: string,
    validated: Record<string, unknown>,
    _module: Record<string, unknown>,
  ): void {
    creekRegistry.register(asCreekDefinition(validated));
  },

  registerLazy(entry: ExtensionTypeRow): void {
    creekRegistry.registerLazy({
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
    creekRegistry.promoteFromLazy(asCreekDefinition(validated));
  },

  hasType(typeNormalized: string): boolean {
    return creekRegistry.has(typeNormalized);
  },

  isFullyLoaded(typeNormalized: string): boolean {
    return creekRegistry.get(typeNormalized) !== undefined;
  },

  resolveDenoConfig: findNearestDenoConfig,
};
