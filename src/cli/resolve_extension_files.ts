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

import { basename, dirname, isAbsolute, join, resolve } from "@std/path";
import type { Logger } from "@logtape/logtape";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import {
  RepoMarkerRepository,
} from "../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../domain/repo/repo_path.ts";
import { UserError } from "../domain/errors.ts";
import {
  type ExtensionManifest,
  isSafeRelativePath,
  parseExtensionManifest,
} from "../domain/extensions/extension_manifest.ts";
import { resolveLocalImports } from "../domain/extensions/extension_import_resolver.ts";
import { resolveWorkflowDependencies } from "../domain/extensions/extension_dependency_resolver.ts";
import { resolveModelsDir } from "./resolve_models_dir.ts";
import { resolveVaultsDir } from "./resolve_vaults_dir.ts";
import { resolveWorkflowsDir } from "./resolve_workflows_dir.ts";
import { resolveDriversDir } from "./resolve_drivers_dir.ts";
import { resolveDatastoresDir } from "./resolve_datastores_dir.ts";
import { resolveReportsDir } from "./resolve_reports_dir.ts";
import { SKILL_DIRS } from "../domain/repo/skill_dirs.ts";

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
  driversDir: string;
  driverEntryPoints: string[];
  allDriverFiles: string[];
  datastoresDir: string;
  datastoreEntryPoints: string[];
  allDatastoreFiles: string[];
  reportsDir: string;
  reportEntryPoints: string[];
  allReportFiles: string[];
  workflowFiles: Array<{ sourcePath: string; archiveName: string }>;
  skillDirs: Array<{ name: string; absolutePath: string }>;
  allSkillFiles: string[];
  includeFilePaths: string[];
  additionalFilePaths: string[];
}

/**
 * Normalize an additionalFiles entry so equivalent paths compare equal:
 * Unicode NFC form, forward slashes, collapse `./` segments, strip trailing
 * slash, case-fold. The NFC step ensures macOS APFS (decomposed) and Linux
 * ext4 (composed) don't mask true collisions.
 */
function normalizeAdditionalFileEntry(entry: string): string {
  const nfc = entry.normalize("NFC");
  const forwardSlashed = nfc.replace(/\\/g, "/");
  const segments = forwardSlashed.split("/").filter((s) =>
    s !== "." && s !== ""
  );
  return segments.join("/").toLowerCase();
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

  // 1b. Defensive path traversal check (belt-and-suspenders with Zod schema)
  const allManifestPaths = [
    ...manifest.models.map((p) => ({ field: "models", path: p })),
    ...manifest.workflows.map((p) => ({ field: "workflows", path: p })),
    ...manifest.vaults.map((p) => ({ field: "vaults", path: p })),
    ...manifest.drivers.map((p) => ({ field: "drivers", path: p })),
    ...manifest.datastores.map((p) => ({ field: "datastores", path: p })),
    ...manifest.reports.map((p) => ({ field: "reports", path: p })),
    ...manifest.skills.map((p) => ({ field: "skills", path: p })),
    ...manifest.include.map((p) => ({ field: "include", path: p })),
    ...manifest.additionalFiles.map((p) => ({
      field: "additionalFiles",
      path: p,
    })),
  ];
  for (const { field, path } of allManifestPaths) {
    if (!isSafeRelativePath(path)) {
      throw new UserError(
        `Manifest field '${field}' contains unsafe path: ${path}. ` +
          `Paths must be relative and must not contain '..' components or start with '/'.`,
      );
    }
  }

  // 2. Resolve models dir and vaults dir
  const repoPath = RepoPath.create(repoDir);
  const markerRepo = new RepoMarkerRepository();
  const marker = await markerRepo.read(repoPath);
  const modelsDir = resolve(repoDir, resolveModelsDir(marker));
  const vaultsDir = resolve(repoDir, resolveVaultsDir(marker));
  const driversDir = resolve(repoDir, resolveDriversDir(marker));
  const datastoresDir = resolve(repoDir, resolveDatastoresDir(marker));
  const reportsDir = resolve(repoDir, resolveReportsDir(marker));

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

  // 8. Collect driver files from manifest
  const driverEntryPoints: string[] = [];
  for (const driverRef of manifest.drivers) {
    const driverPath = resolve(driversDir, driverRef);
    try {
      await Deno.stat(driverPath);
    } catch {
      throw new UserError(
        `Driver file not found: ${driverRef} (expected at ${driverPath})`,
      );
    }
    driverEntryPoints.push(driverPath);
  }

  // 9. Resolve local imports for driver entry points
  const allDriverFiles: string[] = [];
  if (driverEntryPoints.length > 0) {
    const driverImportResult = await resolveLocalImports(
      driverEntryPoints,
      driversDir,
    );
    allDriverFiles.push(...driverImportResult.resolvedFiles);
  }

  // 10. Collect datastore files from manifest
  const datastoreEntryPoints: string[] = [];
  for (const datastoreRef of manifest.datastores) {
    const datastorePath = resolve(datastoresDir, datastoreRef);
    try {
      await Deno.stat(datastorePath);
    } catch {
      throw new UserError(
        `Datastore file not found: ${datastoreRef} (expected at ${datastorePath})`,
      );
    }
    datastoreEntryPoints.push(datastorePath);
  }

  // 11. Resolve local imports for datastore entry points
  const allDatastoreFiles: string[] = [];
  if (datastoreEntryPoints.length > 0) {
    const datastoreImportResult = await resolveLocalImports(
      datastoreEntryPoints,
      datastoresDir,
    );
    allDatastoreFiles.push(...datastoreImportResult.resolvedFiles);
  }

  // 12. Collect report files from manifest
  const reportEntryPoints: string[] = [];
  for (const reportRef of manifest.reports) {
    const reportPath = resolve(reportsDir, reportRef);
    try {
      await Deno.stat(reportPath);
    } catch {
      throw new UserError(
        `Report file not found: ${reportRef} (expected at ${reportPath})`,
      );
    }
    reportEntryPoints.push(reportPath);
  }

  // 13. Resolve local imports for report entry points
  const allReportFiles: string[] = [];
  if (reportEntryPoints.length > 0) {
    const reportImportResult = await resolveLocalImports(
      reportEntryPoints,
      reportsDir,
    );
    allReportFiles.push(...reportImportResult.resolvedFiles);
  }

  // 14. Resolve skill directories from manifest
  const skillDirs: Array<{ name: string; absolutePath: string }> = [];
  const allSkillFiles: string[] = [];
  if (manifest.skills.length > 0) {
    const tool = marker?.tool ?? "claude";
    const projectSkillDir = SKILL_DIRS[tool]
      ? resolve(repoDir, SKILL_DIRS[tool])
      : null;

    const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
    const globalSkillDir = home && SKILL_DIRS[tool]
      ? join(home, SKILL_DIRS[tool])
      : null;

    if (!projectSkillDir && !globalSkillDir) {
      throw new UserError(
        `Cannot package skills when tool is '${tool}'. Set a tool with: swamp repo upgrade --tool <claude|cursor|kiro|opencode|codex>`,
      );
    }

    for (const skillName of manifest.skills) {
      let skillPath: string | null = null;

      // Try project-local first
      if (projectSkillDir) {
        const candidate = join(projectSkillDir, skillName);
        try {
          const stat = await Deno.stat(candidate);
          if (stat.isDirectory) skillPath = candidate;
        } catch { /* not found here */ }
      }

      // Fall back to global
      if (!skillPath && globalSkillDir) {
        const candidate = join(globalSkillDir, skillName);
        try {
          const stat = await Deno.stat(candidate);
          if (stat.isDirectory) skillPath = candidate;
        } catch { /* not found here either */ }
      }

      if (!skillPath) {
        const locations = [projectSkillDir, globalSkillDir].filter(Boolean)
          .join(" and ");
        throw new UserError(
          `Skill directory not found: ${skillName} (looked in ${locations})`,
        );
      }

      skillDirs.push({ name: skillName, absolutePath: skillPath });

      // Recursively collect all files
      const collectSkillFiles = async (dir: string): Promise<void> => {
        for await (const entry of Deno.readDir(dir)) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory) {
            await collectSkillFiles(fullPath);
          } else if (entry.isFile) {
            allSkillFiles.push(fullPath);
          }
        }
      };
      await collectSkillFiles(skillPath);
    }
  }

  // 15. Validate include files (resolved relative to modelsDir)
  const includeFilePaths: string[] = [];
  for (const inc of manifest.include) {
    const incPath = resolve(modelsDir, inc);
    try {
      await Deno.stat(incPath);
    } catch {
      throw new UserError(
        `Include file not found: ${inc} (expected at ${incPath})`,
      );
    }
    includeFilePaths.push(incPath);
  }

  // 15. Validate additional files: uniqueness, symlink rejection, existence.
  const additionalFilePaths: string[] = [];
  const seenNormalized = new Map<string, string>();
  for (const af of manifest.additionalFiles) {
    const normalized = normalizeAdditionalFileEntry(af);
    const existing = seenNormalized.get(normalized);
    if (existing !== undefined) {
      throw new UserError(
        `Duplicate additionalFiles entries: "${existing}" and "${af}" ` +
          `resolve to the same archive path (case-insensitive, normalized). ` +
          `Remove one entry from the manifest, or rename the file.`,
      );
    }
    seenNormalized.set(normalized, af);

    const afPath = resolve(dirname(absoluteManifestPath), af);
    let info: Deno.FileInfo;
    try {
      info = await Deno.lstat(afPath);
    } catch {
      throw new UserError(
        `Additional file not found: ${af} (expected at ${afPath})`,
      );
    }
    if (info.isSymlink) {
      throw new UserError(
        `Additional file is a symlink: ${af} (at ${afPath}). ` +
          `Symlinks in additionalFiles are rejected to prevent archive ` +
          `bloat and path escapes — copy the target file into the ` +
          `extension tree instead.`,
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
    driversDir,
    driverEntryPoints,
    allDriverFiles,
    datastoresDir,
    datastoreEntryPoints,
    allDatastoreFiles,
    reportsDir,
    reportEntryPoints,
    allReportFiles,
    workflowFiles,
    skillDirs,
    allSkillFiles,
    includeFilePaths,
    additionalFilePaths,
  };
}
