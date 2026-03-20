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
  uint8ArrayToBase64,
} from "../models/bundle.ts";
import { resolveLocalImports } from "../models/local_import_resolver.ts";
import type { DenoRuntime } from "../runtime/deno_runtime.ts";
import type { ReportContext } from "./report_context.ts";
import type { ReportResult } from "./report.ts";
import { reportRegistry } from "./report_registry.ts";
import {
  SWAMP_DATA_DIR,
  SWAMP_SUBDIRS,
} from "../../infrastructure/persistence/paths.ts";
import { assertSafePath } from "../../infrastructure/persistence/safe_path.ts";

const logger = getLogger(["swamp", "reports", "loader"]);

/** Pattern for valid user report name: @collective/name or collective/name */
const USER_REPORT_NAME_PATTERN = /^@?[a-z0-9_-]+\/[a-z0-9_-]+$/;

/**
 * Schema for validating user report exports.
 */
const UserReportSchema = z.object({
  name: z.string().refine(
    (n) => USER_REPORT_NAME_PATTERN.test(n),
    {
      message:
        "Report name must match @collective/name or collective/name (e.g., @myorg/cost-report or myorg/cost-report)",
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

  /**
   * @param denoRuntime - Runtime manager for obtaining a deno binary path
   * @param repoDir - Repository root for writing bundles to .swamp/report-bundles/
   *                   (pass null to skip bundle caching)
   */
  constructor(denoRuntime: DenoRuntime, repoDir: string | null = null) {
    this.denoRuntime = denoRuntime;
    this.repoDir = repoDir;
  }

  /**
   * Loads all user report implementations from the specified directory.
   *
   * @param reportsDir - The directory containing user report files
   * @returns Result containing lists of loaded and failed files
   */
  async loadReports(reportsDir: string): Promise<ReportLoadResult> {
    const result: ReportLoadResult = { loaded: [], failed: [] };

    // Ensure swamp's Zod is available on globalThis before importing bundles.
    installZodGlobal();

    // Check if directory exists
    try {
      await Deno.stat(reportsDir);
    } catch {
      return result; // No user reports directory - not an error
    }

    // Ensure deno is available before bundling
    const denoPath = await this.denoRuntime.ensureDeno();

    const files = await this.discoverFiles(reportsDir);

    for (const file of files) {
      try {
        const absolutePath = resolve(reportsDir, file);
        const js = await this.bundleWithCache(
          absolutePath,
          file,
          denoPath,
          reportsDir,
        );
        const module = await this.importBundle(js, file);

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
   * Bundles a report file, using cached bundle from .swamp/report-bundles/ when possible.
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
        SWAMP_SUBDIRS.reportBundles,
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
        if (bundleExists) {
          logger
            .debug`Using cached report bundle for ${relativePath} (freshness check failed — missing dependency)`;
          return await Deno.readTextFile(bundlePath);
        }
      }

      // Bundle and write to cache
      const js = await bundleExtension(absolutePath, denoPath);
      const bundleBoundary = join(this.repoDir, SWAMP_DATA_DIR);
      await assertSafePath(bundlePath, bundleBoundary);
      await Deno.mkdir(dirname(bundlePath), { recursive: true });
      await Deno.writeTextFile(bundlePath, js);
      logger.debug`Wrote report bundle cache: ${bundlePath}`;
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
        SWAMP_SUBDIRS.reportBundles,
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
