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

import { basename, dirname, isAbsolute, resolve } from "@std/path";
import type { Logger } from "@logtape/logtape";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import {
  RepoMarkerRepository,
} from "../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../domain/repo/repo_path.ts";
import { UserError } from "../domain/errors.ts";
import {
  type ExtensionManifest,
  parseExtensionManifest,
} from "../domain/extensions/extension_manifest.ts";
import { resolveLocalImports } from "../domain/extensions/extension_import_resolver.ts";
import { resolveWorkflowDependencies } from "../domain/extensions/extension_dependency_resolver.ts";
import { resolveModelsDir } from "./resolve_models_dir.ts";
import { resolveVaultsDir } from "./resolve_vaults_dir.ts";
import { resolveWorkflowsDir } from "./resolve_workflows_dir.ts";

export interface ResolveExtensionFilesContext {
  repoDir: string;
  manifestPath: string;
  repoContext: RepositoryContext;
  logger: Logger;
}

export interface ResolvedExtensionFiles {
  manifest: ExtensionManifest;
  absoluteManifestPath: string;
  modelsDir: string;
  modelEntryPoints: string[];
  allModelFiles: string[];
  vaultsDir: string;
  vaultEntryPoints: string[];
  allVaultFiles: string[];
  workflowFiles: Array<{ sourcePath: string; archiveName: string }>;
  additionalFilePaths: string[];
}

export async function resolveExtensionFiles(
  ctx: ResolveExtensionFilesContext,
): Promise<ResolvedExtensionFiles> {
  const { repoDir, manifestPath, repoContext, logger } = ctx;

  // 1. Read and parse manifest
  const absoluteManifestPath = isAbsolute(manifestPath)
    ? manifestPath
    : resolve(repoDir, manifestPath);

  let manifestContent: string;
  try {
    manifestContent = await Deno.readTextFile(absoluteManifestPath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new UserError(
        `Manifest file not found: ${absoluteManifestPath}`,
      );
    }
    throw error;
  }

  const manifest = parseExtensionManifest(manifestContent);

  // 2. Resolve models dir and vaults dir
  const repoPath = RepoPath.create(repoDir);
  const markerRepo = new RepoMarkerRepository();
  const marker = await markerRepo.read(repoPath);
  const modelsDir = resolve(repoDir, resolveModelsDir(marker));
  const vaultsDir = resolve(repoDir, resolveVaultsDir(marker));

  // 3. Collect model files from manifest
  const modelEntryPoints: string[] = [];
  for (const modelRef of manifest.models) {
    const modelPath = resolve(modelsDir, modelRef);
    try {
      await Deno.stat(modelPath);
    } catch {
      throw new UserError(
        `Model file not found: ${modelRef} (expected at ${modelPath})`,
      );
    }
    modelEntryPoints.push(modelPath);
  }

  // 4. Resolve local imports for each model entry point
  const importResult = await resolveLocalImports(modelEntryPoints, modelsDir);
  const allModelFiles = [...importResult.resolvedFiles];

  // 5. Resolve workflow dependencies if workflows present
  const workflowFiles: Array<{ sourcePath: string; archiveName: string }> = [];
  if (manifest.workflows.length > 0) {
    const indexerWorkflowsDir = resolve(repoDir, "workflows");
    const extensionWorkflowsDir = resolve(
      repoDir,
      resolveWorkflowsDir(marker),
    );
    // Validate workflow files exist and resolve symlinks
    const wfNames: string[] = [];
    for (const wfRef of manifest.workflows) {
      let realPath: string | null = null;

      // Try indexer symlinks first (workflows/)
      try {
        realPath = await Deno.realPath(resolve(indexerWorkflowsDir, wfRef));
      } catch { /* not found here */ }

      // Fall back to extension workflows dir
      if (!realPath) {
        try {
          realPath = await Deno.realPath(
            resolve(extensionWorkflowsDir, wfRef),
          );
        } catch { /* not found here either */ }
      }

      if (!realPath) {
        throw new UserError(
          `Workflow file not found: ${wfRef} (looked in ${indexerWorkflowsDir} and ${extensionWorkflowsDir})`,
        );
      }
      // Derive a unique archive name from the manifest reference directory
      // e.g. "namespace-debug/workflow.yaml" → "namespace-debug.yaml"
      const refDir = dirname(wfRef);
      const archiveName = refDir !== "."
        ? `${refDir.replace(/\//g, "-")}.yaml`
        : basename(realPath);
      workflowFiles.push({ sourcePath: realPath, archiveName });
      wfNames.push(
        refDir !== "."
          ? refDir.replace(/_/g, "-")
          : basename(wfRef, ".yaml").replace(/_/g, "-"),
      );
    }

    // Also resolve models referenced by workflows
    const depResult = await resolveWorkflowDependencies(wfNames, {
      workflowRepo: repoContext.workflowRepo,
      definitionRepo: repoContext.definitionRepo,
      modelsDir,
    });

    // Merge auto-resolved model files (dedup, skip non-existent)
    const existingSet = new Set(allModelFiles);
    for (const mf of depResult.modelFiles) {
      if (existingSet.has(mf)) continue;
      try {
        await Deno.stat(mf);
        allModelFiles.push(mf);
        existingSet.add(mf);
      } catch {
        // Model source not at conventional path — it may already be
        // included in the manifest under a different filename.
        logger.debug`Skipping auto-resolved model (not found): ${mf}`;
      }
    }

    // Merge workflow files from dependency resolution.
    // Use realPath on dep-resolver paths so they match the manifest paths
    // (which were already realPath'd). Without this, symlinks in the repo
    // path itself (e.g. /tmp → /private/tmp on macOS) cause mismatches.
    const wfSet = new Set(workflowFiles.map((wf) => wf.sourcePath));
    for (const wf of depResult.workflowFiles) {
      let realWf: string;
      try {
        realWf = await Deno.realPath(wf);
      } catch {
        continue; // Skip if the file doesn't exist
      }
      if (!wfSet.has(realWf)) {
        workflowFiles.push({
          sourcePath: realWf,
          archiveName: basename(realWf),
        });
        wfSet.add(realWf);
      }
    }
  }

  // 6. Collect vault files from manifest
  const vaultEntryPoints: string[] = [];
  for (const vaultRef of manifest.vaults) {
    const vaultPath = resolve(vaultsDir, vaultRef);
    try {
      await Deno.stat(vaultPath);
    } catch {
      throw new UserError(
        `Vault file not found: ${vaultRef} (expected at ${vaultPath})`,
      );
    }
    vaultEntryPoints.push(vaultPath);
  }

  // 7. Resolve local imports for vault entry points
  const allVaultFiles: string[] = [];
  if (vaultEntryPoints.length > 0) {
    const vaultImportResult = await resolveLocalImports(
      vaultEntryPoints,
      vaultsDir,
    );
    allVaultFiles.push(...vaultImportResult.resolvedFiles);
  }

  // 8. Validate additional files
  const additionalFilePaths: string[] = [];
  for (const af of manifest.additionalFiles) {
    const afPath = resolve(dirname(absoluteManifestPath), af);
    try {
      await Deno.stat(afPath);
    } catch {
      throw new UserError(
        `Additional file not found: ${af} (expected at ${afPath})`,
      );
    }
    additionalFilePaths.push(afPath);
  }

  return {
    manifest,
    absoluteManifestPath,
    modelsDir,
    modelEntryPoints,
    allModelFiles,
    vaultsDir,
    vaultEntryPoints,
    allVaultFiles,
    workflowFiles,
    additionalFilePaths,
  };
}
