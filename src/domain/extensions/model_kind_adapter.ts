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
import { dirname, join, resolve } from "@std/path";
import { getLogger } from "@logtape/logtape";
import { isZodSchemaLike } from "../zod_compat.ts";
import { bundleExtension } from "../models/bundle.ts";
import { ModelType } from "../models/model_type.ts";
import { CalVer } from "../models/calver.ts";
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
} from "../models/model.ts";
import type {
  ExtensionCatalogStore,
  ExtensionTypeRow,
} from "../../infrastructure/persistence/extension_catalog_store.ts";
import {
  bundleNamespace,
  SWAMP_DATA_DIR,
  SWAMP_SUBDIRS,
} from "../../infrastructure/persistence/paths.ts";
import type {
  ExtensionLoadResult,
  KindAdapter,
  RegistrationContext,
  ValidationResult,
} from "./kind_adapter.ts";

const logger = getLogger(["swamp", "models", "loader"]);

interface UserMethodResult {
  dataHandles?: DataHandle[];
  [key: string]: unknown;
}

type UserExecuteFn = (
  args: Record<string, unknown>,
  context: MethodContext,
) => Promise<UserMethodResult>;

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
  arguments: z.custom<z.ZodTypeAny>(isZodSchemaLike),
  execute: z.custom<UserExecuteFn>((val) => typeof val === "function"),
}).passthrough();

const UserUpgradeSchema = z.object({
  toVersion: z.string().refine(CalVer.isValid, {
    message: "toVersion must be valid CalVer (YYYY.MM.DD.MICRO)",
  }),
  description: z.string(),
  upgradeAttributes: z.custom<
    (old: Record<string, unknown>) => Record<string, unknown>
  >((val) => typeof val === "function"),
});

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
  globalArguments: z.custom<z.ZodTypeAny>(isZodSchemaLike).optional(),
  resources: z.record(z.string(), ResourceOutputSpecSchema).optional(),
  files: z.record(z.string(), FileOutputSpecSchema).optional(),
  methods: z.record(z.string(), UserMethodSchema),
  checks: z.record(z.string(), UserCheckSchema).optional(),
  upgrades: z.array(UserUpgradeSchema).optional(),
  reports: z.array(z.string()).optional(),
});

const UserExtensionSchema = z.object({
  type: z.string(),
  methods: z.array(z.record(z.string(), UserMethodSchema)),
  checks: z.array(z.record(z.string(), UserCheckSchema)).optional(),
});

function formatUserModelError(error: z.ZodError): string {
  const issues = error.issues;

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

  const typeIssue = issues.find((i) => i.path[0] === "type");
  if (typeIssue) {
    return (
      "Missing required 'type' field. " +
      "Add a namespaced type identifier.\n\n" +
      "Example:\n" +
      '  type: "@myorg/my-model",'
    );
  }

  const versionIssue = issues.find((i) => i.path[0] === "version");
  if (versionIssue) {
    return (
      "Missing or invalid 'version' field. " +
      "Use CalVer format: YYYY.MM.DD.MICRO.\n\n" +
      "Example:\n" +
      '  version: "2026.02.10.1",'
    );
  }

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

  return issues
    .map((i) => {
      const path = i.path.join(".");
      return `${path}: ${i.message}`;
    })
    .join("; ");
}

function wrapUserExecute(
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

function convertToModelDefinition(
  userModel: z.infer<typeof UserModelSchema>,
): ModelDefinition {
  const modelType = ModelType.create(userModel.type);

  const methods: Record<string, MethodDefinition> = {};
  for (const [name, method] of Object.entries(userModel.methods)) {
    methods[name] = {
      description: method.description,
      ...(method.kind ? { kind: method.kind as MethodKind } : {}),
      arguments: method.arguments,
      execute: wrapUserExecute(method.execute),
    };
  }

  const upgrades: VersionUpgrade[] | undefined = userModel.upgrades?.map(
    (u) => ({
      toVersion: u.toVersion,
      description: u.description,
      upgradeAttributes: u.upgradeAttributes,
    }),
  );

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

function validateUserCollective(rawType: string): string | undefined {
  const normalized = ModelType.create(rawType).normalized;
  const segmentCount = ModelType.getSegmentCount(normalized);
  if (segmentCount < 2) {
    return `Model type '${rawType}' must have at least 2 segments. Expected format: @<collective>/<name> or <collective>/<name> (e.g., @myorg/my-model or myorg/my-model)`;
  }
  return undefined;
}

const extensionFilesRootCache = new Map<string, string | undefined>();

function resolveExtensionFilesRoot(
  sourcePath: string,
  repoDir: string | null,
): string | undefined {
  let currentDir = dirname(sourcePath);
  const root = resolve("/");
  while (true) {
    const cached = extensionFilesRootCache.get(currentDir);
    if (cached !== undefined) return cached;

    const manifestPath = join(currentDir, "manifest.yaml");
    try {
      Deno.lstatSync(manifestPath);
      const normalized = currentDir.replace(/\\/g, "/");
      const pulledMarker = `/${SWAMP_DATA_DIR}/pulled-extensions/`;
      const result = normalized.includes(pulledMarker)
        ? join(currentDir, "files")
        : currentDir;
      extensionFilesRootCache.set(currentDir, result);
      return result;
    } catch {
      // Not here; walk up.
    }

    if (repoDir && resolve(currentDir) === resolve(repoDir)) break;
    const parent = dirname(currentDir);
    if (parent === currentDir || parent === root) return undefined;
    currentDir = parent;
  }
  return undefined;
}

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

export const modelKindAdapter: KindAdapter = {
  kind: "model",
  bundleSubdir: SWAMP_SUBDIRS.bundles,
  catalogKinds: ["model", "extension"],
  primaryExportKey: "model",
  secondaryExportKey: "extension",
  exportRegex: /export\s+const\s+(model|extension)\s*[=:]/,
  useResolver: true,

  validatePrimaryExport(exported: unknown): ValidationResult {
    const result = UserModelSchema.safeParse(exported);
    if (result.success) {
      return { success: true, data: result.data as Record<string, unknown> };
    }
    return { success: false, error: result.error };
  },

  validateSecondaryExport(exported: unknown): ValidationResult {
    const result = UserExtensionSchema.safeParse(exported);
    if (result.success) {
      return { success: true, data: result.data as Record<string, unknown> };
    }
    return { success: false, error: result.error };
  },

  formatValidationError: formatUserModelError,

  normalizeType(validated: Record<string, unknown>): string {
    return ModelType.create(String(validated.type)).normalized;
  },

  extractTypeFromSource(source: string) {
    const modelMatch = /export\s+const\s+model\s*[=:]/.test(source);
    const extensionMatch = /export\s+const\s+extension\s*[=:]/.test(source);
    if (!modelMatch && !extensionMatch) return null;

    const typeMatch = source.match(
      /export\s+const\s+(?:model|extension)\s*=\s*\{[\s\S]*?type\s*:\s*["']([^"']+)["']/,
    );
    if (!typeMatch) return null;

    const typeNormalized = ModelType.create(typeMatch[1]).normalized;
    const versionMatch = source.match(
      /export\s+const\s+(?:model|extension)\s*=\s*\{[\s\S]*?version\s*:\s*["']([^"']+)["']/,
    );

    return {
      typeNormalized,
      version: versionMatch?.[1] ?? "",
      kind: extensionMatch ? "extension" as const : "model" as const,
      extendsType: extensionMatch ? typeNormalized : "",
    };
  },

  validateNamespace: validateUserCollective,

  register(
    _typeNormalized: string,
    validated: Record<string, unknown>,
    _module: Record<string, unknown>,
    context: RegistrationContext,
  ): void {
    const userModel = validated as z.infer<typeof UserModelSchema>;
    const modelDef = convertToModelDefinition(userModel);
    modelDef.extensionFilesRoot = resolveExtensionFilesRoot(
      context.absolutePath,
      context.repoDir,
    );

    let bundlePromise: Promise<string> | undefined;
    modelDef.bundleSourceFactory = () => {
      bundlePromise ??= (async () => {
        const denoPath = await context.denoRuntime.ensureDeno();
        return bundleExtension(
          context.absolutePath,
          denoPath,
          { selfContained: true },
        );
      })().catch((error) => {
        bundlePromise = undefined;
        logger
          .warn`Failed to create self-contained bundle for ${context.absolutePath}: ${error}`;
        throw error;
      });
      return bundlePromise;
    };

    modelRegistry.register(modelDef);
  },

  registerLazy(entry: ExtensionTypeRow): void {
    modelRegistry.registerLazy({
      type: ModelType.create(entry.type_normalized),
      bundlePath: entry.bundle_path,
      sourcePath: entry.source_path,
      version: entry.version,
    });
  },

  promoteFromLazy(
    _typeNormalized: string,
    validated: Record<string, unknown>,
    _module: Record<string, unknown>,
    context: RegistrationContext,
  ): void {
    const userModel = validated as z.infer<typeof UserModelSchema>;
    const modelDef = convertToModelDefinition(userModel);
    modelDef.extensionFilesRoot = resolveExtensionFilesRoot(
      context.absolutePath,
      context.repoDir,
    );

    let bundlePromise: Promise<string> | undefined;
    modelDef.bundleSourceFactory = () => {
      bundlePromise ??= (async () => {
        const denoPath = await context.denoRuntime.ensureDeno();
        return bundleExtension(
          context.absolutePath,
          denoPath,
          { selfContained: true },
        );
      })().catch((error) => {
        bundlePromise = undefined;
        logger
          .warn`Failed to create self-contained bundle for ${context.absolutePath}: ${error}`;
        throw error;
      });
      return bundlePromise;
    };

    modelRegistry.promoteFromLazy(modelDef);
  },

  hasType(typeNormalized: string): boolean {
    return modelRegistry.has(typeNormalized);
  },

  isFullyLoaded(typeNormalized: string): boolean {
    return modelRegistry.get(typeNormalized) !== undefined;
  },

  processSecondaryExport(
    file: string,
    exported: unknown,
    result: ExtensionLoadResult,
  ): void {
    const parsed = UserExtensionSchema.safeParse(exported);
    if (!parsed.success) {
      result.failed.push({ file, error: parsed.error.message });
      return;
    }

    const ext = parsed.data;

    const flatMethods: Record<string, z.infer<typeof UserMethodSchema>> = {};
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

    const targetModel = modelRegistry.get(ext.type);
    if (!targetModel) {
      result.failed.push({
        file,
        error: `Cannot extend unregistered model type: ${ext.type}`,
      });
      return;
    }

    const methods: Record<string, MethodDefinition> = {};
    for (const [name, method] of Object.entries(flatMethods)) {
      methods[name] = {
        description: method.description,
        ...(method.kind ? { kind: method.kind as MethodKind } : {}),
        arguments: method.arguments,
        execute: wrapUserExecute(method.execute),
      };
    }

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

    try {
      modelRegistry.extend(ext.type, methods, checks);
      result.extended.push(file);
    } catch (error) {
      result.failed.push({ file, error: String(error) });
    }
  },

  findExtensionsForType(
    catalog: ExtensionCatalogStore,
    typeNormalized: string,
  ): ExtensionTypeRow[] {
    return catalog.findExtensionsForType(typeNormalized);
  },

  async importAndExtendBundle(
    entry: ExtensionTypeRow,
    importFn: (
      paths: { bundlePath: string; sourcePath: string },
    ) => Promise<Record<string, unknown>>,
    result: ExtensionLoadResult,
  ): Promise<void> {
    const module = await importFn({
      bundlePath: entry.bundle_path,
      sourcePath: entry.source_path,
    });

    if (!module.extension) {
      throw new Error(
        `Bundle has no extension export: ${entry.bundle_path}`,
      );
    }

    modelKindAdapter.processSecondaryExport!(
      entry.source_path,
      module.extension,
      result,
    );

    for (const failure of result.failed) {
      logger
        .warn`Failed to extend model from ${failure.file}: ${failure.error}`;
    }
  },

  async attachPendingExtensionsForType(
    typeNormalized: string,
    catalog: ExtensionCatalogStore,
    importFn: (
      paths: { bundlePath: string; sourcePath: string },
    ) => Promise<Record<string, unknown>>,
  ): Promise<void> {
    const base = modelRegistry.get(typeNormalized);
    if (!base) return;

    const extensions = catalog.findExtensionsForType(typeNormalized);
    for (const entry of extensions) {
      if (await allExtensionMethodsAttached(entry, base, importFn)) continue;
      const result: ExtensionLoadResult = {
        loaded: [],
        extended: [],
        failed: [],
      };
      await modelKindAdapter.importAndExtendBundle!(entry, importFn, result);
    }
  },

  migrateOldFlatBundles(repoDir: string, additionalDirs?: string[]): void {
    const bundlesDir = join(repoDir, SWAMP_DATA_DIR, SWAMP_SUBDIRS.bundles);

    const pulledDir = additionalDirs?.find((d) =>
      d.includes("pulled-extensions")
    );
    const targetNs = pulledDir
      ? bundleNamespace(pulledDir, repoDir)
      : "_migrated";

    try {
      let migrated = 0;
      for (const entry of Deno.readDirSync(bundlesDir)) {
        if (entry.isFile && entry.name.endsWith(".js")) {
          const srcPath = join(bundlesDir, entry.name);
          const destDir = join(bundlesDir, targetNs);
          const destPath = join(destDir, entry.name);
          try {
            Deno.mkdirSync(destDir, { recursive: true });
            Deno.renameSync(srcPath, destPath);
            migrated++;
          } catch {
            // Best-effort — if move fails, leave the flat file
          }
        }
      }
      if (migrated > 0) {
        logger
          .warn`Migrated ${migrated} bundle file(s) to namespaced layout`;
      }
    } catch {
      // Bundles directory doesn't exist — nothing to migrate
    }
  },

  resolveDenoConfig: findNearestDenoConfig,
};

async function allExtensionMethodsAttached(
  entry: ExtensionTypeRow,
  base: ModelDefinition,
  importFn: (
    paths: { bundlePath: string; sourcePath: string },
  ) => Promise<Record<string, unknown>>,
): Promise<boolean> {
  let module: Record<string, unknown>;
  try {
    module = await importFn({
      bundlePath: entry.bundle_path,
      sourcePath: entry.source_path,
    });
  } catch {
    return false;
  }
  if (!module.extension) return false;

  const parsed = UserExtensionSchema.safeParse(module.extension);
  if (!parsed.success) return false;

  const methodNames = new Set<string>();
  for (const record of parsed.data.methods) {
    for (const name of Object.keys(record)) {
      methodNames.add(name);
    }
  }
  const checkNames = new Set<string>();
  for (const record of parsed.data.checks ?? []) {
    for (const name of Object.keys(record)) {
      checkNames.add(name);
    }
  }
  if (methodNames.size === 0 && checkNames.size === 0) return true;

  for (const name of methodNames) {
    if (base.methods[name] === undefined) return false;
  }
  for (const name of checkNames) {
    if (base.checks?.[name] === undefined) return false;
  }
  return true;
}
