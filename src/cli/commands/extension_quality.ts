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
import { dirname, resolve } from "@std/path";
import {
  consumeStream,
  createExtensionPushPrepareDeps,
  createExtensionQualityDeps,
  createLibSwampContext,
  defaultPackageCacheRoot,
  ExtensionPackageCache,
  extensionQuality,
} from "../../libswamp/mod.ts";
import { createExtensionQualityRenderer } from "../../presentation/renderers/extension_quality.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import {
  isPulledExtensionManifest,
  resolveExtensionFiles,
} from "../resolve_extension_files.ts";
import { UserError } from "../../domain/errors.ts";
import { loadIdentity } from "../load_identity.ts";

interface ExtensionQualityOptions extends GlobalOptions {
  repoDir?: string;
}

/**
 * Walks up from `startDir` looking for a `deno.json` file, stopping at
 * `boundaryDir` (inclusive). Kept consistent with the equivalent helper
 * in `extension_push.ts`.
 */
async function findDenoConfig(
  startDir: string,
  boundaryDir: string,
): Promise<string | undefined> {
  let current = resolve(startDir);
  const boundary = resolve(boundaryDir);

  while (true) {
    const candidate = `${current}/deno.json`;
    try {
      await Deno.stat(candidate);
      return candidate;
    } catch {
      // not here
    }
    if (current === boundary) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

export const extensionQualityCommand = new Command()
  .name("quality")
  .description(
    "Score an extension against the Swamp Club quality rubric (10 client-earnable factors) and cache the packaged tarball for reuse by push",
  )
  .example(
    "Score extension",
    "swamp extension quality extensions/models/my-model/manifest.yaml",
  )
  .example(
    "Machine-readable output",
    "swamp extension quality extensions/models/my-model/manifest.yaml --json",
  )
  .arguments("<manifest-path:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(
    async function (options: ExtensionQualityOptions, manifestPath: string) {
      const cliCtx = createContext(options, ["extension", "quality"]);
      cliCtx.logger.debug`Starting extension quality`;

      const repoDir = resolveRepoDir(options.repoDir);
      if (isPulledExtensionManifest(repoDir, manifestPath)) {
        throw new UserError(
          "Cannot run quality on a pulled extension. Pulled extensions are read-only " +
            "copies from the registry. To score a local extension, point at its manifest " +
            "under your extensions/ directory instead.",
        );
      }

      const { repoContext } = await requireInitializedRepoReadOnly({
        repoDir,
        outputMode: cliCtx.outputMode,
      });

      const resolved = await resolveExtensionFiles({
        repoDir,
        manifestPath,
        repoContext,
        logger: cliCtx.logger,
      });

      const absoluteManifestPath = resolve(repoDir, manifestPath);
      const manifestDir = dirname(absoluteManifestPath);
      const denoConfigPath = await findDenoConfig(
        manifestDir,
        resolve(repoDir),
      );

      const ctx = createLibSwampContext({ logger: cliCtx.logger });
      const identity = await loadIdentity();
      const prepareDeps = createExtensionPushPrepareDeps(identity);
      const cache = new ExtensionPackageCache(defaultPackageCacheRoot(repoDir));
      const deps = createExtensionQualityDeps(prepareDeps, cache);
      const renderer = createExtensionQualityRenderer(cliCtx.outputMode);

      await consumeStream(
        extensionQuality(ctx, deps, {
          prepareInput: {
            manifest: resolved.manifest,
            repoDir,
            modelsDir: resolved.modelsDir,
            allModelFiles: resolved.allModelFiles,
            modelEntryPoints: resolved.modelEntryPoints,
            vaultsDir: resolved.vaultsDir,
            allVaultFiles: resolved.allVaultFiles,
            vaultEntryPoints: resolved.vaultEntryPoints,
            driversDir: resolved.driversDir,
            allDriverFiles: resolved.allDriverFiles,
            driverEntryPoints: resolved.driverEntryPoints,
            datastoresDir: resolved.datastoresDir,
            allDatastoreFiles: resolved.allDatastoreFiles,
            datastoreEntryPoints: resolved.datastoreEntryPoints,
            reportsDir: resolved.reportsDir,
            allReportFiles: resolved.allReportFiles,
            reportEntryPoints: resolved.reportEntryPoints,
            workflowFiles: resolved.workflowFiles,
            skillDirs: resolved.skillDirs,
            allSkillFiles: resolved.allSkillFiles,
            includeFilePaths: resolved.includeFilePaths,
            additionalFilePaths: resolved.additionalFilePaths,
            binaryFilePaths: resolved.binaryFilePaths,
            dryRun: true,
            denoConfigPath,
          },
          hashInput: {
            manifest: resolved.manifest,
            modelFilePaths: resolved.allModelFiles,
            vaultFilePaths: resolved.allVaultFiles,
            driverFilePaths: resolved.allDriverFiles,
            datastoreFilePaths: resolved.allDatastoreFiles,
            reportFilePaths: resolved.allReportFiles,
            workflowFilePaths: resolved.workflowFiles.map((w) => w.sourcePath),
            additionalFilePaths: resolved.additionalFilePaths,
            binaryFilePaths: resolved.binaryFilePaths,
            skillFilePaths: resolved.allSkillFiles,
            includeFilePaths: resolved.includeFilePaths,
            denoConfigPath,
            packageJsonPath: undefined,
          },
        }),
        renderer.handlers(),
      );

      if (!renderer.passed()) {
        throw new UserError(renderer.failureMessage());
      }

      cliCtx.logger.debug`Extension quality command completed`;
    },
  );
