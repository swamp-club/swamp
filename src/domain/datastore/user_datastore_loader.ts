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
import { dirname, join, resolve, toFileUrl } from "@std/path";
import { getLogger } from "@logtape/logtape";
import {
  bundleExtension,
  fixCjsEsmInterop,
  installZodGlobal,
  rewriteZodImports,
  sanitizeDataUrlError,
  sourceHasBareSpecifiers,
  uint8ArrayToBase64,
} from "../models/bundle.ts";
import { resolveLocalImports } from "../models/local_import_resolver.ts";
import type { DenoRuntime } from "../runtime/deno_runtime.ts";
import type { DatastoreProvider } from "./datastore_provider.ts";
import { datastoreTypeRegistry } from "./datastore_type_registry.ts";
import {
  SWAMP_DATA_DIR,
  SWAMP_SUBDIRS,
} from "../../infrastructure/persistence/paths.ts";
import { assertSafePath } from "../../infrastructure/persistence/safe_path.ts";

const logger = getLogger(["swamp", "datastores", "loader"]);

/** Pattern for valid user datastore type: @collective/name or collective/name */
const USER_DATASTORE_TYPE_PATTERN = /^@?[a-z0-9_-]+\/[a-z0-9_-]+$/;

/**
 * Schema for validating user datastore exports.
 */
const UserDatastoreSchema = z.object({
  type: z.string().refine(
    (t) => USER_DATASTORE_TYPE_PATTERN.test(t),
    {
      message:
        "Datastore type must match @collective/name or collective/name (e.g., @myorg/custom-store or myorg/custom-store)",
    },
  ),
  name: z.string(),
  description: z.string(),
  configSchema: z.custom<z.ZodTypeAny>((val) => val instanceof z.ZodType)
    .optional(),
  createProvider: z.custom<
    (config: Record<string, unknown>) => DatastoreProvider
  >((val) => typeof val === "function"),
});

/**
 * Result of loading user datastore extensions from a directory.
 */
export interface DatastoreLoadResult {
  loaded: string[];
  failed: Array<{ file: string; error: string }>;
}

/**
 * Loader for user-defined TypeScript datastore implementations.
 *
 * Users export a `datastore` object from TypeScript files that defines:
 * - type: namespaced identifier (e.g., "@myorg/custom-store")
 * - name: human-readable name
 * - description: datastore type description
 * - configSchema: optional Zod schema for config validation
 * - createProvider: factory function returning a DatastoreProvider
 *
 * This loader validates the structure and registers datastore types with the global registry.
 */
export class UserDatastoreLoader {
  private readonly denoRuntime: DenoRuntime;
  private readonly repoDir: string | null;

  /**
   * @param denoRuntime - Runtime manager for obtaining a deno binary path
   * @param repoDir - Repository root for writing bundles to .swamp/datastore-bundles/
   *                   (pass null to skip bundle caching)
   */
  constructor(denoRuntime: DenoRuntime, repoDir: string | null = null) {
    this.denoRuntime = denoRuntime;
    this.repoDir = repoDir;
  }

  /**
   * Loads all user datastore implementations from the specified directory.
   *
   * @param datastoresDir - The directory containing user datastore files
   * @returns Result containing lists of loaded and failed files
   */
  async loadDatastores(datastoresDir: string): Promise<DatastoreLoadResult> {
    const result: DatastoreLoadResult = { loaded: [], failed: [] };

    // Ensure swamp's Zod is available on globalThis before importing bundles.
    installZodGlobal();

    // Check if directory exists
    try {
      await Deno.stat(datastoresDir);
    } catch {
      return result; // No user datastores directory - not an error
    }

    // Ensure deno is available before bundling
    const denoPath = await this.denoRuntime.ensureDeno();

    const files = await this.discoverFiles(datastoresDir);

    for (const file of files) {
      try {
        const absolutePath = resolve(datastoresDir, file);
        const js = await this.bundleWithCache(
          absolutePath,
          file,
          denoPath,
          datastoresDir,
        );
        const module = await this.importBundle(js, file);

        if (!module.datastore) {
          // Files without a datastore export are silently skipped (utility files)
          continue;
        }

        const parsed = UserDatastoreSchema.safeParse(module.datastore);
        if (!parsed.success) {
          result.failed.push({
            file,
            error: this.formatValidationError(parsed.error),
          });
          continue;
        }

        const userDatastore = parsed.data;

        // Register with the datastore type registry
        if (datastoreTypeRegistry.has(userDatastore.type)) {
          result.failed.push({
            file,
            error:
              `Datastore type '${userDatastore.type}' is already registered`,
          });
          continue;
        }

        datastoreTypeRegistry.register({
          type: userDatastore.type,
          name: userDatastore.name,
          description: userDatastore.description,
          configSchema: userDatastore.configSchema,
          createProvider: userDatastore.createProvider,
          isBuiltIn: false,
        });

        result.loaded.push(file);
      } catch (error) {
        result.failed.push({ file, error: String(error) });
      }
    }

    return result;
  }

  /**
   * Bundles a datastore file, using cached bundle from .swamp/datastore-bundles/ when possible.
   */
  private async bundleWithCache(
    absolutePath: string,
    relativePath: string,
    denoPath: string,
    boundaryDir: string,
  ): Promise<string> {
    if (this.repoDir) {
      const bundlePath = join(
        this.repoDir,
        SWAMP_DATA_DIR,
        SWAMP_SUBDIRS.datastoreBundles,
        relativePath.replace(/\.ts$/, ".js"),
      );

      // Check mtime-based cache against all local dependencies.
      // If the bundle exists but freshness cannot be determined (e.g. a
      // dependency file is missing because the extension was pushed with an
      // older swamp that had a single-line import regex), fall back to the
      // cached bundle rather than attempting a re-bundle that will also fail.
      let bundleExists = false;
      try {
        const bundleStat = await Deno.stat(bundlePath);
        bundleExists = true;
        if (bundleStat.mtime) {
          const { resolvedFiles } = await resolveLocalImports(
            [absolutePath],
            boundaryDir,
          );
          const depStats = await Promise.all(
            resolvedFiles.map((f) => Deno.stat(f)),
          );
          const newestSourceMtime = depStats.reduce<Date | null>(
            (max, s) => {
              if (!s.mtime) return max;
              if (!max) return s.mtime;
              return s.mtime > max ? s.mtime : max;
            },
            null,
          );
          if (newestSourceMtime && bundleStat.mtime > newestSourceMtime) {
            logger.debug`Using cached datastore bundle for ${relativePath}`;
            return await Deno.readTextFile(bundlePath);
          }
        }
      } catch {
        if (bundleExists) {
          logger
            .debug`Using cached datastore bundle for ${relativePath} (freshness check failed — missing dependency)`;
          return await Deno.readTextFile(bundlePath);
        }
      }

      // If the source uses bare specifiers (e.g., from "zod" instead of
      // from "npm:zod@4") and a cached bundle exists, use it — re-bundling
      // would fail without a deno.json import map to resolve the specifiers.
      if (bundleExists) {
        const source = await Deno.readTextFile(absolutePath);
        if (sourceHasBareSpecifiers(source)) {
          logger
            .debug`Using cached datastore bundle for ${relativePath} (source has bare specifiers)`;
          return await Deno.readTextFile(bundlePath);
        }
      }

      // Bundle and write to cache
      const js = await bundleExtension(absolutePath, denoPath);
      const bundleBoundary = join(this.repoDir, SWAMP_DATA_DIR);
      await assertSafePath(bundlePath, bundleBoundary);
      await Deno.mkdir(dirname(bundlePath), { recursive: true });
      await Deno.writeTextFile(bundlePath, js);
      logger.debug`Wrote datastore bundle cache: ${bundlePath}`;
      return js;
    }

    // No repo dir — just bundle without caching
    return await bundleExtension(absolutePath, denoPath);
  }

  /**
   * Imports bundled JavaScript and returns the module exports.
   * Uses file URL import when a bundle file exists on disk, otherwise falls back to data URL.
   */
  private async importBundle(
    js: string,
    relativePath: string,
  ): Promise<Record<string, unknown>> {
    const rewritten = fixCjsEsmInterop(rewriteZodImports(js));

    if (this.repoDir) {
      const bundlePath = join(
        this.repoDir,
        SWAMP_DATA_DIR,
        SWAMP_SUBDIRS.datastoreBundles,
        relativePath.replace(/\.ts$/, ".js"),
      );

      try {
        await Deno.stat(bundlePath);
        let cachedJs = await Deno.readTextFile(bundlePath);
        const fixed = fixCjsEsmInterop(rewriteZodImports(cachedJs));
        if (fixed !== cachedJs) {
          cachedJs = fixed;
          await Deno.writeTextFile(bundlePath, cachedJs);
        }
        return await import(toFileUrl(bundlePath).href);
      } catch (error) {
        logger.debug`File URL import failed for ${relativePath}: ${
          String(error).substring(0, 200)
        }`;
      }
    }

    // Fallback: import via base64 data URL (no file on disk)
    try {
      const encoded = uint8ArrayToBase64(
        new TextEncoder().encode(rewritten),
      );
      return await import(
        `data:application/javascript;base64,${encoded}`
      );
    } catch (error) {
      throw new Error(sanitizeDataUrlError(error));
    }
  }

  /**
   * Formats a Zod validation error into a clear message.
   */
  private formatValidationError(error: z.ZodError): string {
    return error.issues
      .map((i) => {
        const path = i.path.join(".");
        return `${path}: ${i.message}`;
      })
      .join("; ");
  }

  /**
   * Recursively discovers TypeScript files in the given directory.
   * Returns relative paths. Excludes test files.
   */
  private async discoverFiles(
    dir: string,
    prefix = "",
  ): Promise<string[]> {
    const files: string[] = [];
    for await (const entry of Deno.readDir(dir)) {
      const relativePath = prefix ? join(prefix, entry.name) : entry.name;
      if (entry.isDirectory) {
        // Skip _-prefixed directories (e.g. _lib/) — helper modules, not entry points
        if (entry.name.startsWith("_")) {
          continue;
        }
        const nested = await this.discoverFiles(
          join(dir, entry.name),
          relativePath,
        );
        files.push(...nested);
      } else if (
        entry.isFile && entry.name.endsWith(".ts") &&
        !entry.name.endsWith("_test.ts")
      ) {
        files.push(relativePath);
      }
    }
    return files.sort();
  }
}
