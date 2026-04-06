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
  isExpectedBundleFailure,
  rewriteZodImports,
  sanitizeDataUrlError,
  uint8ArrayToBase64,
} from "../models/bundle.ts";
import { resolveLocalImports } from "../models/local_import_resolver.ts";
import type { DenoRuntime } from "../runtime/deno_runtime.ts";
import type { ReportContext } from "./report_context.ts";
import type { ReportResult } from "./report.ts";
import { reportRegistry } from "./report_registry.ts";
import {
  bundleNamespace,
  SWAMP_DATA_DIR,
  SWAMP_SUBDIRS,
} from "../../infrastructure/persistence/paths.ts";
import { assertSafePath } from "../../infrastructure/persistence/safe_path.ts";
import type { DatastorePathResolver } from "../datastore/datastore_path_resolver.ts";
import {
  type ExtensionCatalogStore,
  type ExtensionTypeRow,
  sourceDirsFingerprint,
} from "../../infrastructure/persistence/extension_catalog_store.ts";

const logger = getLogger(["swamp", "reports", "loader"]);

/** Pattern for valid user report name: @collective/name[/subname/...] or collective/name[/subname/...] */
const USER_REPORT_NAME_PATTERN = /^@?[a-z0-9_-]+\/[a-z0-9_-]+(\/[a-z0-9_-]+)*$/;

/**
 * Schema for validating user report exports.
 */
const UserReportSchema = z.object({
  name: z.string().refine(
    (n) => USER_REPORT_NAME_PATTERN.test(n),
    {
      message:
        "Report name must match @collective/name or collective/name with optional nested segments (e.g., @myorg/cost-report or @myorg/aws/cost-report)",
    },
  ),
  description: z.string(),
  scope: z.enum(["method", "model", "workflow"]),
  labels: z.array(z.string()).optional(),
  execute: z.custom<(ctx: ReportContext) => Promise<ReportResult>>(
    (val) => typeof val === "function",
  ),
});

/**
 * Result of loading user report extensions from a directory.
 */
export interface ReportLoadResult {
  loaded: string[];
  failed: Array<{ file: string; error: string }>;
}

/**
 * Loader for user-defined TypeScript report implementations.
 *
 * Users export a `report` object from TypeScript files that defines:
 * - name: namespaced identifier (e.g., "@myorg/cost-report")
 * - description: what the report produces
 * - scope: "method" | "model" | "workflow"
 * - labels: optional filtering labels
 * - execute: function that produces ReportResult
 *
 * This loader validates the structure and registers reports with the global registry.
 */
export class UserReportLoader {
  private readonly denoRuntime: DenoRuntime;
  private readonly repoDir: string | null;
  private readonly datastoreResolver?: DatastorePathResolver;

  /**
   * @param denoRuntime - Runtime manager for obtaining a deno binary path
   * @param repoDir - Repository root for writing bundles to .swamp/report-bundles/
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
   * Resolves a report bundle path through the datastore resolver when available,
   * falling back to the local .swamp/report-bundles/ path otherwise.
   */
  private resolveBundlePath(...segments: string[]): string {
    if (!this.repoDir) return "";
    if (this.datastoreResolver) {
      return this.datastoreResolver.resolvePath(
        SWAMP_SUBDIRS.reportBundles,
        ...segments,
      );
    }
    return join(
      this.repoDir,
      SWAMP_DATA_DIR,
      SWAMP_SUBDIRS.reportBundles,
      ...segments,
    );
  }

  /**
   * Loads all user report implementations from the specified directory.
   *
   * @param reportsDir - The directory containing user report files
   * @returns Result containing lists of loaded and failed files
   */
  async loadReports(
    reportsDir: string,
    options?: {
      skipAlreadyRegistered?: boolean;
      /** Additional directories to scan (e.g. pulled extensions). */
      additionalDirs?: string[];
    },
  ): Promise<ReportLoadResult> {
    const result: ReportLoadResult = { loaded: [], failed: [] };

    // Ensure swamp's Zod is available on globalThis before importing bundles.
    installZodGlobal();

    // Ensure deno is available before bundling
    const denoPath = await this.denoRuntime.ensureDeno();

    // Discover files from primary dir and any additional dirs
    const allFiles: Array<{ file: string; baseDir: string }> = [];
    for (
      const dir of [reportsDir, ...(options?.additionalDirs ?? [])]
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

        // Pre-check: only bundle files that declare a report export.
        const source = await Deno.readTextFile(absolutePath);
        if (!/export\s+const\s+report\s*[=:]/.test(source)) {
          logger.debug`Skipping ${file} (no report export found)`;
          continue;
        }

        const js = await this.bundleWithCache(
          absolutePath,
          file,
          denoPath,
          baseDir,
        );
        const module = await this.importBundle(js, file, baseDir);

        if (!module.report) {
          // Files without a report export are silently skipped (utility files)
          continue;
        }

        const parsed = UserReportSchema.safeParse(module.report);
        if (!parsed.success) {
          result.failed.push({
            file,
            error: this.formatValidationError(parsed.error),
          });
          continue;
        }

        const userReport = parsed.data;

        // Register with the report registry
        if (reportRegistry.has(userReport.name)) {
          if (options?.skipAlreadyRegistered) {
            continue;
          }
          result.failed.push({
            file,
            error: `Report name '${userReport.name}' is already registered`,
          });
          continue;
        }

        reportRegistry.register(userReport.name, {
          description: userReport.description,
          scope: userReport.scope,
          labels: userReport.labels,
          execute: userReport.execute,
        });

        result.loaded.push(file);
      } catch (error) {
        result.failed.push({ file, error: String(error) });
      }
    }

    return result;
  }

  /**
   * Builds the catalog index for report types without importing bundles.
   * On first run, does a full import to bootstrap the catalog.
   * On subsequent runs, checks mtimes and only rebundles stale files.
   * Registers lazy entries for all report types in the catalog.
   */
  async buildIndex(
    reportsDir: string,
    catalog: ExtensionCatalogStore,
    options?: { additionalDirs?: string[] },
  ): Promise<ReportLoadResult> {
    const result: ReportLoadResult = { loaded: [], failed: [] };

    installZodGlobal();
    const denoPath = await this.denoRuntime.ensureDeno();

    // Force a full rescan if the set of extension source directories has
    // changed (e.g. user ran `swamp extension source add`). Without this,
    // the catalog's "populated" flag causes buildIndex to skip the full
    // import path, so reports from newly added sources are never discovered
    // (#1107).
    const currentSourceFingerprint = sourceDirsFingerprint(
      reportsDir,
      options?.additionalDirs,
    );
    if (
      catalog.isPopulated("report") &&
      catalog.getSourceDirsFingerprint("report") !== currentSourceFingerprint
    ) {
      logger
        .warn`Extension source dirs changed — invalidating report catalog for full rescan`;
      catalog.invalidate("report");
    }

    if (catalog.isPopulated("report")) {
      const staleFiles = await this.findStaleFiles(
        reportsDir,
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
    const fullResult = await this.loadReports(reportsDir, {
      additionalDirs: options?.additionalDirs,
      skipAlreadyRegistered: true,
    });

    this.populateCatalogFromRegistry(
      catalog,
      reportsDir,
      options?.additionalDirs,
    );
    catalog.markPopulated("report");
    catalog.setSourceDirsFingerprint(currentSourceFingerprint, "report");

    return fullResult;
  }

  /**
   * Loads a single report type by its normalized type name.
   * Looks up the bundle path from the catalog, imports the bundle,
   * and registers the type.
   */
  async loadSingleType(
    typeNormalized: string,
    catalog: ExtensionCatalogStore,
  ): Promise<void> {
    installZodGlobal();

    const entry = catalog.findByType(typeNormalized, "report");
    if (!entry) {
      throw new Error(`No catalog entry for report type: ${typeNormalized}`);
    }

    await this.importAndRegisterBundle(entry);
  }

  /**
   * Imports a single report bundle and registers it.
   */
  private async importAndRegisterBundle(
    entry: ExtensionTypeRow,
  ): Promise<void> {
    if (reportRegistry.get(entry.type_normalized)) return;

    let js = await Deno.readTextFile(entry.bundle_path);
    const fixed = fixCjsEsmInterop(rewriteZodImports(js));
    if (fixed !== js) {
      js = fixed;
      await Deno.writeTextFile(entry.bundle_path, js);
    }
    const module = await import(toFileUrl(entry.bundle_path).href);

    if (!module.report) {
      throw new Error(`Bundle has no report export: ${entry.bundle_path}`);
    }

    const parsed = UserReportSchema.safeParse(module.report);
    if (!parsed.success) {
      throw new Error(this.formatValidationError(parsed.error));
    }

    reportRegistry.promoteFromLazy(parsed.data.name, {
      description: parsed.data.description,
      scope: parsed.data.scope,
      labels: parsed.data.labels,
      execute: parsed.data.execute,
    });
  }

  /**
   * Registers lazy entries for all report types in the catalog.
   */
  private registerLazyFromCatalog(catalog: ExtensionCatalogStore): void {
    const entries = catalog.findByKind("report");
    for (const entry of entries) {
      reportRegistry.registerLazy({
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
  private populateCatalogFromRegistry(
    catalog: ExtensionCatalogStore,
    reportsDir: string,
    additionalDirs?: string[],
  ): void {
    if (!this.repoDir) return;

    const bundleBaseDir = this.resolveBundlePath();

    const dirs = [reportsDir, ...(additionalDirs ?? [])];
    for (const dir of dirs) {
      try {
        this.populateCatalogFromDir(dir, bundleBaseDir, catalog);
      } catch {
        // Directory doesn't exist — skip
      }
    }
  }

  /**
   * Synchronously populates catalog entries from a single directory.
   */
  private populateCatalogFromDir(
    dir: string,
    bundleBaseDir: string,
    catalog: ExtensionCatalogStore,
  ): void {
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
        if (!/export\s+const\s+report\s*[=:]/.test(source)) continue;

        const typeMatch = source.match(/name\s*:\s*["']([^"']+)["']/);
        if (!typeMatch) continue;

        const typeNormalized = typeMatch[1].toLowerCase();

        catalog.upsert({
          type_normalized: typeNormalized,
          kind: "report",
          bundle_path: bundlePath,
          source_path: absolutePath,
          version: "",
          description: "",
          extends_type: "",
          source_mtime: sourceStat.mtime?.toISOString() ?? "",
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
   * Finds files that have changed since the catalog was last populated.
   */
  private async findStaleFiles(
    reportsDir: string,
    catalog: ExtensionCatalogStore,
    additionalDirs?: string[],
  ): Promise<
    Array<{ absolutePath: string; relativePath: string; baseDir: string }>
  > {
    const stale: Array<{
      absolutePath: string;
      relativePath: string;
      baseDir: string;
    }> = [];

    const allDirs = [reportsDir, ...(additionalDirs ?? [])];

    const catalogEntries = catalog.findByKind("report");
    const catalogBySource = new Map<string, ExtensionTypeRow>();
    for (const entry of catalogEntries) {
      catalogBySource.set(entry.source_path, entry);
    }

    const seenSources = new Set<string>();

    for (const dir of allDirs) {
      try {
        await Deno.stat(dir);
      } catch {
        continue;
      }

      const files = await this.discoverFiles(dir);
      for (const relativePath of files) {
        const absolutePath = resolve(dir, relativePath);
        seenSources.add(absolutePath);

        const catalogEntry = catalogBySource.get(absolutePath);
        if (!catalogEntry) {
          stale.push({ absolutePath, relativePath, baseDir: dir });
          continue;
        }

        try {
          const stat = await Deno.stat(absolutePath);
          const sourceMtime = stat.mtime?.toISOString() ?? "";
          if (sourceMtime !== catalogEntry.source_mtime) {
            stale.push({ absolutePath, relativePath, baseDir: dir });
            continue;
          }

          // Entry point is fresh — check transitive dependencies against
          // the cached bundle file's mtime. This catches edits to imported
          // .ts files that don't touch the entry point (#1094).
          const bundlePath = this.getReportBundlePath(relativePath, dir);
          if (bundlePath) {
            try {
              const bundleStat = await Deno.stat(bundlePath);
              if (bundleStat.mtime) {
                const { resolvedFiles } = await resolveLocalImports(
                  [absolutePath],
                  dir,
                );
                const depStats = await Promise.all(
                  resolvedFiles.map((f) => Deno.stat(f)),
                );
                const newestDepMtime = depStats.reduce<Date | null>(
                  (max, s) => {
                    if (!s.mtime) return max;
                    if (!max) return s.mtime;
                    return s.mtime > max ? s.mtime : max;
                  },
                  null,
                );
                if (
                  newestDepMtime && newestDepMtime >= bundleStat.mtime
                ) {
                  stale.push({ absolutePath, relativePath, baseDir: dir });
                }
              }
            } catch {
              // Bundle file missing or dep stat failed — mark as stale
              // to trigger a rebundle.
              stale.push({ absolutePath, relativePath, baseDir: dir });
            }
          }
        } catch {
          stale.push({ absolutePath, relativePath, baseDir: dir });
        }
      }
    }

    for (const [sourcePath] of catalogBySource) {
      if (!seenSources.has(sourcePath)) {
        catalog.removeBySourcePath(sourcePath);
      }
    }

    return stale;
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
    if (!/export\s+const\s+report\s*[=:]/.test(source)) {
      return;
    }

    const js = await this.bundleWithCache(
      absolutePath,
      relativePath,
      denoPath,
      baseDir,
    );
    const module = await this.importBundle(js, relativePath, baseDir);

    if (!module.report) return;

    const parsed = UserReportSchema.safeParse(module.report);
    if (!parsed.success) {
      throw new Error(this.formatValidationError(parsed.error));
    }

    const stat = await Deno.stat(absolutePath);
    const sourceMtime = stat.mtime?.toISOString() ?? "";
    const typeNormalized = parsed.data.name.toLowerCase();
    const bundlePath = this.getReportBundlePath(relativePath, baseDir);

    catalog.upsert({
      type_normalized: typeNormalized,
      kind: "report",
      bundle_path: bundlePath,
      source_path: absolutePath,
      version: "",
      description: parsed.data.description,
      extends_type: "",
      source_mtime: sourceMtime,
    });

    // Also register since we already imported
    if (!reportRegistry.has(parsed.data.name)) {
      reportRegistry.register(parsed.data.name, {
        description: parsed.data.description,
        scope: parsed.data.scope,
        labels: parsed.data.labels,
        execute: parsed.data.execute,
      });
    }
  }

  /**
   * Returns the bundle cache path for a relative source path.
   */
  private getReportBundlePath(
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
   * Bundles a report file, using cached bundle from .swamp/report-bundles/ when possible.
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
            logger.debug`Using cached report bundle for ${relativePath}`;
            return await Deno.readTextFile(bundlePath);
          }
        }
      } catch {
        // Freshness check failed (e.g. missing dependency file).
        // Fall through to attempt a rebundle rather than using a
        // potentially stale cache.
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
        logger.debug`Wrote report bundle cache: ${bundlePath}`;
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
      const bundlePath = this.resolveBundlePath(
        ...(baseDir ? [bundleNamespace(baseDir, this.repoDir)] : []),
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
        if (entry.name.startsWith("_")) continue;
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
