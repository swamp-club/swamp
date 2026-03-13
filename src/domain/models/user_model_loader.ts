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
import { bundleExtension } from "./bundle.ts";
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
  async loadModels(modelsDir: string): Promise<LoadResult> {
    const result: LoadResult = { loaded: [], extended: [], failed: [] };

    // Check if directory exists
    try {
      await Deno.stat(modelsDir);
    } catch {
      return result; // No user models directory - not an error
    }

    // Ensure deno is available before bundling
    const denoPath = await this.denoRuntime.ensureDeno();

    const files = await this.discoverFiles(modelsDir);

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

    for (const file of files) {
      try {
        const absolutePath = resolve(modelsDir, file);
        const js = await this.bundleWithCache(
          absolutePath,
          file,
          denoPath,
          modelsDir,
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

        // Create self-contained bundle for out-of-process drivers (e.g., Docker).
        // This inlines all deps including zod so the bundle runs without network.
        try {
          modelDef.bundleSource = await bundleExtension(
            absolutePath,
            denoPath,
            { selfContained: true },
          );
        } catch (error) {
          logger
            .warn`Failed to create self-contained bundle for ${file}: ${error}`;
          // Non-fatal — model still works with raw driver
        }

        if (!modelRegistry.has(modelDef.type)) {
          modelRegistry.register(modelDef);
          result.loaded.push(file);
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
            logger.debug`Using cached bundle for ${relativePath}`;
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
      logger.debug`Wrote bundle cache: ${bundlePath}`;
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
        SWAMP_SUBDIRS.bundles,
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
