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
import { isZodSchemaLike } from "../zod_compat.ts";
import { getLogger } from "@logtape/logtape";
import {
  bundleExtension,
  fixCjsEsmInterop,
  installZodGlobal,
  isExpectedBundleFailure,
  rewriteZodImports,
  sanitizeDataUrlError,
  uint8ArrayToBase64,
} from "../models/bundle.ts";
import {
  computeSourceFingerprint,
  createFreshnessCache,
  findStaleFiles as findStaleFilesShared,
  type FreshnessCache,
  markCatalogValidationFailed,
} from "../extensions/bundle_freshness.ts";
import type { DenoRuntime } from "../runtime/deno_runtime.ts";
import type { ExecutionDriver } from "./execution_driver.ts";
import { driverTypeRegistry } from "./driver_type_registry.ts";
import {
  bundleNamespace,
  SWAMP_DATA_DIR,
  SWAMP_SUBDIRS,
} from "../../infrastructure/persistence/paths.ts";
import { assertSafePath } from "../../infrastructure/persistence/safe_path.ts";
import { emitTypeExtractionFailure } from "../../infrastructure/logging/extension_load_warnings.ts";
import type { DatastorePathResolver } from "../datastore/datastore_path_resolver.ts";
import {
  type ExtensionCatalogStore,
  type ExtensionTypeRow,
  sourceDirsFingerprint,
} from "../../infrastructure/persistence/extension_catalog_store.ts";

const logger = getLogger(["swamp", "drivers", "loader"]);

/** Pattern for valid user driver type: @collective/name or collective/name */
const USER_DRIVER_TYPE_PATTERN = /^@?[a-z0-9_-]+\/[a-z0-9_-]+$/;

/**
 * Schema for validating user driver exports.
 */
const UserDriverSchema = z.object({
  type: z.string().refine(
    (t) => USER_DRIVER_TYPE_PATTERN.test(t),
    {
      message:
        "Driver type must match @collective/name or collective/name (e.g., @myorg/custom-driver or myorg/custom-driver)",
    },
  ),
  name: z.string(),
  description: z.string(),
  configSchema: z.custom<z.ZodTypeAny>(isZodSchemaLike).optional(),
  createDriver: z.custom<
    (config: Record<string, unknown>) => ExecutionDriver
  >((val) => typeof val === "function"),
});

/**
 * Result of loading user driver extensions from a directory.
 */
export interface DriverLoadResult {
  loaded: string[];
  failed: Array<{ file: string; error: string }>;
}

/**
 * Loader for user-defined TypeScript execution driver implementations.
 *
 * Users export a `driver` object from TypeScript files that defines:
 * - type: namespaced identifier (e.g., "@myorg/custom-driver")
 * - name: human-readable name
 * - description: driver type description
 * - configSchema: optional Zod schema for config validation
 * - createDriver: factory function returning an ExecutionDriver
 *
 * This loader validates the structure and registers driver types with the global registry.
 */
export class UserDriverLoader {
  private readonly denoRuntime: DenoRuntime;
  private readonly repoDir: string | null;
  private readonly datastoreResolver?: DatastorePathResolver;

  /**
   * @param denoRuntime - Runtime manager for obtaining a deno binary path
   * @param repoDir - Repository root for writing bundles to .swamp/driver-bundles/
   *                   (pass null to skip bundle caching)
   * @param datastoreResolver - Optional resolver for routing bundle paths
   *                            through the configured datastore tier
   */
  constructor(
    denoRuntime: DenoRuntime,
    repoDir: string | null = null,
    datastoreResolver?: DatastorePathResolver,
  ) {
    this.denoRuntime = denoRuntime;
    this.repoDir = repoDir;
    this.datastoreResolver = datastoreResolver;
  }

  /**
   * Resolves a driver bundle path through the datastore resolver when available,
   * falling back to the local .swamp/driver-bundles/ path otherwise.
   */
  private resolveBundlePath(...segments: string[]): string {
    if (!this.repoDir) return "";
    if (this.datastoreResolver) {
      return this.datastoreResolver.resolvePath(
        SWAMP_SUBDIRS.driverBundles,
        ...segments,
      );
    }
    return join(
      this.repoDir,
      SWAMP_DATA_DIR,
      SWAMP_SUBDIRS.driverBundles,
      ...segments,
    );
  }

  /**
   * Loads all user driver implementations from the specified directory.
   *
   * @param driversDir - The directory containing user driver files
   * @returns Result containing lists of loaded and failed files
   */
  async loadDrivers(
    driversDir: string,
    options?: {
      skipAlreadyRegistered?: boolean;
      /** Additional directories to scan (e.g. pulled extensions). */
      additionalDirs?: string[];
    },
  ): Promise<DriverLoadResult> {
    const result: DriverLoadResult = { loaded: [], failed: [] };

    // Ensure swamp's Zod is available on globalThis before importing bundles.
    installZodGlobal();

    // Ensure deno is available before bundling
    const denoPath = await this.denoRuntime.ensureDeno();

    // Discover files from primary dir and any additional dirs
    const allFiles: Array<{ file: string; baseDir: string }> = [];
    for (
      const dir of [driversDir, ...(options?.additionalDirs ?? [])]
    ) {
      try {
        await Deno.stat(dir);
      } catch {
        continue;
      }
      const files = await this.discoverFiles(dir);
      for (const file of files) {
        allFiles.push({ file, baseDir: dir });
      }
    }

    for (const { file, baseDir } of allFiles) {
      try {
        const absolutePath = resolve(baseDir, file);

        // Pre-check: only bundle files that declare a driver export.
        const source = await Deno.readTextFile(absolutePath);
        if (!/export\s+const\s+driver\s*[=:]/.test(source)) {
          logger.debug`Skipping ${file} (no driver export found)`;
          continue;
        }

        const js = await this.bundleWithCache(
          absolutePath,
          file,
          denoPath,
          baseDir,
        );
        const module = await this.importBundle(js, file, baseDir);

        if (!module.driver) {
          // Files without a driver export are silently skipped (utility files)
          continue;
        }

        const parsed = UserDriverSchema.safeParse(module.driver);
        if (!parsed.success) {
          result.failed.push({
            file,
            error: this.formatValidationError(parsed.error),
          });
          continue;
        }

        const userDriver = parsed.data;

        // Register with the driver type registry
        if (driverTypeRegistry.has(userDriver.type)) {
          if (options?.skipAlreadyRegistered) {
            continue;
          }
          result.failed.push({
            file,
            error: `Driver type '${userDriver.type}' is already registered`,
          });
          continue;
        }

        driverTypeRegistry.register({
          type: userDriver.type,
          name: userDriver.name,
          description: userDriver.description,
          configSchema: userDriver.configSchema,
          createDriver: userDriver.createDriver,
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
   * Bundles a driver file, using cached bundle from .swamp/driver-bundles/ when possible.
   */
  private async bundleWithCache(
    absolutePath: string,
    relativePath: string,
    denoPath: string,
    boundaryDir: string,
  ): Promise<string> {
    if (this.repoDir) {
      const bundlePath = this.resolveBundlePath(
        bundleNamespace(boundaryDir, this.repoDir),
        relativePath.replace(/\.ts$/, ".js"),
      );

      // Freshness is decided by the caller via
      // bundle_freshness.findStaleFiles (content-fingerprint compare).
      // We only care whether a bundle file exists on disk so we can
      // fall back to it if rebundling fails with an expected error
      // (bare specifiers without deno.json). No mtime check here —
      // mtime-based freshness was unreliable under atomic-rename
      // saves (#125).
      let bundleExists = false;
      try {
        await Deno.stat(bundlePath);
        bundleExists = true;
      } catch {
        // No bundle on disk yet — first-run bootstrap.
      }

      // Fast-path for pulled extensions with bare specifiers and no
      // repo-side deno.json. bundleExtension would always fail for them
      // and we'd wastefully spawn Deno before falling back to the
      // cached bundle anyway.
      if (bundleExists && isExpectedBundleFailure(absolutePath, this.repoDir)) {
        return await Deno.readTextFile(bundlePath);
      }

      // Try to rebundle from source. If bundling fails (e.g. bare specifiers
      // without a deno.json import map) and a cached bundle exists, fall back
      // to the cache. The old bundle file is untouched on failure since
      // bundleExtension returns the JS string in memory before we write.
      try {
        const js = await bundleExtension(absolutePath, denoPath);
        const bundleBoundary = this.resolveBundlePath();
        await assertSafePath(bundlePath, bundleBoundary);
        await Deno.mkdir(dirname(bundlePath), { recursive: true });
        await Deno.writeTextFile(bundlePath, js);
        logger.debug`Wrote driver bundle cache: ${bundlePath}`;
        return js;
      } catch (bundleError) {
        if (bundleExists) {
          try {
            const cached = await Deno.readTextFile(bundlePath);
            const msg = bundleError instanceof Error
              ? bundleError.message
              : String(bundleError);
            const expected = isExpectedBundleFailure(
              absolutePath,
              this.repoDir ?? undefined,
            );
            if (expected) {
              logger
                .debug`Rebundle failed for ${relativePath}, using cached bundle: ${msg}`;
              // Touch the cache mtime so subsequent loads see it as fresh,
              // avoiding repeated failed rebundle attempts on every cold
              // start. Only for expected failures (pulled extensions without
              // project config) where retrying would always fail.
              try {
                const now = new Date();
                await Deno.utime(bundlePath, now, now);
              } catch { /* ignore — worst case we retry next load */ }
            } else {
              logger
                .warn`Rebundle failed for ${relativePath}, using cached bundle: ${msg}`;
            }
            return cached;
          } catch {
            // Cache file was removed between stat and read — treat as no cache.
          }
        }
        throw bundleError;
      }
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
    baseDir?: string,
  ): Promise<Record<string, unknown>> {
    const rewritten = fixCjsEsmInterop(rewriteZodImports(js));

    if (this.repoDir) {
      const ns = baseDir ? bundleNamespace(baseDir, this.repoDir) : "";
      const segments = ns
        ? [ns, relativePath.replace(/\.ts$/, ".js")]
        : [relativePath.replace(/\.ts$/, ".js")];
      const bundlePath = this.resolveBundlePath(...segments);

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
   * Builds the catalog index for driver types without importing bundles.
   * On first run, does a full import to bootstrap the catalog.
   * On subsequent runs, checks mtimes and only rebundles stale files.
   * Registers lazy entries for all driver types in the catalog.
   */
  async buildIndex(
    driversDir: string,
    catalog: ExtensionCatalogStore,
    options?: { additionalDirs?: string[] },
  ): Promise<DriverLoadResult> {
    const result: DriverLoadResult = { loaded: [], failed: [] };

    installZodGlobal();
    const denoPath = await this.denoRuntime.ensureDeno();

    // Force a full rescan if the set of extension source directories has
    // changed (e.g. user ran `swamp extension source add`). Without this,
    // the catalog's "populated" flag causes buildIndex to skip the full
    // import path, so drivers from newly added sources are never discovered
    // (#1107).
    const currentSourceFingerprint = sourceDirsFingerprint(
      driversDir,
      options?.additionalDirs,
    );
    if (
      catalog.isPopulated("driver") &&
      catalog.getSourceDirsFingerprint("driver") !== currentSourceFingerprint
    ) {
      logger
        .warn`Extension source dirs changed — invalidating driver catalog for full rescan`;
      catalog.invalidate("driver");
    }

    if (catalog.isPopulated("driver")) {
      const staleFiles = await this.findStaleFiles(
        driversDir,
        catalog,
        options?.additionalDirs,
      );

      if (staleFiles.length === 0) {
        this.registerLazyFromCatalog(catalog);
        return result;
      }

      for (const { absolutePath, relativePath, baseDir } of staleFiles) {
        try {
          await this.rebundleAndUpdateCatalog(
            absolutePath,
            relativePath,
            denoPath,
            baseDir,
            catalog,
          );
          result.loaded.push(relativePath);
        } catch (error) {
          result.failed.push({ file: relativePath, error: String(error) });
        }
      }

      this.registerLazyFromCatalog(catalog);
      return result;
    }

    // Catalog not populated — full import to bootstrap.
    const fullResult = await this.loadDrivers(driversDir, {
      additionalDirs: options?.additionalDirs,
      skipAlreadyRegistered: true,
    });

    await this.populateCatalogFromRegistry(
      catalog,
      driversDir,
      options?.additionalDirs,
    );
    catalog.markPopulated("driver");
    catalog.setSourceDirsFingerprint(currentSourceFingerprint, "driver");

    return fullResult;
  }

  /**
   * Loads a single driver type by its normalized type name.
   * Looks up the bundle path from the catalog, imports the bundle,
   * and registers the type.
   */
  async loadSingleType(
    typeNormalized: string,
    catalog: ExtensionCatalogStore,
  ): Promise<void> {
    installZodGlobal();

    const entry = catalog.findByType(typeNormalized, "driver");
    if (!entry) {
      throw new Error(`No catalog entry for driver type: ${typeNormalized}`);
    }

    await this.importAndRegisterBundle(entry);
  }

  /**
   * Imports a single driver bundle and registers it.
   */
  private async importAndRegisterBundle(
    entry: ExtensionTypeRow,
  ): Promise<void> {
    if (driverTypeRegistry.get(entry.type_normalized)) return;

    let js = await Deno.readTextFile(entry.bundle_path);
    const fixed = fixCjsEsmInterop(rewriteZodImports(js));
    if (fixed !== js) {
      js = fixed;
      await Deno.writeTextFile(entry.bundle_path, js);
    }
    const module = await import(toFileUrl(entry.bundle_path).href);

    if (!module.driver) {
      throw new Error(`Bundle has no driver export: ${entry.bundle_path}`);
    }

    const parsed = UserDriverSchema.safeParse(module.driver);
    if (!parsed.success) {
      throw new Error(this.formatValidationError(parsed.error));
    }

    driverTypeRegistry.promoteFromLazy({
      type: parsed.data.type,
      name: parsed.data.name,
      description: parsed.data.description,
      configSchema: parsed.data.configSchema,
      createDriver: parsed.data.createDriver,
      isBuiltIn: false,
    });
  }

  /**
   * Registers lazy entries for all driver types in the catalog.
   */
  private registerLazyFromCatalog(catalog: ExtensionCatalogStore): void {
    const entries = catalog.findByKind("driver");
    for (const entry of entries) {
      // Skip validation-failed rows (swamp-club#209) — see equivalent
      // guard in user_model_loader.ts:registerLazyFromCatalog.
      if (entry.validation_failed) continue;
      driverTypeRegistry.registerLazy({
        type: entry.type_normalized,
        bundlePath: entry.bundle_path,
        sourcePath: entry.source_path,
        version: entry.version,
      });
    }
  }

  /**
   * Populates the catalog from the currently loaded registry.
   */
  private async populateCatalogFromRegistry(
    catalog: ExtensionCatalogStore,
    driversDir: string,
    additionalDirs?: string[],
  ): Promise<void> {
    if (!this.repoDir) return;

    const bundleBaseDir = this.resolveBundlePath();
    // One cache per populate pass so shared deps are hashed once.
    const cache = createFreshnessCache();

    const dirs = [driversDir, ...(additionalDirs ?? [])];
    for (const dir of dirs) {
      try {
        await this.populateCatalogFromDir(dir, bundleBaseDir, catalog, cache);
      } catch {
        // Directory doesn't exist — skip
      }
    }
  }

  /**
   * Populates catalog entries from a single directory, recording a
   * content-fingerprint for each entry so subsequent findStaleFiles
   * passes can detect mtime-preserving edits (#125).
   */
  private async populateCatalogFromDir(
    dir: string,
    bundleBaseDir: string,
    catalog: ExtensionCatalogStore,
    cache: FreshnessCache,
  ): Promise<void> {
    const files = this.discoverFilesSync(dir);
    const ns = this.repoDir ? bundleNamespace(dir, this.repoDir) : "";
    for (const relativePath of files) {
      const absolutePath = resolve(dir, relativePath);
      const bundlePath = join(
        bundleBaseDir,
        ns,
        relativePath.replace(/\.ts$/, ".js"),
      );

      try {
        const sourceStat = Deno.statSync(absolutePath);
        Deno.statSync(bundlePath);

        const source = Deno.readTextFileSync(absolutePath);
        if (!/export\s+const\s+driver\s*[=:]/.test(source)) continue;

        const typeMatch = source.match(/type\s*:\s*["']([^"']+)["']/);
        if (!typeMatch) {
          emitTypeExtractionFailure(absolutePath, "driver");
          continue;
        }

        const typeNormalized = typeMatch[1].toLowerCase();

        const sourceFingerprint = await computeSourceFingerprint(
          absolutePath,
          dir,
          cache,
        );

        catalog.upsert({
          type_normalized: typeNormalized,
          kind: "driver",
          bundle_path: bundlePath,
          source_path: absolutePath,
          version: "",
          description: "",
          extends_type: "",
          source_mtime: sourceStat.mtime?.toISOString() ?? "",
          source_fingerprint: sourceFingerprint,
        });
      } catch {
        // Skip files that can't be read or don't have bundles
      }
    }
  }

  /**
   * Synchronous version of discoverFiles for catalog population.
   */
  private discoverFilesSync(dir: string, prefix = ""): string[] {
    const files: string[] = [];
    for (const entry of Deno.readDirSync(dir)) {
      const relativePath = prefix ? join(prefix, entry.name) : entry.name;
      if (entry.isDirectory) {
        if (entry.name.startsWith("_")) continue;
        files.push(
          ...this.discoverFilesSync(join(dir, entry.name), relativePath),
        );
      } else if (
        entry.isFile && entry.name.endsWith(".ts") &&
        !entry.name.endsWith("_test.ts")
      ) {
        files.push(relativePath);
      }
    }
    return files.sort();
  }

  /**
   * Finds files that need rebundling since the catalog was last populated.
   * Delegates to the shared content-fingerprint freshness check —
   * mtime-based invalidation was unreliable under atomic-rename saves and
   * mtime-preserving sync tools (issue #125).
   */
  private async findStaleFiles(
    driversDir: string,
    catalog: ExtensionCatalogStore,
    additionalDirs?: string[],
  ): Promise<
    Array<{ absolutePath: string; relativePath: string; baseDir: string }>
  > {
    return await findStaleFilesShared({
      modelsDir: driversDir,
      additionalDirs,
      catalog,
      discoverFiles: (dir) => this.discoverFiles(dir),
      kinds: ["driver"],
    });
  }

  /**
   * Rebundles a single file and updates the catalog entry.
   */
  private async rebundleAndUpdateCatalog(
    absolutePath: string,
    relativePath: string,
    denoPath: string,
    baseDir: string,
    catalog: ExtensionCatalogStore,
  ): Promise<void> {
    const source = await Deno.readTextFile(absolutePath);
    if (!/export\s+const\s+driver\s*[=:]/.test(source)) {
      return;
    }

    const js = await this.bundleWithCache(
      absolutePath,
      relativePath,
      denoPath,
      baseDir,
    );
    const module = await this.importBundle(js, relativePath, baseDir);

    if (!module.driver) return;

    // Compute mtime+fingerprint BEFORE schema validation so we can
    // record a validation-failed catalog row if the parse throws —
    // otherwise findStaleFiles re-bundles every pass on a stable
    // broken source (swamp-club#209).
    const stat = await Deno.stat(absolutePath);
    const sourceMtime = stat.mtime?.toISOString() ?? "";
    const sourceFingerprint = await computeSourceFingerprint(
      absolutePath,
      baseDir,
    );
    const bundlePath = this.getDriverBundlePath(relativePath, baseDir);

    const parsed = UserDriverSchema.safeParse(module.driver);
    if (!parsed.success) {
      markCatalogValidationFailed({
        catalog,
        sourcePath: absolutePath,
        kind: "driver",
        bundlePath,
        sourceMtime,
        sourceFingerprint,
      });
      throw new Error(this.formatValidationError(parsed.error));
    }

    const typeNormalized = parsed.data.type.toLowerCase();

    catalog.upsert({
      type_normalized: typeNormalized,
      kind: "driver",
      bundle_path: bundlePath,
      source_path: absolutePath,
      version: "",
      description: parsed.data.description,
      extends_type: "",
      source_mtime: sourceMtime,
      source_fingerprint: sourceFingerprint,
    });

    // Also register since we already imported
    if (!driverTypeRegistry.has(parsed.data.type)) {
      driverTypeRegistry.register({
        type: parsed.data.type,
        name: parsed.data.name,
        description: parsed.data.description,
        configSchema: parsed.data.configSchema,
        createDriver: parsed.data.createDriver,
        isBuiltIn: false,
      });
    }
  }

  /**
   * Returns the bundle cache path for a relative source path.
   */
  private getDriverBundlePath(
    relativePath: string,
    baseDir: string,
  ): string {
    if (!this.repoDir) return "";
    return this.resolveBundlePath(
      bundleNamespace(baseDir, this.repoDir),
      relativePath.replace(/\.ts$/, ".js"),
    );
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
