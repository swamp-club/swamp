// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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

import { Command } from "@cliffy/command";
import { dirname } from "@std/path";
import { consumeStream } from "../../libswamp/stream.ts";
import { createExtensionPushPrepareDeps } from "../../libswamp/extensions/push.ts";
import {
  createExtensionQualityDeps,
  extensionQuality,
} from "../../libswamp/extensions/quality.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import {
  defaultPackageCacheRoot,
  ExtensionPackageCache,
} from "../../domain/extensions/extension_package_cache.ts";
import { createExtensionQualityRenderer } from "../../presentation/renderers/extension_quality.ts";
import {
  createContext,
  type GlobalOptions,
  logicalCwd,
  repoDirAsGiven,
  resolveExtensionsDir,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import {
  resolveManifestArgument,
  respellUnderRepoDir,
} from "../resolve_manifest_path.ts";
import {
  createModuleGraphReader,
  findDenoConfig,
  isPulledExtensionManifest,
  projectConfigBoundary,
  resolveExtensionFiles,
} from "../resolve_extension_files.ts";
import { UserError } from "../../domain/errors.ts";
import { VERSION } from "./version.ts";
import { loadIdentity } from "../load_identity.ts";

interface ExtensionQualityOptions extends GlobalOptions {
  repoDir?: string;
  extensionsDir?: string;
}

export const extensionQualityCommand = new Command()
  .name("quality")
  .description(
    "Score an extension against the Swamp Club quality rubric (10 client-earnable factors) and cache the packaged tarball for reuse by push",
  )
  .example(
    "Score extension",
    "swamp extension quality extensions/behaviors/my-behavior/manifest.yaml",
  )
  .example(
    "Machine-readable output",
    "swamp extension quality extensions/behaviors/my-behavior/manifest.yaml --json",
  )
  .arguments("<manifest-path:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option(
    "--extensions-dir <dir:string>",
    "Extensions root: the directory that contains extensions/ (behaviors, workflows and skills resolve from it; env: SWAMP_EXTENSIONS_DIR)",
  )
  .action(
    async function (options: ExtensionQualityOptions, manifestPath: string) {
      const cliCtx = createContext(options, ["extension", "quality"]);
      cliCtx.logger.debug`Starting extension quality`;

      // The repo context and the package cache open the resolved repo dir;
      // the extension's files resolve and report under the spelling the
      // user gave (swamp-club#3536).
      const storageRepoDir = resolveRepoDir(options.repoDir);
      const repoDir = repoDirAsGiven(options.repoDir, storageRepoDir);
      const cwd = logicalCwd();
      // Arguments resolve as before, against the process cwd and the
      // resolved repo dir, so `..` means what it means to every other tool;
      // the results are then spelled under the given repo dir.
      const resolvedExtensionsDir = resolveExtensionsDir(options.extensionsDir);
      const extensionsDir = resolvedExtensionsDir === undefined
        ? undefined
        : await respellUnderRepoDir(resolvedExtensionsDir, repoDir);
      const { absoluteManifestPath: manifestArgumentPath } =
        await resolveManifestArgument({
          argument: manifestPath,
          cwd: Deno.cwd(),
          repoDir: storageRepoDir,
          extensionsDir: resolvedExtensionsDir,
        });
      const absoluteManifestPath = await respellUnderRepoDir(
        manifestArgumentPath,
        repoDir,
      );
      if (isPulledExtensionManifest(repoDir, absoluteManifestPath)) {
        throw new UserError(
          "Cannot run quality on a pulled extension. Pulled extensions are read-only " +
            "copies from the registry. To score a local extension, point at its manifest " +
            "under your extensions/ directory instead.",
        );
      }

      const { repoContext } = await requireInitializedRepoReadOnly({
        repoDir: storageRepoDir,
        outputMode: cliCtx.outputMode,
      });

      const resolved = await resolveExtensionFiles({
        repoDir,
        manifestPath: absoluteManifestPath,
        repoContext,
        logger: cliCtx.logger,
        extensionsDir,
        moduleGraphReader: await createModuleGraphReader({
          readOnlyLock: true,
        }),
      });

      const manifestDir = dirname(absoluteManifestPath);
      const denoConfigPath = await findDenoConfig(
        manifestDir,
        projectConfigBoundary(manifestDir, resolved.extensionsRoot, repoDir),
      );

      const ctx = createLibSwampContext({ logger: cliCtx.logger });
      const identity = await loadIdentity();
      const prepareDeps = createExtensionPushPrepareDeps(identity);
      const cache = new ExtensionPackageCache(
        defaultPackageCacheRoot(storageRepoDir),
        VERSION,
      );
      const deps = createExtensionQualityDeps(prepareDeps, cache, identity);
      const renderer = createExtensionQualityRenderer(cliCtx.outputMode);

      await consumeStream(
        extensionQuality(ctx, deps, {
          prepareInput: {
            manifest: resolved.manifest,
            repoDir,
            manifestDir,
            manifestPath: absoluteManifestPath,
            modelsDir: resolved.modelsDir,
            behaviorsDir: resolved.behaviorsDir,
            allModelFiles: resolved.allModelFiles,
            modelEntryPoints: resolved.modelEntryPoints,
            vaultsDir: resolved.vaultsDir,
            allVaultFiles: resolved.allVaultFiles,
            vaultEntryPoints: resolved.vaultEntryPoints,
            datastoresDir: resolved.datastoresDir,
            allDatastoreFiles: resolved.allDatastoreFiles,
            datastoreEntryPoints: resolved.datastoreEntryPoints,
            reportsDir: resolved.reportsDir,
            allReportFiles: resolved.allReportFiles,
            reportEntryPoints: resolved.reportEntryPoints,
            webhooksDir: resolved.webhooksDir,
            allWebhookFiles: resolved.allWebhookFiles,
            webhookEntryPoints: resolved.webhookEntryPoints,
            workflowFiles: resolved.workflowFiles,
            skillDirs: resolved.skillDirs,
            allSkillFiles: resolved.allSkillFiles,
            includeFilePaths: resolved.includeFilePaths,
            additionalFilePaths: resolved.additionalFilePaths,
            binaryFilePaths: resolved.binaryFilePaths,
            dataFilesByKind: resolved.dataFilesByKind,
            sourcePlan: resolved.sourcePlan,
            missingModules: resolved.missingModules,
            entryPointsReachingSymlinks: resolved.entryPointsReachingSymlinks,
            symlinkedPaths: resolved.symlinkedPaths,
            dryRun: true,
            registryChecks: "skip",
            denoConfigPath,
            packageJsonDir: resolved.packageJsonDir,
            bareImports: resolved.bareImports,
          },
          hashInput: {
            manifest: resolved.manifest,
            rootDir: resolved.extensionsRoot,
            manifestDir,
            modelFilePaths: [
              ...resolved.allModelFiles,
              ...resolved.dataFilesByKind.models,
            ],
            vaultFilePaths: [
              ...resolved.allVaultFiles,
              ...resolved.dataFilesByKind.vaults,
            ],
            datastoreFilePaths: [
              ...resolved.allDatastoreFiles,
              ...resolved.dataFilesByKind.datastores,
            ],
            reportFilePaths: [
              ...resolved.allReportFiles,
              ...resolved.dataFilesByKind.reports,
            ],
            webhookFilePaths: [
              ...resolved.allWebhookFiles,
              ...resolved.dataFilesByKind.webhooks,
            ],
            workflowFilePaths: resolved.workflowFiles.map((w) => w.sourcePath),
            additionalFilePaths: resolved.additionalFilePaths,
            binaryFilePaths: resolved.binaryFilePaths,
            skillFilePaths: resolved.allSkillFiles,
            includeFilePaths: resolved.includeFilePaths,
            denoConfigPath,
            packageJsonPath: undefined,
            bareImports: resolved.bareImports,
            symlinkedPaths: new Set(resolved.symlinkedPaths.keys()),
          },
        }),
        renderer.handlers({ manifestDir, repoDir, cwd }),
      );

      cliCtx.logger.debug`Extension quality command completed`;
    },
  );
