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

import { dirname, join, relative } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { createTarGz } from "../../infrastructure/archive/tar_archive.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { validateContentCollectives } from "../../domain/extensions/extension_collective_validator.ts";
import type {
  ExtensionContentMetadata,
  ExtractedArgument,
} from "../../domain/extensions/extension_content.ts";
import type {
  SafetyCheckResult,
  SafetyIssue,
} from "../../domain/extensions/extension_safety_analyzer.ts";
import type { QualityCheckResult } from "../../domain/extensions/extension_quality_checker.ts";
import type { ExtensionManifest } from "../../domain/extensions/extension_manifest.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notAuthenticated, validationFailed } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import { validateExtensionSkills } from "../../domain/extensions/extension_skill_validator.ts";

// ── Data types ────────────────────────────────────────────────────────

/** A model entry enriched with extracted metadata for the resolved display. */
export interface ResolvedModelEntry {
  type: string;
  fileName: string;
  globalArguments?: ExtractedArgument[];
}

/** A vault entry enriched with extracted metadata for the resolved display. */
export interface ResolvedVaultEntry {
  type: string;
  fileName: string;
  name?: string;
  hasConfigSchema?: boolean;
  configFields?: ExtractedArgument[];
}

/** A driver entry enriched with extracted metadata for the resolved display. */
export interface ResolvedDriverEntry {
  type: string;
  fileName: string;
  name?: string;
  hasConfigSchema?: boolean;
  configFields?: ExtractedArgument[];
}

/** A datastore entry enriched with extracted metadata for the resolved display. */
export interface ResolvedDatastoreEntry {
  type: string;
  fileName: string;
  name?: string;
  hasConfigSchema?: boolean;
  configFields?: ExtractedArgument[];
}

/** A report entry enriched with extracted metadata for the resolved display. */
export interface ResolvedReportEntry {
  name: string;
  fileName: string;
  description?: string;
  scope?: string;
  labels?: string[];
}

/** Data for showing resolved extension contents before push. */
export interface ExtensionPushResolvedData {
  name: string;
  version: string;
  description: string | undefined;
  repository: string | undefined;
  releaseNotes: string | undefined;
  models: ResolvedModelEntry[];
  workflowFiles: string[];
  vaults: ResolvedVaultEntry[];
  drivers: ResolvedDriverEntry[];
  datastores: ResolvedDatastoreEntry[];
  reports: ResolvedReportEntry[];
  skills: Array<{ name: string; fileCount: number }>;
  additionalFiles: string[];
  platforms: string[];
  labels: string[];
  dependencies: string[];
}

/** Data for successful push output. */
export interface ExtensionPushSuccessData {
  name: string;
  version: string;
  extensionId: string;
  archiveSize: number;
  modelCount: number;
  workflowCount: number;
  bundleCount: number;
  vaultCount: number;
  driverCount: number;
  datastoreCount: number;
  reportCount: number;
  skillCount: number;
}

/** Data for compilation error output. */
export interface CompilationError {
  file: string;
  error: string;
}

// ── Prepare types ─────────────────────────────────────────────────────

/** Input for the extension push prepare phase. */
export interface ExtensionPushPrepareInput {
  manifest: ExtensionManifest;
  repoDir: string;
  modelsDir: string;
  allModelFiles: string[];
  modelEntryPoints: string[];
  vaultsDir: string;
  allVaultFiles: string[];
  vaultEntryPoints: string[];
  driversDir: string;
  allDriverFiles: string[];
  driverEntryPoints: string[];
  datastoresDir: string;
  allDatastoreFiles: string[];
  datastoreEntryPoints: string[];
  reportsDir: string;
  allReportFiles: string[];
  reportEntryPoints: string[];
  workflowFiles: Array<{ sourcePath: string; archiveName: string }>;
  skillDirs: Array<{ name: string; absolutePath: string }>;
  allSkillFiles: string[];
  includeFilePaths: string[];
  additionalFilePaths: string[];
  dryRun: boolean;
  releaseNotes?: string;
  denoConfigPath?: string;
  packageJsonDir?: string;
  /**
   * If provided, reuse these archive bytes instead of bundling and
   * tarring from source. Callers supply this when a prior
   * `swamp extension quality` run left a cached tarball whose source
   * hash matches the current tree — letting push skip the expensive
   * bundling step. The caller is responsible for validating that the
   * cache key corresponds to the current source state.
   */
  cachedArchive?: Uint8Array;
}

/** Result of the prepare phase, containing everything needed for push. */
export interface ExtensionPushPrepared {
  resolvedData: ExtensionPushResolvedData;
  safetyWarnings: SafetyIssue[];
  archiveBytes: Uint8Array;
  manifest: ExtensionManifest;
  contentMetadata: ExtensionContentMetadata | undefined;
  counts: ExtensionPushCounts;
  isDryRun: boolean;
}

/** Content counts for the extension. */
export interface ExtensionPushCounts {
  models: number;
  workflows: number;
  bundles: number;
  vaults: number;
  drivers: number;
  datastores: number;
  reports: number;
  skills: number;
}

// ── Push (execute) types ──────────────────────────────────────────────

/** Input for the extension push execute phase. */
export interface ExtensionPushExecuteInput {
  manifest: ExtensionManifest;
  archiveBytes: Uint8Array;
  contentMetadata: ExtensionContentMetadata | undefined;
  counts: ExtensionPushCounts;
  releaseNotes?: string;
}

export type ExtensionPushEvent =
  | { kind: "pushing"; phase: "initiate" | "upload" | "confirm" }
  | { kind: "completed"; data: ExtensionPushSuccessData }
  | { kind: "error"; error: SwampError };

// ── Dependencies ──────────────────────────────────────────────────────

/** Dependencies for the extension push prepare phase. */
export interface ExtensionPushPrepareDeps {
  loadCredentials: () => Promise<
    { serverUrl: string; apiKey: string; username: string } | null
  >;
  fetchCollectives: (
    serverUrl: string,
    apiKey: string,
  ) => Promise<string[] | undefined>;
  extractContentMetadata: (
    modelFiles: string[],
    modelsDir: string,
    workflowFiles: Array<{ sourcePath: string; archiveName: string }>,
    vaultFiles: string[],
    vaultsDir: string,
    driverFiles: string[],
    driversDir: string,
    datastoreFiles: string[],
    datastoresDir: string,
    reportFiles: string[],
    reportsDir: string,
  ) => Promise<ExtensionContentMetadata>;
  analyzeExtensionSafety: (files: string[]) => Promise<SafetyCheckResult>;
  checkExtensionQuality: (
    files: string[],
    denoPath: string,
    denoConfigPath?: string,
  ) => Promise<QualityCheckResult>;
  bundleEntryPoint: (
    entryPoint: string,
    denoPath: string,
    options?: { denoConfigPath?: string; packageJsonDir?: string },
  ) => Promise<string>;
  ensureDenoPath: () => Promise<string>;
  getLatestVersion: (
    serverUrl: string,
    name: string,
    apiKey: string,
  ) => Promise<{ version: string } | null>;
}

/** Metadata sent during push phases. */
export interface ExtensionPushMetadata {
  name: string;
  version: string;
  description: string;
  dependencies: string[];
  platforms: string[];
  labels: string[];
  repository?: string;
  releaseNotes?: string;
  contentMetadata?: ExtensionContentMetadata;
}

/** Dependencies for the extension push execute phase. */
export interface ExtensionPushExecuteDeps {
  loadCredentials: () => Promise<
    { serverUrl: string; apiKey: string } | null
  >;
  initiatePush: (
    serverUrl: string,
    metadata: ExtensionPushMetadata,
    apiKey: string,
  ) => Promise<{ uploadUrl: string }>;
  uploadArchive: (
    uploadUrl: string,
    archiveBytes: Uint8Array,
  ) => Promise<void>;
  confirmPush: (
    serverUrl: string,
    metadata: ExtensionPushMetadata,
    apiKey: string,
  ) => Promise<{ name: string; version: string; extensionId: string }>;
}

// ── Deps factory ──────────────────────────────────────────────────────

import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import {
  getCollectives,
  SwampClubClient,
} from "../../infrastructure/http/swamp_club_client.ts";
import { ExtensionApiClient } from "../../infrastructure/http/extension_api_client.ts";
import { analyzeExtensionSafety } from "../../domain/extensions/extension_safety_analyzer.ts";
import { checkExtensionQuality } from "../../domain/extensions/extension_quality_checker.ts";
import { bundleExtension } from "../../domain/models/bundle.ts";
import { extractContentMetadata } from "../../domain/extensions/extension_content_extractor.ts";
import { EmbeddedDenoRuntime } from "../../infrastructure/runtime/embedded_deno_runtime.ts";
import { DEFAULT_SWAMP_CLUB_URL } from "../../domain/auth/auth_credentials.ts";

function resolveServerUrl(): string {
  return Deno.env.get("SWAMP_CLUB_URL") ?? DEFAULT_SWAMP_CLUB_URL;
}

/** Wires real infrastructure into ExtensionPushPrepareDeps. */
export function createExtensionPushPrepareDeps(): ExtensionPushPrepareDeps {
  const authRepo = new AuthRepository();
  const denoRuntime = new EmbeddedDenoRuntime();

  return {
    loadCredentials: async () => {
      const creds = await authRepo.load();
      if (!creds) return null;
      return {
        serverUrl: creds.serverUrl ?? resolveServerUrl(),
        apiKey: creds.apiKey,
        username: creds.username,
      };
    },
    fetchCollectives: async (serverUrl, apiKey) => {
      const client = new SwampClubClient(serverUrl);
      const whoami = await client.whoami(apiKey);
      return getCollectives(whoami);
    },
    extractContentMetadata,
    analyzeExtensionSafety,
    checkExtensionQuality,
    bundleEntryPoint: bundleExtension,
    ensureDenoPath: () => denoRuntime.ensureDeno(),
    getLatestVersion: async (serverUrl, name, apiKey) => {
      const client = new ExtensionApiClient(serverUrl);
      const result = await client.getLatestVersion(name, apiKey);
      if (!result) return null;
      return { version: result.version };
    },
  };
}

/** Wires real infrastructure into ExtensionPushExecuteDeps. */
export function createExtensionPushExecuteDeps(): ExtensionPushExecuteDeps {
  const authRepo = new AuthRepository();

  return {
    loadCredentials: async () => {
      const creds = await authRepo.load();
      if (!creds) return null;
      return {
        serverUrl: creds.serverUrl ?? resolveServerUrl(),
        apiKey: creds.apiKey,
      };
    },
    initiatePush: async (serverUrl, metadata, apiKey) => {
      const client = new ExtensionApiClient(serverUrl);
      const result = await client.initiatePush(metadata, apiKey);
      return { uploadUrl: result.uploadUrl };
    },
    uploadArchive: async (uploadUrl, archiveBytes) => {
      const client = new ExtensionApiClient("");
      await client.uploadArchive(uploadUrl, archiveBytes);
    },
    confirmPush: async (serverUrl, metadata, apiKey) => {
      const client = new ExtensionApiClient(serverUrl);
      return await client.confirmPush(metadata, apiKey);
    },
  };
}

// ── Prepare function ──────────────────────────────────────────────────

/**
 * Performs the extension push prepare phase: validates auth & collectives,
 * extracts content metadata, validates content collectives, runs safety
 * analysis, runs quality checks, bundles entry points, and creates archive.
 *
 * This is a plain async function that throws SwampError on failure.
 * The CLI handles all interactive prompts between prepare and execute.
 */
export async function extensionPushPrepare(
  ctx: LibSwampContext,
  deps: ExtensionPushPrepareDeps,
  input: ExtensionPushPrepareInput,
): Promise<ExtensionPushPrepared> {
  // 1. Auth validation (skip in dry-run)
  let credentials:
    | { serverUrl: string; apiKey: string; username: string }
    | undefined;
  if (!input.dryRun) {
    const creds = await deps.loadCredentials();
    if (!creds) {
      throw notAuthenticated();
    }
    credentials = creds;

    // 2. Validate collective matches user's collectives
    const collectivePart = input.manifest.name.slice(
      1,
      input.manifest.name.indexOf("/"),
    );
    const isReserved = ModelType.isReservedCollective(input.manifest.name);
    let collectives: string[] | undefined;
    try {
      collectives = await deps.fetchCollectives(
        credentials.serverUrl,
        credentials.apiKey,
      );
    } catch {
      ctx.logger
        .debug`Could not fetch collectives from server, falling back to username check`;
    }

    // For reserved collectives, we MUST verify membership via the server
    if (isReserved && !collectives) {
      throw validationFailed(
        `Extension uses reserved collective "@${collectivePart}". ` +
          `Could not verify membership — please check your network connection and try again.`,
      );
    }

    const isAllowed = collectives
      ? collectives.includes(collectivePart)
      : collectivePart === credentials.username;
    if (!isAllowed) {
      const collectivesList = collectives
        ? collectives.map((c) => `@${c}`).join(", ")
        : `@${credentials.username}`;
      throw validationFailed(
        `Extension collective "@${collectivePart}" is not one of your collectives (${collectivesList}). ` +
          `Use one of: ${collectivesList}`,
      );
    }
  }

  // 3. Extract content metadata
  let contentMetadata: ExtensionContentMetadata | undefined;
  try {
    contentMetadata = await deps.extractContentMetadata(
      input.modelEntryPoints,
      input.modelsDir,
      input.workflowFiles,
      input.allVaultFiles,
      input.vaultsDir,
      input.allDriverFiles,
      input.driversDir,
      input.allDatastoreFiles,
      input.datastoresDir,
      input.allReportFiles,
      input.reportsDir,
    );
    ctx.logger
      .debug`Extracted content metadata: ${contentMetadata.models.length} models, ${contentMetadata.workflows.length} workflows, ${contentMetadata.vaults.length} vaults, ${contentMetadata.drivers.length} drivers, ${contentMetadata.datastores.length} datastores, ${contentMetadata.reports.length} reports`;
  } catch {
    ctx.logger.debug`Content metadata extraction failed, skipping`;
  }

  // 4. Validate content collectives
  if (contentMetadata) {
    const collectiveResult = validateContentCollectives(
      input.manifest.name,
      contentMetadata,
    );
    if (!collectiveResult.valid) {
      const slashIndex = input.manifest.name.indexOf("/");
      const expectedCollective = input.manifest.name.slice(
        0,
        slashIndex + 1,
      );
      throw validationFailed(
        "Extension content uses collectives that don't match the extension package. " +
          "All model types, vault types, workflow names, driver types, datastore types, and report names must use the same collective as the extension.",
        {
          expectedCollective,
          mismatches: collectiveResult.mismatches,
        },
      );
    }
  }

  // 5. Build resolved data
  const resolvedData = buildResolvedData(input, contentMetadata);

  // 6. Safety analysis
  // Include files are safety-checked but excluded from quality checks
  // (they may have their own tooling and conventions).
  const qualityFiles = [
    ...input.allModelFiles,
    ...input.allVaultFiles,
    ...input.allDriverFiles,
    ...input.allDatastoreFiles,
    ...input.allReportFiles,
    ...input.workflowFiles.map((wf) => wf.sourcePath),
    ...input.additionalFilePaths,
  ];
  const allFiles = [
    ...qualityFiles,
    ...input.includeFilePaths,
  ];
  const safetyResult = await deps.analyzeExtensionSafety(allFiles);

  if (safetyResult.errors.length > 0) {
    throw validationFailed(
      "Extension has safety errors that must be resolved before pushing.",
      { safetyErrors: safetyResult.errors },
    );
  }

  // 6b. Validate skills and populate content metadata
  if (input.skillDirs.length > 0) {
    const skillResult = await validateExtensionSkills(input.skillDirs);
    if (skillResult.errors.length > 0) {
      throw validationFailed(
        "Extension has skill validation errors:\n" +
          skillResult.errors.map((e) => `  ${e.skill}: ${e.message}`).join(
            "\n",
          ),
      );
    }

    // Populate skill metadata for registry
    if (contentMetadata) {
      const skillsByName = new Map(
        skillResult.skills.map((s) => [s.name, s]),
      );
      contentMetadata.skills = input.skillDirs.map((s) => {
        const validated = skillsByName.get(s.name);
        return {
          dirName: s.name,
          name: s.name,
          description: "",
          hasScripts: validated?.hasScripts ?? false,
          fileCount: validated?.fileCount ?? 0,
        };
      });
    }
  }

  // 7. Resolve deno binary (only needed when building a fresh archive)
  const usingCachedArchive = input.cachedArchive !== undefined;
  let denoPath = "";
  if (!usingCachedArchive) {
    denoPath = await deps.ensureDenoPath();
  }

  // 8. Quality checks — skip on cache hit (the cached archive was
  // written only after quality checks passed)
  if (!usingCachedArchive) {
    const qualityResult = await deps.checkExtensionQuality(
      qualityFiles,
      denoPath,
      input.denoConfigPath,
    );
    if (!qualityResult.passed) {
      throw validationFailed(
        "Extension has formatting or lint issues. Run 'swamp extension fmt <manifest-path>' to fix.",
        { qualityErrors: qualityResult.issues },
      );
    }
  }

  // 9. Bundle entry points + build archive — skip on cache hit
  let totalBundles: number;
  let archiveBytes: Uint8Array;
  if (usingCachedArchive) {
    totalBundles = input.modelEntryPoints.length +
      input.vaultEntryPoints.length + input.driverEntryPoints.length +
      input.datastoreEntryPoints.length + input.reportEntryPoints.length;
    archiveBytes = input.cachedArchive!;
  } else {
    const built = await bundleAndArchive(input, deps, denoPath, ctx);
    totalBundles = built.totalBundles;
    archiveBytes = built.archiveBytes;
  }

  // 10. Check version (skip in dry-run)
  if (!input.dryRun && credentials) {
    const latest = await deps.getLatestVersion(
      credentials.serverUrl,
      input.manifest.name,
      credentials.apiKey,
    );
    if (latest && latest.version === input.manifest.version) {
      throw validationFailed(
        `Version ${input.manifest.version} already exists for ${input.manifest.name}.`,
        { existingVersion: latest.version },
      );
    }
  }

  return {
    resolvedData,
    safetyWarnings: safetyResult.warnings,
    archiveBytes,
    manifest: input.manifest,
    contentMetadata,
    counts: {
      models: input.allModelFiles.length,
      workflows: input.workflowFiles.length,
      bundles: totalBundles,
      vaults: input.allVaultFiles.length,
      drivers: input.allDriverFiles.length,
      datastores: input.allDatastoreFiles.length,
      reports: input.allReportFiles.length,
      skills: input.skillDirs.length,
    },
    isDryRun: input.dryRun,
  };
}

// ── Push generator ────────────────────────────────────────────────────

/**
 * Executes the three-phase push to the registry.
 * Yields streaming events for each phase.
 */
export async function* extensionPush(
  ctx: LibSwampContext,
  deps: ExtensionPushExecuteDeps,
  input: ExtensionPushExecuteInput,
): AsyncIterable<ExtensionPushEvent> {
  yield* withGeneratorSpan(
    "swamp.extension.push",
    { "extension.name": input.manifest.name },
    (async function* () {
      const credentials = await deps.loadCredentials();
      if (!credentials) {
        yield { kind: "error" as const, error: notAuthenticated() };
        return;
      }

      if (!input.manifest.repository) {
        ctx.logger.warn(
          "Your extension manifest doesn't declare a `repository` URL. " +
            `Users running \`swamp issue bug --extension ${input.manifest.name}\` ` +
            "won't be able to file issues against it. " +
            "Consider adding a `repository:` field to manifest.yaml.",
        );
      }

      const releaseNotes = input.releaseNotes ?? input.manifest.releaseNotes;
      const pushMetadata = {
        name: input.manifest.name,
        version: input.manifest.version,
        description: input.manifest.description ?? "",
        dependencies: input.manifest.dependencies,
        platforms: input.manifest.platforms,
        labels: input.manifest.labels,
        repository: input.manifest.repository || undefined,
        ...(releaseNotes ? { releaseNotes } : {}),
      };

      // Phase 1: Initiate
      yield { kind: "pushing" as const, phase: "initiate" as const };
      ctx.logger.debug("Initiating push...");
      let initResult: { uploadUrl: string };
      try {
        initResult = await deps.initiatePush(
          credentials.serverUrl,
          pushMetadata,
          credentials.apiKey,
        );
      } catch (error) {
        yield {
          kind: "error" as const,
          error: validationFailed(
            error instanceof Error ? error.message : String(error),
          ),
        };
        return;
      }

      // Phase 2: Upload archive
      yield { kind: "pushing" as const, phase: "upload" as const };
      ctx.logger.debug("Uploading archive...");
      try {
        await deps.uploadArchive(initResult.uploadUrl, input.archiveBytes);
      } catch (error) {
        yield {
          kind: "error" as const,
          error: validationFailed(
            error instanceof Error ? error.message : String(error),
          ),
        };
        return;
      }

      // Phase 3: Confirm
      yield { kind: "pushing" as const, phase: "confirm" as const };
      ctx.logger.debug("Confirming push...");
      let confirmResult: {
        name: string;
        version: string;
        extensionId: string;
      };
      try {
        confirmResult = await deps.confirmPush(
          credentials.serverUrl,
          { ...pushMetadata, contentMetadata: input.contentMetadata },
          credentials.apiKey,
        );
      } catch (error) {
        yield {
          kind: "error" as const,
          error: validationFailed(
            error instanceof Error ? error.message : String(error),
          ),
        };
        return;
      }

      yield {
        kind: "completed" as const,
        data: {
          name: confirmResult.name,
          version: confirmResult.version,
          extensionId: confirmResult.extensionId,
          archiveSize: input.archiveBytes.length,
          modelCount: input.counts.models,
          workflowCount: input.counts.workflows,
          bundleCount: input.counts.bundles,
          vaultCount: input.counts.vaults,
          driverCount: input.counts.drivers,
          datastoreCount: input.counts.datastores,
          reportCount: input.counts.reports,
          skillCount: input.counts.skills,
        },
      };
    })(),
  );
}

// ── Helpers ───────────────────────────────────────────────────────────

function buildResolvedData(
  input: ExtensionPushPrepareInput,
  contentMetadata: ExtensionContentMetadata | undefined,
): ExtensionPushResolvedData {
  const extractedModelsByFile = new Map(
    (contentMetadata?.models ?? []).map((m) => [m.fileName, m]),
  );
  const extractedVaultsByFile = new Map(
    (contentMetadata?.vaults ?? []).map((v) => [v.fileName, v]),
  );
  const extractedDriversByFile = new Map(
    (contentMetadata?.drivers ?? []).map((d) => [d.fileName, d]),
  );
  const extractedDatastoresByFile = new Map(
    (contentMetadata?.datastores ?? []).map((d) => [d.fileName, d]),
  );
  const extractedReportsByFile = new Map(
    (contentMetadata?.reports ?? []).map((r) => [r.fileName, r]),
  );

  const resolvedModels = input.allModelFiles.map((f) => {
    const relPath = relative(input.repoDir, f);
    const extracted = extractedModelsByFile.get(
      relative(input.modelsDir, f),
    );
    return {
      type: extracted?.type ?? relPath,
      fileName: relPath,
      globalArguments: extracted?.globalArguments,
    };
  });

  const resolvedVaults = input.allVaultFiles.map((f) => {
    const relPath = relative(input.repoDir, f);
    const extracted = extractedVaultsByFile.get(
      relative(input.vaultsDir, f),
    );
    return {
      type: extracted?.type ?? relPath,
      fileName: relPath,
      name: extracted?.name,
      hasConfigSchema: extracted?.hasConfigSchema,
      configFields: extracted?.configFields,
    };
  });

  const resolvedDrivers = input.allDriverFiles.map((f) => {
    const relPath = relative(input.repoDir, f);
    const extracted = extractedDriversByFile.get(
      relative(input.driversDir, f),
    );
    return {
      type: extracted?.type ?? relPath,
      fileName: relPath,
      name: extracted?.name,
      hasConfigSchema: extracted?.hasConfigSchema,
      configFields: extracted?.configFields,
    };
  });

  const resolvedDatastores = input.allDatastoreFiles.map((f) => {
    const relPath = relative(input.repoDir, f);
    const extracted = extractedDatastoresByFile.get(
      relative(input.datastoresDir, f),
    );
    return {
      type: extracted?.type ?? relPath,
      fileName: relPath,
      name: extracted?.name,
      hasConfigSchema: extracted?.hasConfigSchema,
      configFields: extracted?.configFields,
    };
  });

  const resolvedReports = input.allReportFiles.map((f) => {
    const relPath = relative(input.repoDir, f);
    const extracted = extractedReportsByFile.get(
      relative(input.reportsDir, f),
    );
    return {
      name: extracted?.name ?? relPath,
      fileName: relPath,
      description: extracted?.description,
      scope: extracted?.scope,
      labels: extracted?.labels,
    };
  });

  const resolvedReleaseNotes = input.releaseNotes ??
    input.manifest.releaseNotes;

  return {
    name: input.manifest.name,
    version: input.manifest.version,
    description: input.manifest.description,
    repository: input.manifest.repository,
    releaseNotes: resolvedReleaseNotes,
    models: resolvedModels,
    workflowFiles: input.workflowFiles.map((wf) =>
      relative(input.repoDir, wf.sourcePath)
    ),
    vaults: resolvedVaults,
    drivers: resolvedDrivers,
    datastores: resolvedDatastores,
    reports: resolvedReports,
    skills: input.skillDirs.map((s) => ({
      name: s.name,
      fileCount:
        input.allSkillFiles.filter((f) => f.startsWith(s.absolutePath)).length,
    })),
    additionalFiles: input.additionalFilePaths.map((f) =>
      relative(input.repoDir, f)
    ),
    platforms: input.manifest.platforms,
    labels: input.manifest.labels,
    dependencies: input.manifest.dependencies,
  };
}

async function bundleAndArchive(
  input: ExtensionPushPrepareInput,
  deps: ExtensionPushPrepareDeps,
  denoPath: string,
  ctx: LibSwampContext,
): Promise<{ archiveBytes: Uint8Array; totalBundles: number }> {
  const bundleOptions = input.denoConfigPath
    ? { denoConfigPath: input.denoConfigPath }
    : input.packageJsonDir
    ? { packageJsonDir: input.packageJsonDir }
    : undefined;

  const bundles = new Map<string, string>();
  const compilationErrors: CompilationError[] = [];

  await bundleEntryPoints(
    input.modelEntryPoints,
    input.modelsDir,
    bundles,
    compilationErrors,
    deps,
    denoPath,
    bundleOptions,
    ctx,
    "model",
  );

  const vaultBundles = new Map<string, string>();
  await bundleEntryPoints(
    input.vaultEntryPoints,
    input.vaultsDir,
    vaultBundles,
    compilationErrors,
    deps,
    denoPath,
    bundleOptions,
    ctx,
    "vault",
  );

  const driverBundles = new Map<string, string>();
  await bundleEntryPoints(
    input.driverEntryPoints,
    input.driversDir,
    driverBundles,
    compilationErrors,
    deps,
    denoPath,
    bundleOptions,
    ctx,
    "driver",
  );

  const datastoreBundles = new Map<string, string>();
  await bundleEntryPoints(
    input.datastoreEntryPoints,
    input.datastoresDir,
    datastoreBundles,
    compilationErrors,
    deps,
    denoPath,
    bundleOptions,
    ctx,
    "datastore",
  );

  const reportBundles = new Map<string, string>();
  await bundleEntryPoints(
    input.reportEntryPoints,
    input.reportsDir,
    reportBundles,
    compilationErrors,
    deps,
    denoPath,
    bundleOptions,
    ctx,
    "report",
  );

  if (compilationErrors.length > 0) {
    throw validationFailed(
      "Bundle compilation failed. Fix the errors above and try again.",
      { compilationErrors },
    );
  }

  const totalBundles = bundles.size + vaultBundles.size +
    driverBundles.size + datastoreBundles.size + reportBundles.size;

  const archiveBytes = await createArchive(
    input,
    bundles,
    vaultBundles,
    driverBundles,
    datastoreBundles,
    reportBundles,
    ctx,
  );

  return { archiveBytes, totalBundles };
}

async function bundleEntryPoints(
  entryPoints: string[],
  baseDir: string,
  bundles: Map<string, string>,
  compilationErrors: CompilationError[],
  deps: ExtensionPushPrepareDeps,
  denoPath: string,
  bundleOptions:
    | { denoConfigPath?: string; packageJsonDir?: string }
    | undefined,
  ctx: LibSwampContext,
  label: string,
): Promise<void> {
  for (const entryPoint of entryPoints) {
    const entryName = relative(baseDir, entryPoint).replace(/\.ts$/, "");
    try {
      const js = await deps.bundleEntryPoint(
        entryPoint,
        denoPath,
        bundleOptions,
      );
      bundles.set(entryName, js);
      ctx.logger.debug`Bundled ${label} ${entryName} (${js.length} bytes)`;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      compilationErrors.push({ file: entryPoint, error: msg });
    }
  }
}

async function createArchive(
  input: ExtensionPushPrepareInput,
  bundles: Map<string, string>,
  vaultBundles: Map<string, string>,
  driverBundles: Map<string, string>,
  datastoreBundles: Map<string, string>,
  reportBundles: Map<string, string>,
  ctx: LibSwampContext,
): Promise<Uint8Array> {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_ext_" });

  try {
    const extDir = join(tmpDir, "extension");
    const dirs = [
      "models",
      "bundles",
      "workflows",
      "vaults",
      "vault-bundles",
      "drivers",
      "driver-bundles",
      "datastores",
      "datastore-bundles",
      "reports",
      "report-bundles",
      "skills",
      "files",
    ];
    for (const dir of dirs) {
      await Deno.mkdir(join(extDir, dir), { recursive: true });
    }

    // Re-emit the manifest from parsed fields. Path string arrays
    // pass through verbatim — the on-wire manifest stays
    // byte-equivalent to the author's intent (no path rewriting),
    // so what the registry stores matches what was pushed.
    await Deno.writeTextFile(
      join(extDir, "manifest.yaml"),
      stringifyYaml({
        manifestVersion: input.manifest.manifestVersion,
        name: input.manifest.name,
        version: input.manifest.version,
        description: input.manifest.description ?? "",
        ...(input.manifest.repository
          ? { repository: input.manifest.repository }
          : {}),
        ...(input.manifest.paths.base !== "typedDir"
          ? { paths: { base: input.manifest.paths.base } }
          : {}),
        models: input.manifest.models,
        workflows: input.manifest.workflows,
        vaults: input.manifest.vaults,
        drivers: input.manifest.drivers,
        datastores: input.manifest.datastores,
        reports: input.manifest.reports,
        ...(input.manifest.skills.length > 0
          ? { skills: input.manifest.skills }
          : {}),
        ...(input.manifest.include.length > 0
          ? { include: input.manifest.include }
          : {}),
        additionalFiles: input.manifest.additionalFiles,
        ...(input.manifest.platforms.length > 0
          ? { platforms: input.manifest.platforms }
          : {}),
        ...(input.manifest.labels.length > 0
          ? { labels: input.manifest.labels }
          : {}),
        dependencies: input.manifest.dependencies,
      }),
    );

    // Copy model source files
    for (const modelFile of input.allModelFiles) {
      const relPath = relative(input.modelsDir, modelFile);
      const destPath = join(extDir, "models", relPath);
      await Deno.mkdir(dirname(destPath), { recursive: true });
      await Deno.copyFile(modelFile, destPath);
    }

    // Copy include files (alongside model sources, not bundled)
    for (const incFile of input.includeFilePaths) {
      const relPath = relative(input.modelsDir, incFile);
      const destPath = join(extDir, "models", relPath);
      await Deno.mkdir(dirname(destPath), { recursive: true });
      await Deno.copyFile(incFile, destPath);
    }

    // Write compiled model bundles
    for (const [entryName, js] of bundles) {
      const destPath = join(extDir, "bundles", `${entryName}.js`);
      await Deno.mkdir(dirname(destPath), { recursive: true });
      await Deno.writeTextFile(destPath, js);
    }

    // Copy workflow files
    for (const wf of input.workflowFiles) {
      const destPath = join(extDir, "workflows", wf.archiveName);
      await Deno.copyFile(wf.sourcePath, destPath);
    }

    // Copy vault source files
    for (const vaultFile of input.allVaultFiles) {
      const relPath = relative(input.vaultsDir, vaultFile);
      const destPath = join(extDir, "vaults", relPath);
      await Deno.mkdir(dirname(destPath), { recursive: true });
      await Deno.copyFile(vaultFile, destPath);
    }

    // Write compiled vault bundles
    for (const [entryName, js] of vaultBundles) {
      const destPath = join(extDir, "vault-bundles", `${entryName}.js`);
      await Deno.mkdir(dirname(destPath), { recursive: true });
      await Deno.writeTextFile(destPath, js);
    }

    // Copy driver source files
    for (const driverFile of input.allDriverFiles) {
      const relPath = relative(input.driversDir, driverFile);
      const destPath = join(extDir, "drivers", relPath);
      await Deno.mkdir(dirname(destPath), { recursive: true });
      await Deno.copyFile(driverFile, destPath);
    }

    // Write compiled driver bundles
    for (const [entryName, js] of driverBundles) {
      const destPath = join(extDir, "driver-bundles", `${entryName}.js`);
      await Deno.mkdir(dirname(destPath), { recursive: true });
      await Deno.writeTextFile(destPath, js);
    }

    // Copy datastore source files
    for (const datastoreFile of input.allDatastoreFiles) {
      const relPath = relative(input.datastoresDir, datastoreFile);
      const destPath = join(extDir, "datastores", relPath);
      await Deno.mkdir(dirname(destPath), { recursive: true });
      await Deno.copyFile(datastoreFile, destPath);
    }

    // Write compiled datastore bundles
    for (const [entryName, js] of datastoreBundles) {
      const destPath = join(
        extDir,
        "datastore-bundles",
        `${entryName}.js`,
      );
      await Deno.mkdir(dirname(destPath), { recursive: true });
      await Deno.writeTextFile(destPath, js);
    }

    // Copy report source files
    for (const reportFile of input.allReportFiles) {
      const relPath = relative(input.reportsDir, reportFile);
      const destPath = join(extDir, "reports", relPath);
      await Deno.mkdir(dirname(destPath), { recursive: true });
      await Deno.copyFile(reportFile, destPath);
    }

    // Write compiled report bundles
    for (const [entryName, js] of reportBundles) {
      const destPath = join(extDir, "report-bundles", `${entryName}.js`);
      await Deno.mkdir(dirname(destPath), { recursive: true });
      await Deno.writeTextFile(destPath, js);
    }

    // Copy skill directories
    for (const { name, absolutePath } of input.skillDirs) {
      const destDir = join(extDir, "skills", name);
      await Deno.mkdir(destDir, { recursive: true });
      const copySkillDir = async (src: string, dest: string): Promise<void> => {
        for await (const entry of Deno.readDir(src)) {
          const srcPath = join(src, entry.name);
          const destPath = join(dest, entry.name);
          if (entry.isDirectory) {
            await Deno.mkdir(destPath, { recursive: true });
            await copySkillDir(srcPath, destPath);
          } else if (entry.isFile) {
            await Deno.copyFile(srcPath, destPath);
          }
        }
      };
      await copySkillDir(absolutePath, destDir);
    }

    // Copy additional files, preserving the relative paths declared in the
    // manifest. additionalFiles (relative) and additionalFilePaths (absolute)
    // are parallel arrays maintained by resolve_extension_files.ts.
    if (
      input.manifest.additionalFiles.length !== input.additionalFilePaths.length
    ) {
      throw validationFailed(
        "additionalFiles and additionalFilePaths length mismatch — " +
          "this is a bug in extension file resolution.",
      );
    }
    for (let i = 0; i < input.additionalFilePaths.length; i++) {
      const absPath = input.additionalFilePaths[i];
      const relPath = input.manifest.additionalFiles[i];
      const destPath = join(extDir, "files", relPath);
      await Deno.mkdir(dirname(destPath), { recursive: true });
      await Deno.copyFile(absPath, destPath);
    }

    // Create tar.gz. The Deno-native archiver walks the staged tree
    // explicitly, so the previous BSD-tar `COPYFILE_DISABLE=1` env var (which
    // suppressed macOS resource forks) is no longer needed: AppleDouble
    // siblings are filtered defensively in the archiver itself.
    const tarPath = join(tmpDir, "extension.tar.gz");
    try {
      await createTarGz(extDir, tarPath);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw validationFailed(`Failed to create archive: ${message}`);
    }

    const archiveBytes = await Deno.readFile(tarPath);

    // Verify gzip magic bytes
    if (archiveBytes[0] !== 0x1F || archiveBytes[1] !== 0x8B) {
      throw validationFailed(
        "Archive creation failed: output is not a valid gzip file.",
      );
    }

    ctx.logger.debug`Archive created: ${archiveBytes.length} bytes`;

    return archiveBytes;
  } finally {
    try {
      await Deno.remove(tmpDir, { recursive: true });
    } catch {
      // Best-effort cleanup
    }
  }
}
