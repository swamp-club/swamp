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
import { bundleExtension } from "../models/bundle.ts";
import { resolveLocalImports } from "../models/local_import_resolver.ts";
import type { DenoRuntime } from "../runtime/deno_runtime.ts";
import type { ExecutionDriver } from "./execution_driver.ts";
import { driverTypeRegistry } from "./driver_type_registry.ts";
import {
  SWAMP_DATA_DIR,
  SWAMP_SUBDIRS,
} from "../../infrastructure/persistence/paths.ts";
import { assertSafePath } from "../../infrastructure/persistence/safe_path.ts";

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
  configSchema: z.custom<z.ZodTypeAny>((val) => val instanceof z.ZodType)
    .optional(),
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

  /**
   * @param denoRuntime - Runtime manager for obtaining a deno binary path
   * @param repoDir - Repository root for writing bundles to .swamp/driver-bundles/
   *                   (pass null to skip bundle caching)
   */
  constructor(denoRuntime: DenoRuntime, repoDir: string | null = null) {
    this.denoRuntime = denoRuntime;
    this.repoDir = repoDir;
  }

  /**
   * Loads all user driver implementations from the specified directory.
   *
   * @param driversDir - The directory containing user driver files
   * @returns Result containing lists of loaded and failed files
   */
  async loadDrivers(driversDir: string): Promise<DriverLoadResult> {
    const result: DriverLoadResult = { loaded: [], failed: [] };

    // Check if directory exists
    try {
      await Deno.stat(driversDir);
    } catch {
      return result; // No user drivers directory - not an error
    }

    // Ensure deno is available before bundling
    const denoPath = await this.denoRuntime.ensureDeno();

    const files = await this.discoverFiles(driversDir);

    for (const file of files) {
      try {
        const absolutePath = resolve(driversDir, file);
        const js = await this.bundleWithCache(
          absolutePath,
          file,
          denoPath,
          driversDir,
        );
        const module = await this.importBundle(js, file);

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
      const bundlePath = join(
        this.repoDir,
        SWAMP_DATA_DIR,
        SWAMP_SUBDIRS.driverBundles,
        relativePath.replace(/\.ts$/, ".js"),
      );

      // Check mtime-based cache against all local dependencies
      try {
        const bundleStat = await Deno.stat(bundlePath);
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
            logger.debug`Using cached driver bundle for ${relativePath}`;
            return await Deno.readTextFile(bundlePath);
          }
        }
      } catch {
        // Bundle doesn't exist, stat failed, or import resolution failed — rebundle
      }

      // Bundle and write to cache
      const js = await bundleExtension(absolutePath, denoPath);
      const bundleBoundary = join(this.repoDir, SWAMP_DATA_DIR);
      await assertSafePath(bundlePath, bundleBoundary);
      await Deno.mkdir(dirname(bundlePath), { recursive: true });
      await Deno.writeTextFile(bundlePath, js);
      logger.debug`Wrote driver bundle cache: ${bundlePath}`;
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
    if (this.repoDir) {
      const bundlePath = join(
        this.repoDir,
        SWAMP_DATA_DIR,
        SWAMP_SUBDIRS.driverBundles,
        relativePath.replace(/\.ts$/, ".js"),
      );

      try {
        await Deno.stat(bundlePath);
        // Import from file URL — avoids base64 encoding overhead
        return await import(toFileUrl(bundlePath).href);
      } catch {
        // Fall through to data URL import
      }
    }

    // Fallback: import via base64 data URL
    const encoded = btoa(
      String.fromCharCode(...new TextEncoder().encode(js)),
    );
    return await import(
      `data:application/javascript;base64,${encoded}`
    );
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
