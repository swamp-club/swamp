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
import type { DenoRuntime } from "../runtime/deno_runtime.ts";
import type { VaultProvider } from "./vault_provider.ts";
import { vaultTypeRegistry } from "./vault_type_registry.ts";
import {
  SWAMP_DATA_DIR,
  SWAMP_SUBDIRS,
} from "../../infrastructure/persistence/paths.ts";
import { assertSafePath } from "../../infrastructure/persistence/safe_path.ts";

const logger = getLogger(["swamp", "vaults", "loader"]);

/** Reserved namespaces that user vault types cannot use. */
const RESERVED_NAMESPACES = ["@swamp/", "@si/"];

/** Pattern for valid user vault type: @namespace/name */
const USER_VAULT_TYPE_PATTERN = /^@[a-z0-9_-]+\/[a-z0-9_-]+$/;

/**
 * Schema for validating user vault exports.
 */
const UserVaultSchema = z.object({
  type: z.string().refine(
    (t) => USER_VAULT_TYPE_PATTERN.test(t),
    {
      message:
        "Vault type must match @namespace/name (e.g., @myorg/custom-vault)",
    },
  ),
  name: z.string(),
  description: z.string(),
  configSchema: z.custom<z.ZodTypeAny>((val) => val instanceof z.ZodType)
    .optional(),
  createProvider: z.custom<
    (name: string, config: Record<string, unknown>) => VaultProvider
  >((val) => typeof val === "function"),
});

/**
 * Result of loading user vault extensions from a directory.
 */
export interface VaultLoadResult {
  loaded: string[];
  failed: Array<{ file: string; error: string }>;
}

/**
 * Loader for user-defined TypeScript vault implementations.
 *
 * Users export a `vault` object from TypeScript files that defines:
 * - type: namespaced identifier (e.g., "@myorg/custom-vault")
 * - name: human-readable name
 * - description: vault type description
 * - configSchema: optional Zod schema for config validation
 * - createProvider: factory function returning a VaultProvider
 *
 * This loader validates the structure and registers vault types with the global registry.
 */
export class UserVaultLoader {
  private readonly denoRuntime: DenoRuntime;
  private readonly repoDir: string | null;

  /**
   * @param denoRuntime - Runtime manager for obtaining a deno binary path
   * @param repoDir - Repository root for writing bundles to .swamp/vault-bundles/
   *                   (pass null to skip bundle caching)
   */
  constructor(denoRuntime: DenoRuntime, repoDir: string | null = null) {
    this.denoRuntime = denoRuntime;
    this.repoDir = repoDir;
  }

  /**
   * Loads all user vault implementations from the specified directory.
   *
   * @param vaultsDir - The directory containing user vault files
   * @returns Result containing lists of loaded and failed files
   */
  async loadVaults(vaultsDir: string): Promise<VaultLoadResult> {
    const result: VaultLoadResult = { loaded: [], failed: [] };

    // Check if directory exists
    try {
      await Deno.stat(vaultsDir);
    } catch {
      return result; // No user vaults directory - not an error
    }

    // Ensure deno is available before bundling
    const denoPath = await this.denoRuntime.ensureDeno();

    const files = await this.discoverFiles(vaultsDir);

    for (const file of files) {
      try {
        const absolutePath = resolve(vaultsDir, file);
        const js = await this.bundleWithCache(absolutePath, file, denoPath);
        const module = await this.importBundle(js, file);

        if (!module.vault) {
          // Files without a vault export are silently skipped (utility files)
          continue;
        }

        const parsed = UserVaultSchema.safeParse(module.vault);
        if (!parsed.success) {
          result.failed.push({
            file,
            error: this.formatValidationError(parsed.error),
          });
          continue;
        }

        const userVault = parsed.data;

        // Validate namespace
        const namespaceError = this.validateUserNamespace(userVault.type);
        if (namespaceError) {
          result.failed.push({ file, error: namespaceError });
          continue;
        }

        // Register with the vault type registry
        if (vaultTypeRegistry.has(userVault.type)) {
          result.failed.push({
            file,
            error: `Vault type '${userVault.type}' is already registered`,
          });
          continue;
        }

        vaultTypeRegistry.register({
          type: userVault.type,
          name: userVault.name,
          description: userVault.description,
          configSchema: userVault.configSchema,
          createProvider: userVault.createProvider,
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
   * Bundles a vault file, using cached bundle from .swamp/vault-bundles/ when possible.
   */
  private async bundleWithCache(
    absolutePath: string,
    relativePath: string,
    denoPath: string,
  ): Promise<string> {
    if (this.repoDir) {
      const bundlePath = join(
        this.repoDir,
        SWAMP_DATA_DIR,
        SWAMP_SUBDIRS.vaultBundles,
        relativePath.replace(/\.ts$/, ".js"),
      );

      // Check mtime-based cache
      try {
        const [sourceStat, bundleStat] = await Promise.all([
          Deno.stat(absolutePath),
          Deno.stat(bundlePath),
        ]);

        if (
          sourceStat.mtime && bundleStat.mtime &&
          bundleStat.mtime > sourceStat.mtime
        ) {
          logger.debug`Using cached vault bundle for ${relativePath}`;
          return await Deno.readTextFile(bundlePath);
        }
      } catch {
        // Bundle doesn't exist yet or source stat failed — will rebundle
      }

      // Bundle and write to cache
      const js = await bundleExtension(absolutePath, denoPath);
      const bundleBoundary = join(this.repoDir, SWAMP_DATA_DIR);
      await assertSafePath(bundlePath, bundleBoundary);
      await Deno.mkdir(dirname(bundlePath), { recursive: true });
      await Deno.writeTextFile(bundlePath, js);
      logger.debug`Wrote vault bundle cache: ${bundlePath}`;
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
        SWAMP_SUBDIRS.vaultBundles,
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
   * Validates that a user-defined vault type follows namespace conventions.
   * Must not use reserved namespaces (@swamp/, @si/).
   */
  private validateUserNamespace(type: string): string | undefined {
    for (const reserved of RESERVED_NAMESPACES) {
      if (type.toLowerCase().startsWith(reserved)) {
        return `Vault type '${type}' uses a reserved namespace. User vaults cannot use '@swamp' or '@si' namespaces.`;
      }
    }
    return undefined;
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
