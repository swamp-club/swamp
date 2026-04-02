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
} from "./bundle.ts";
import { resolveLocalImports } from "./local_import_resolver.ts";
import { ModelType } from "./model_type.ts";
import { CalVer } from "./calver.ts";
import {
  type CheckDefinition,
  type CheckResult,
  type DataHandle,
  FileOutputSpecSchema,
  type MethodContext,
  type MethodDefinition,
  type MethodKind,
  type MethodResult,
  type ModelDefinition,
  modelRegistry,
  ResourceOutputSpecSchema,
  type VersionUpgrade,
} from "./model.ts";
import type {
  ExtensionCatalogStore,
  ExtensionTypeRow,
} from "../../infrastructure/persistence/extension_catalog_store.ts";
import type { DenoRuntime } from "../runtime/deno_runtime.ts";
import {
  SWAMP_DATA_DIR,
  SWAMP_SUBDIRS,
} from "../../infrastructure/persistence/paths.ts";
import { assertSafePath } from "../../infrastructure/persistence/safe_path.ts";

const logger = getLogger(["swamp", "models", "loader"]);

/**
 * Plain object result returned by user methods before conversion.
 * User models must use context.writeResource() / context.createFileWriter() to produce data.
 */
interface UserMethodResult {
  /**
   * Handles for data written via context.writeResource() / context.createFileWriter() during execution.
   */
  dataHandles?: DataHandle[];
  [key: string]: unknown;
}

/**
 * User method execute function type.
 * User models receive pre-validated args and context.
 */
type UserExecuteFn = (
  args: Record<string, unknown>,
  context: MethodContext,
) => Promise<UserMethodResult>;

/**
 * Schema for validating user method exports.
 */
const MethodKindSchema = z.enum([
  "create",
  "read",
  "update",
  "delete",
  "list",
  "action",
]);

const UserMethodSchema = z.object({
  description: z.string(),
  kind: MethodKindSchema.optional(),
  arguments: z.custom<z.ZodTypeAny>((val) => val instanceof z.ZodType),
  execute: z.custom<UserExecuteFn>((val) => typeof val === "function"),
}).passthrough();

/**
 * Schema for validating a user-supplied upgrade step.
 */
const UserUpgradeSchema = z.object({
  toVersion: z.string().refine(CalVer.isValid, {
    message: "toVersion must be valid CalVer (YYYY.MM.DD.MICRO)",
  }),
  description: z.string(),
  upgradeAttributes: z.custom<
    (old: Record<string, unknown>) => Record<string, unknown>
  >((val) => typeof val === "function"),
});

/**
 * Schema for validating user model exports.
 */
const UserCheckSchema = z.object({
  description: z.string(),
  labels: z.array(z.string()).optional(),
  appliesTo: z.array(z.string()).optional(),
  execute: z.custom<(context: MethodContext) => Promise<CheckResult>>(
    (val) => typeof val === "function",
  ),
});

const UserModelSchema = z.object({
  type: z.string(),
  version: z.string().refine(CalVer.isValid, {
    message: "version must be valid CalVer (YYYY.MM.DD.MICRO)",
  }),
  globalArguments: z.custom<z.ZodTypeAny>((val) => val instanceof z.ZodType)
    .optional(),
  resources: z.record(z.string(), ResourceOutputSpecSchema).optional(),
  files: z.record(z.string(), FileOutputSpecSchema).optional(),
  methods: z.record(z.string(), UserMethodSchema),
  checks: z.record(z.string(), UserCheckSchema).optional(),
  upgrades: z.array(UserUpgradeSchema).optional(),
  reports: z.array(z.string()).optional(),
});

/**
 * Formats a Zod error into a clear, actionable message.
 */
function formatUserModelError(error: z.ZodError): string {
  const issues = error.issues;

  // Check for missing dataOutputSpecs
  const dataOutputSpecsIssue = issues.find(
    (i) => i.path[0] === "dataOutputSpecs" && i.code === "invalid_type",
  );
  if (dataOutputSpecsIssue) {
    return (
      "Missing required 'dataOutputSpecs' field. " +
      "Add dataOutputSpecs to declare what data your model produces.\n\n" +
      "Example:\n" +
      "  dataOutputSpecs: {\n" +
      "    result: {\n" +
      '      specType: "result",\n' +
      '      contentType: "application/json",\n' +
      '      lifetime: { type: "persistent" },\n' +
      '      garbageCollection: { type: "keep_latest", count: 10 },\n' +
      "      tags: {},\n" +
      "    },\n" +
      "  },"
    );
  }

  // Check for missing method arguments schema
  const methodArgsIssue = issues.find(
    (i) => i.path[0] === "methods" && String(i.path[2]) === "arguments",
  );
  if (methodArgsIssue) {
    return (
      "Missing or invalid 'arguments' on method definition. " +
      "Add a Zod schema to validate method arguments.\n\n" +
      "Example:\n" +
      "  arguments: z.object({\n" +
      '    name: z.string().describe("Resource name"),\n' +
      "  }),"
    );
  }

  // Check for missing type
  const typeIssue = issues.find((i) => i.path[0] === "type");
  if (typeIssue) {
    return (
      "Missing required 'type' field. " +
      "Add a namespaced type identifier.\n\n" +
      "Example:\n" +
      '  type: "@myorg/my-model",'
    );
  }

  // Check for missing version
  const versionIssue = issues.find((i) => i.path[0] === "version");
  if (versionIssue) {
    return (
      "Missing or invalid 'version' field. " +
      "Use CalVer format: YYYY.MM.DD.MICRO.\n\n" +
      "Example:\n" +
      '  version: "2026.02.10.1",'
    );
  }

  // Check for missing methods
  const methodsIssue = issues.find((i) => i.path[0] === "methods");
  if (methodsIssue) {
    return (
      "Missing required 'methods' field. " +
      "Add at least one method to your model.\n\n" +
      "Example:\n" +
      "  methods: {\n" +
      "    run: {\n" +
      '      description: "Execute the model",\n' +
      "      arguments: z.object({}),\n" +
      "      execute: async (args, context) => {\n" +
      "        // Your logic here\n" +
      "        return { dataHandles: [] };\n" +
      "      },\n" +
      "    },\n" +
      "  },"
    );
  }

  // Fallback: format all issues concisely
  return issues
    .map((i) => {
      const path = i.path.join(".");
      return `${path}: ${i.message}`;
    })
    .join("; ");
}

/**
 * Schema for validating user extension exports.
 */
const UserExtensionSchema = z.object({
  type: z.string(),
  methods: z.array(z.record(z.string(), UserMethodSchema)),
  checks: z.array(z.record(z.string(), UserCheckSchema)).optional(),
});

/**
 * Result of loading user models from a directory.
 */
export interface LoadResult {
  loaded: string[];
  extended: string[];
  failed: Array<{ file: string; error: string }>;
}

/**
 * Loader for user-defined TypeScript models and extensions.
 *
 * Users export a plain `model` object to define new types, or an `extension`
 * object to add methods to existing types.
 * This loader validates the structure and registers/extends models with the global registry.
 */
export class UserModelLoader {
  private readonly denoRuntime: DenoRuntime;
  private readonly repoDir: string | null;

  /**
   * @param denoRuntime - Runtime manager for obtaining a deno binary path
   * @param repoDir - Repository root for writing bundles to .swamp/bundles/
   *                   (pass null to skip bundle caching)
   */
  constructor(denoRuntime: DenoRuntime, repoDir: string | null = null) {
    this.denoRuntime = denoRuntime;
    this.repoDir = repoDir;
  }

  /**
   * Loads all user models and extensions from the specified directory.
   * Uses two-pass loading: models first, then extensions.
   *
   * @param modelsDir - The directory containing user model/extension files
   * @returns Result containing lists of loaded, extended, and failed files
   */
  async loadModels(
    modelsDir: string,
    options?: {
      skipAlreadyRegistered?: boolean;
      /** Additional directories to scan (e.g. pulled extensions). */
      additionalDirs?: string[];
    },
  ): Promise<LoadResult> {
    const result: LoadResult = { loaded: [], extended: [], failed: [] };

    // Ensure swamp's Zod is available on globalThis before importing bundles.
    // This prevents dual-instance issues in the compiled binary.
    installZodGlobal();

    // Ensure deno is available before bundling
    const denoPath = await this.denoRuntime.ensureDeno();

    // Discover files from primary dir and any additional dirs, merging into
    // a single list of { file (relative), baseDir (absolute root) } tuples.
    // Primary dir files come first so user extensions take precedence.
    const allFiles: Array<{ file: string; baseDir: string }> = [];
    for (
      const dir of [modelsDir, ...(options?.additionalDirs ?? [])]
    ) {
      try {
        await Deno.stat(dir);
      } catch {
        continue; // Directory doesn't exist — skip
      }
      const files = await this.discoverFiles(dir);
      for (const file of files) {
        allFiles.push({ file, baseDir: dir });
      }
    }

    // Import all files and classify by export name
    const modelFiles: Array<{
      file: string;
      module: Record<string, unknown>;
      absolutePath: string;
    }> = [];
    const extensionFiles: Array<{
      file: string;
      module: Record<string, unknown>;
    }> = [];

    for (const { file, baseDir } of allFiles) {
      try {
        const absolutePath = resolve(baseDir, file);

        // Pre-check: only bundle files that declare a model or extension export.
        // This avoids attempting to bundle helper scripts with unbundleable
        // dependencies (e.g., native modules used via Deno.Command subprocess).
        const source = await Deno.readTextFile(absolutePath);
        if (!/export\s+const\s+(model|extension)\s*[=:]/.test(source)) {
          logger.debug`Skipping ${file} (no model/extension export found)`;
          continue;
        }

        const js = await this.bundleWithCache(
          absolutePath,
          file,
          denoPath,
          baseDir,
        );
        const module = await this.importBundle(js, file);

        if (module.model) {
          modelFiles.push({ file, module, absolutePath });
        } else if (module.extension) {
          extensionFiles.push({ file, module });
        }
        // Files with neither export are silently skipped (utility files)
      } catch (error) {
        result.failed.push({ file, error: String(error) });
      }
    }

    // Pass 1: Process all model exports (register new types)
    for (const { file, module, absolutePath } of modelFiles) {
      try {
        const parsed = UserModelSchema.safeParse(module.model);
        if (!parsed.success) {
          result.failed.push({
            file,
            error: formatUserModelError(parsed.error),
          });
          continue;
        }

        const userModel = parsed.data;

        // Validate namespace before registration
        const namespaceError = this.validateUserCollective(userModel.type);
        if (namespaceError) {
          result.failed.push({ file, error: namespaceError });
          continue;
        }

        const modelDef = this.convertToModelDefinition(userModel);

        // Defer self-contained bundling to first out-of-process execution (e.g. Docker).
        // Memoized so multiple executions in one process only bundle once.
        // Uses promise-based memoization to avoid duplicate work under concurrent calls.
        let bundlePromise: Promise<string> | undefined;
        modelDef.bundleSourceFactory = () => {
          bundlePromise ??= bundleExtension(
            absolutePath,
            denoPath,
            { selfContained: true },
          ).catch((error) => {
            bundlePromise = undefined;
            logger
              .warn`Failed to create self-contained bundle for ${file}: ${error}`;
            throw error;
          });
          return bundlePromise;
        };

        if (!modelRegistry.has(modelDef.type)) {
          modelRegistry.register(modelDef);
          result.loaded.push(file);
        } else if (options?.skipAlreadyRegistered) {
          // Silently skip — used during hot-load after auto-resolution
          continue;
        } else {
          result.failed.push({
            file,
            error: `Model type '${userModel.type}' already registered`,
          });
        }
      } catch (error) {
        result.failed.push({ file, error: String(error) });
      }
    }

    // Pass 2: Process all extension exports (extend existing types)
    for (const { file, module } of extensionFiles) {
      try {
        this.processExtension(file, module.extension, result);
      } catch (error) {
        result.failed.push({ file, error: String(error) });
      }
    }

    return result;
  }

  /**
   * Builds the bundle type index: discovers files, checks mtimes against catalog,
   * bundles only changed files, and populates the catalog with metadata.
   * Registers lazy entries in the model registry for all known types.
   *
   * This is the "index-only" mode — no bundles are imported into the runtime.
   * Types are registered as lazy entries that will be imported on demand.
   *
   * @param modelsDir - Primary directory containing model/extension files
   * @param catalog - The bundle catalog store
   * @param options - Additional directories to scan
   */
  async buildIndex(
    modelsDir: string,
    catalog: ExtensionCatalogStore,
    options?: { additionalDirs?: string[] },
  ): Promise<LoadResult> {
    const result: LoadResult = { loaded: [], extended: [], failed: [] };

    installZodGlobal();
    const denoPath = await this.denoRuntime.ensureDeno();

    // If catalog is already populated, register lazy entries from it
    // and do a lightweight mtime check for staleness.
    if (catalog.isPopulated("model")) {
      const staleFiles = await this.findStaleFiles(
        modelsDir,
        catalog,
        options?.additionalDirs,
      );

      if (staleFiles.length === 0) {
        // All fresh — register lazy entries from catalog and return
        this.registerLazyFromCatalog(catalog);
        return result;
      }

      // Some files are stale — rebundle and reimport just those
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

      // Register lazy entries from the now-updated catalog
      this.registerLazyFromCatalog(catalog);
      return result;
    }

    // Catalog not populated — full import to bootstrap
    const fullResult = await this.loadModels(modelsDir, {
      additionalDirs: options?.additionalDirs,
    });

    // Populate catalog from the now-loaded registry
    this.populateCatalogFromRegistry(
      catalog,
      modelsDir,
      options?.additionalDirs,
    );
    catalog.markPopulated("model");

    return fullResult;
  }

  /**
   * Loads a single model type by its normalized type name.
   * Looks up the bundle path and any extensions from the catalog,
   * imports only those bundles, and registers/extends the type.
   *
   * @param typeNormalized - The normalized type name to load
   * @param catalog - The bundle catalog store
   */
  async loadSingleType(
    typeNormalized: string,
    catalog: ExtensionCatalogStore,
  ): Promise<void> {
    installZodGlobal();

    // Load the base type bundle
    const entry = catalog.findByType(typeNormalized, "model");
    if (!entry) {
      throw new Error(`No catalog entry for type: ${typeNormalized}`);
    }

    await this.importAndRegisterBundle(entry);

    // Load all extensions targeting this type
    const extensions = catalog.findExtensionsForType(typeNormalized);
    for (const ext of extensions) {
      await this.importAndExtendBundle(ext);
    }
  }

  /**
   * Imports a single bundle and registers it as a model type.
   */
  private async importAndRegisterBundle(
    entry: ExtensionTypeRow,
  ): Promise<void> {
    if (modelRegistry.get(entry.type_normalized)) return; // Already loaded

    // Import directly via file URL for the cached bundle
    const module = await this.importBundleByPath(entry.bundle_path);

    if (!module.model) {
      throw new Error(`Bundle has no model export: ${entry.bundle_path}`);
    }

    const parsed = UserModelSchema.safeParse(module.model);
    if (!parsed.success) {
      throw new Error(formatUserModelError(parsed.error));
    }

    const modelDef = this.convertToModelDefinition(parsed.data);

    // Set up self-contained bundle factory for out-of-process execution
    const denoPath = await this.denoRuntime.ensureDeno();
    let bundlePromise: Promise<string> | undefined;
    modelDef.bundleSourceFactory = () => {
      bundlePromise ??= bundleExtension(
        entry.source_path,
        denoPath,
        { selfContained: true },
      ).catch((error) => {
        bundlePromise = undefined;
        logger
          .warn`Failed to create self-contained bundle for ${entry.source_path}: ${error}`;
        throw error;
      });
      return bundlePromise;
    };

    modelRegistry.promoteFromLazy(modelDef);
  }

  /**
   * Imports a single bundle and extends an existing model type.
   * Logs warnings for any failures during extension processing.
   */
  private async importAndExtendBundle(entry: ExtensionTypeRow): Promise<void> {
    const module = await this.importBundleByPath(entry.bundle_path);

    if (!module.extension) {
      throw new Error(`Bundle has no extension export: ${entry.bundle_path}`);
    }

    const result: LoadResult = { loaded: [], extended: [], failed: [] };
    this.processExtension(entry.source_path, module.extension, result);

    for (const failure of result.failed) {
      logger
        .warn`Failed to extend model from ${failure.file}: ${failure.error}`;
    }
  }

  /**
   * Imports a cached bundle directly by its file path.
   * Fixes zod imports and CJS/ESM interop before importing.
   */
  private async importBundleByPath(
    bundlePath: string,
  ): Promise<Record<string, unknown>> {
    // Fix zod imports and CJS/ESM interop in the cached file on disk
    let js = await Deno.readTextFile(bundlePath);
    const fixed = fixCjsEsmInterop(rewriteZodImports(js));
    if (fixed !== js) {
      js = fixed;
      await Deno.writeTextFile(bundlePath, js);
    }
    return await import(toFileUrl(bundlePath).href);
  }

  /**
   * Registers lazy entries for all model types in the catalog.
   * Only registers "model" kind entries — "extension" kind entries are not
   * standalone types but augment base types via modelRegistry.extend().
   * Extensions are loaded alongside their base type in loadSingleType().
   */
  private registerLazyFromCatalog(catalog: ExtensionCatalogStore): void {
    const entries = catalog.findByKind("model");
    for (const entry of entries) {
      modelRegistry.registerLazy({
        type: ModelType.create(entry.type_normalized),
        bundlePath: entry.bundle_path,
        sourcePath: entry.source_path,
        version: entry.version,
      });
    }
  }

  /**
   * Populates the catalog from the currently loaded registry.
   * Used on first run to bootstrap the catalog from a full import.
   */
  private populateCatalogFromRegistry(
    catalog: ExtensionCatalogStore,
    modelsDir: string,
    additionalDirs?: string[],
  ): void {
    // We can only populate entries that have bundle files on disk
    if (!this.repoDir) return;

    const bundleBaseDir = join(
      this.repoDir,
      SWAMP_DATA_DIR,
      SWAMP_SUBDIRS.bundles,
    );

    // Scan all directories for .ts files and write catalog entries for
    // those that have corresponding cached bundles
    const dirs = [modelsDir, ...(additionalDirs ?? [])];
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
    for (const relativePath of files) {
      const absolutePath = resolve(dir, relativePath);
      const bundlePath = join(
        bundleBaseDir,
        relativePath.replace(/\.ts$/, ".js"),
      );

      try {
        const sourceStat = Deno.statSync(absolutePath);
        Deno.statSync(bundlePath); // Ensure bundle exists

        // Read source to determine if model or extension and extract type
        const source = Deno.readTextFileSync(absolutePath);
        const modelMatch = /export\s+const\s+model\s*[=:]/.test(source);
        const extensionMatch = /export\s+const\s+extension\s*[=:]/.test(
          source,
        );

        if (!modelMatch && !extensionMatch) continue;

        // Best-effort regex to extract type name from source text.
        // This may match inside comments or string literals, but it only
        // runs during the first-run catalog bootstrap. Any mismatches are
        // corrected on subsequent runs when the mtime scan detects the
        // file as new (not in catalog) and does a proper bundle import.
        const typeMatch = source.match(
          /type\s*:\s*["']([^"']+)["']/,
        );
        if (!typeMatch) continue;

        const typeNormalized = ModelType.create(typeMatch[1]).normalized;

        // Extract version from source (best-effort regex)
        const versionMatch = source.match(
          /version\s*:\s*["']([^"']+)["']/,
        );

        catalog.upsert({
          type_normalized: typeNormalized,
          kind: extensionMatch ? "extension" : "model",
          bundle_path: bundlePath,
          source_path: absolutePath,
          version: versionMatch?.[1] ?? "",
          description: "",
          extends_type: extensionMatch ? typeNormalized : "",
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
   * Compares source file mtimes against catalog entries.
   */
  private async findStaleFiles(
    modelsDir: string,
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

    const allDirs = [modelsDir, ...(additionalDirs ?? [])];

    // Build a set of all known source paths from the catalog
    const catalogEntries = [
      ...catalog.findByKind("model"),
      ...catalog.findByKind("extension"),
    ];
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
          // New file not in catalog
          stale.push({ absolutePath, relativePath, baseDir: dir });
          continue;
        }

        // Check mtime
        try {
          const stat = await Deno.stat(absolutePath);
          const sourceMtime = stat.mtime?.toISOString() ?? "";
          if (sourceMtime !== catalogEntry.source_mtime) {
            stale.push({ absolutePath, relativePath, baseDir: dir });
          }
        } catch {
          stale.push({ absolutePath, relativePath, baseDir: dir });
        }
      }
    }

    // Check for deleted files — remove from catalog
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
    if (!/export\s+const\s+(model|extension)\s*[=:]/.test(source)) {
      return; // Not a model/extension file
    }

    const js = await this.bundleWithCache(
      absolutePath,
      relativePath,
      denoPath,
      baseDir,
    );
    const module = await this.importBundle(js, relativePath);

    const stat = await Deno.stat(absolutePath);
    const sourceMtime = stat.mtime?.toISOString() ?? "";

    if (module.model) {
      const parsed = UserModelSchema.safeParse(module.model);
      if (!parsed.success) {
        throw new Error(formatUserModelError(parsed.error));
      }
      const typeNormalized = ModelType.create(parsed.data.type).normalized;
      const bundlePath = this.getBundlePath(relativePath);

      catalog.upsert({
        type_normalized: typeNormalized,
        kind: "model",
        bundle_path: bundlePath,
        source_path: absolutePath,
        version: parsed.data.version,
        description: "",
        extends_type: "",
        source_mtime: sourceMtime,
      });

      // Also register the full definition since we already imported it
      const modelDef = this.convertToModelDefinition(parsed.data);
      const denoPathForBundle = denoPath;
      let bundlePromise: Promise<string> | undefined;
      modelDef.bundleSourceFactory = () => {
        bundlePromise ??= bundleExtension(
          absolutePath,
          denoPathForBundle,
          { selfContained: true },
        ).catch((error) => {
          bundlePromise = undefined;
          throw error;
        });
        return bundlePromise;
      };

      if (!modelRegistry.has(modelDef.type)) {
        modelRegistry.register(modelDef);
      }
    } else if (module.extension) {
      const parsed = UserExtensionSchema.safeParse(module.extension);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }
      const typeNormalized = ModelType.create(parsed.data.type).normalized;
      const bundlePath = this.getBundlePath(relativePath);

      catalog.upsert({
        type_normalized: typeNormalized,
        kind: "extension",
        bundle_path: bundlePath,
        source_path: absolutePath,
        version: "",
        description: "",
        extends_type: typeNormalized,
        source_mtime: sourceMtime,
      });
    }
  }

  /**
   * Returns the bundle cache path for a relative source path.
   */
  private getBundlePath(relativePath: string): string {
    if (!this.repoDir) return "";
    return join(
      this.repoDir,
      SWAMP_DATA_DIR,
      SWAMP_SUBDIRS.bundles,
      relativePath.replace(/\.ts$/, ".js"),
    );
  }

  /**
   * Bundles an extension file, using cached bundle from .swamp/bundles/ when possible.
   * Writes the bundle to disk for future caching and potential publishing.
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
        SWAMP_SUBDIRS.bundles,
        relativePath.replace(/\.ts$/, ".js"),
      );

      // Check mtime-based cache against all local dependencies.
      // If the bundle is newer than all source files, use it directly.
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
            logger.debug`Using cached bundle for ${relativePath}`;
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
        const bundleBoundary = join(this.repoDir, SWAMP_DATA_DIR);
        await assertSafePath(bundlePath, bundleBoundary);
        await Deno.mkdir(dirname(bundlePath), { recursive: true });
        await Deno.writeTextFile(bundlePath, js);
        logger.debug`Wrote bundle cache: ${bundlePath}`;
        return js;
      } catch (bundleError) {
        if (bundleExists) {
          try {
            const cached = await Deno.readTextFile(bundlePath);
            logger
              .warn`Rebundle failed for ${relativePath}, using cached bundle: ${bundleError}`;
            // Touch the cache mtime so subsequent loads see it as fresh,
            // avoiding repeated failed rebundle attempts on every cold start.
            try {
              const now = new Date();
              await Deno.utime(bundlePath, now, now);
            } catch { /* ignore — worst case we retry next load */ }
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
  ): Promise<Record<string, unknown>> {
    // Rewrite zod imports and fix CJS/ESM interop at import-time — catches
    // old cached bundles. Both rewrites are idempotent.
    const rewritten = fixCjsEsmInterop(rewriteZodImports(js));

    if (this.repoDir) {
      const bundlePath = join(
        this.repoDir,
        SWAMP_DATA_DIR,
        SWAMP_SUBDIRS.bundles,
        relativePath.replace(/\.ts$/, ".js"),
      );

      try {
        await Deno.stat(bundlePath);
        // Fix zod imports and CJS/ESM interop in the cached file on disk
        // so old cached bundles get fixed permanently.
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
   * Validates that a user-defined model type follows the required collective conventions.
   *
   * Requirements:
   * - Must have at least 2 segments (e.g., "@myorg/echo" or "myorg/echo")
   *
   * @param rawType - The raw type string from the user model
   * @returns Error message if validation fails, undefined if valid
   */
  private validateUserCollective(rawType: string): string | undefined {
    const normalized = ModelType.create(rawType).normalized;

    // Must have at least 2 segments
    const segmentCount = ModelType.getSegmentCount(normalized);
    if (segmentCount < 2) {
      return `Model type '${rawType}' must have at least 2 segments. Expected format: @<collective>/<name> or <collective>/<name> (e.g., @myorg/my-model or myorg/my-model)`;
    }

    return undefined;
  }

  /**
   * Processes an extension export and extends the target model type.
   */
  private processExtension(
    file: string,
    extensionExport: unknown,
    result: LoadResult,
  ): void {
    const parsed = UserExtensionSchema.safeParse(extensionExport);
    if (!parsed.success) {
      result.failed.push({ file, error: parsed.error.message });
      return;
    }

    const ext = parsed.data;

    // Flatten methods array into a single record, checking for duplicate names
    const flatMethods: Record<
      string,
      z.infer<typeof UserMethodSchema>
    > = {};
    for (const methodRecord of ext.methods) {
      for (const [name, method] of Object.entries(methodRecord)) {
        if (flatMethods[name]) {
          result.failed.push({
            file,
            error:
              `Duplicate method name '${name}' within extension methods array`,
          });
          return;
        }
        flatMethods[name] = method;
      }
    }

    // Get the target model for extension
    const targetModel = modelRegistry.get(ext.type);
    if (!targetModel) {
      result.failed.push({
        file,
        error: `Cannot extend unregistered model type: ${ext.type}`,
      });
      return;
    }

    // Convert extension methods using wrapUserExecute
    const methods: Record<string, MethodDefinition> = {};
    for (const [name, method] of Object.entries(flatMethods)) {
      methods[name] = {
        description: method.description,
        ...(method.kind ? { kind: method.kind as MethodKind } : {}),
        arguments: method.arguments,
        execute: this.wrapUserExecute(method.execute),
      };
    }

    // Flatten checks array into a single record (if provided)
    let checks: Record<string, CheckDefinition> | undefined;
    if (ext.checks && ext.checks.length > 0) {
      const flatChecks: Record<string, z.infer<typeof UserCheckSchema>> = {};
      for (const checkRecord of ext.checks) {
        for (const [name, check] of Object.entries(checkRecord)) {
          if (flatChecks[name]) {
            result.failed.push({
              file,
              error:
                `Duplicate check name '${name}' within extension checks array`,
            });
            return;
          }
          flatChecks[name] = check;
        }
      }
      checks = Object.fromEntries(
        Object.entries(flatChecks).map(([name, check]) => [
          name,
          {
            description: check.description,
            labels: check.labels,
            appliesTo: check.appliesTo,
            execute: check.execute,
          },
        ]),
      );
    }

    // Extend the model
    try {
      modelRegistry.extend(ext.type, methods, checks);
      result.extended.push(file);
    } catch (error) {
      result.failed.push({ file, error: String(error) });
    }
  }

  /**
   * Wraps a user execute function to pass through dataHandles from the result.
   * User models write data via context.writeResource() / context.createFileWriter() and return handles.
   */
  private wrapUserExecute(
    userExecuteFn: UserExecuteFn,
  ): (
    args: Record<string, unknown>,
    context: MethodContext,
  ) => Promise<MethodResult> {
    return async (args, context): Promise<MethodResult> => {
      const userResult = await userExecuteFn(args, context);

      return { dataHandles: userResult.dataHandles };
    };
  }

  /**
   * Converts a user model export to a proper ModelDefinition.
   */
  private convertToModelDefinition(
    userModel: z.infer<typeof UserModelSchema>,
  ): ModelDefinition {
    const modelType = ModelType.create(userModel.type);

    // Wrap user's execute functions to convert plain objects to proper entities
    const methods: Record<string, MethodDefinition> = {};
    for (const [name, method] of Object.entries(userModel.methods)) {
      methods[name] = {
        description: method.description,
        ...(method.kind ? { kind: method.kind as MethodKind } : {}),
        arguments: method.arguments,
        execute: this.wrapUserExecute(method.execute),
      };
    }

    // Convert user upgrades to VersionUpgrade[]
    const upgrades: VersionUpgrade[] | undefined = userModel.upgrades?.map(
      (u) => ({
        toVersion: u.toVersion,
        description: u.description,
        upgradeAttributes: u.upgradeAttributes,
      }),
    );

    // Pass through checks directly (no wrapping needed)
    const checks: Record<string, CheckDefinition> | undefined = userModel.checks
      ? Object.fromEntries(
        Object.entries(userModel.checks).map(([name, check]) => [
          name,
          {
            description: check.description,
            labels: check.labels,
            appliesTo: check.appliesTo,
            execute: check.execute,
          },
        ]),
      )
      : undefined;

    return {
      type: modelType,
      version: userModel.version,
      globalArguments: userModel.globalArguments,
      resources: userModel.resources,
      files: userModel.files,
      methods,
      ...(checks ? { checks } : {}),
      ...(upgrades && upgrades.length > 0 ? { upgrades } : {}),
      ...(userModel.reports ? { reports: userModel.reports } : {}),
    };
  }

  /**
   * Recursively discovers TypeScript files in the given directory.
   * Returns relative paths (e.g., "aws/ec2_start.ts", "echo_audit.ts").
   * Excludes test files.
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
