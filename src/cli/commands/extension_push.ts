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

import { Command } from "@cliffy/command";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { resolveModelsDir } from "../resolve_models_dir.ts";
import { resolveVaultsDir } from "../resolve_vaults_dir.ts";
import { resolveWorkflowsDir } from "../resolve_workflows_dir.ts";
import {
  RepoMarkerRepository,
} from "../../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import { UserError } from "../../domain/errors.ts";
import { parseExtensionManifest } from "../../domain/extensions/extension_manifest.ts";
import { resolveLocalImports } from "../../domain/extensions/extension_import_resolver.ts";
import { resolveWorkflowDependencies } from "../../domain/extensions/extension_dependency_resolver.ts";
import { analyzeExtensionSafety } from "../../domain/extensions/extension_safety_analyzer.ts";
import { bundleExtension } from "../../domain/models/bundle.ts";
import type { ExtensionContentMetadata } from "../../domain/extensions/extension_content.ts";
import { extractContentMetadata } from "../../domain/extensions/extension_content_extractor.ts";
import { EmbeddedDenoRuntime } from "../../infrastructure/runtime/embedded_deno_runtime.ts";
import { ExtensionApiClient } from "../../infrastructure/http/extension_api_client.ts";
import { CalVer } from "../../domain/models/calver.ts";
import {
  type CompilationError,
  renderExtensionPush,
  renderExtensionPushCancelled,
  renderExtensionPushCompilationErrors,
  renderExtensionPushDryRun,
  renderExtensionPushResolved,
  renderExtensionPushSafetyErrors,
  renderExtensionPushSafetyWarnings,
} from "../../presentation/output/extension_push_output.ts";

interface ExtensionPushOptions extends GlobalOptions {
  repoDir: string;
  yes?: boolean;
  dryRun?: boolean;
}

async function promptConfirmation(message: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  await Deno.stdout.write(encoder.encode(`${message} [y/N] `));

  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  if (n === null) return false;

  const response = decoder.decode(buf.subarray(0, n)).trim().toLowerCase();
  return response === "y" || response === "yes";
}

export const extensionPushCommand = new Command()
  .name("push")
  .description("Push an extension to the swamp registry")
  .arguments("<manifest-path:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("-y, --yes", "Skip confirmation prompts")
  .option("--dry-run", "Build archive locally without pushing to registry")
  .action(async function (options: ExtensionPushOptions, manifestPath: string) {
    const ctx = createContext(options, ["extension", "push"]);
    ctx.logger.debug`Starting extension push`;

    // 1. Validate repo
    const repoDir = options.repoDir ?? ".";
    const { repoContext } = await requireInitializedRepo({
      repoDir,
      outputMode: ctx.outputMode,
    });

    // 2. Read and parse manifest (before auth so validation errors surface first)
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

    // 3. Load auth credentials
    const authRepo = new AuthRepository();
    const credentials = await authRepo.load();
    if (!credentials) {
      throw new UserError(
        "Not authenticated. Run 'swamp auth login' first.",
      );
    }

    // 4. Validate namespace matches username
    const namespacePart = manifest.name.slice(1, manifest.name.indexOf("/"));
    if (namespacePart !== credentials.username) {
      if (ctx.outputMode === "json") {
        throw new UserError(
          `Extension namespace "@${namespacePart}" does not match authenticated user "${credentials.username}". ` +
            `Use "@${credentials.username}/${
              manifest.name.split("/")[1]
            }" instead.`,
        );
      }
      const suggested = `@${credentials.username}/${
        manifest.name.split("/")[1]
      }`;
      const confirmed = await promptConfirmation(
        `Extension namespace "@${namespacePart}" does not match your username "${credentials.username}". ` +
          `Would you like to push as "${suggested}" instead?`,
      );
      if (!confirmed) {
        renderExtensionPushCancelled(ctx.outputMode);
        return;
      }
      // Update name for the push
      manifest.name = suggested;
    }

    // 5. Resolve models dir and vaults dir
    const repoPath = RepoPath.create(repoDir);
    const markerRepo = new RepoMarkerRepository();
    const marker = await markerRepo.read(repoPath);
    const modelsDir = resolve(repoDir, resolveModelsDir(marker));
    const vaultsDir = resolve(repoDir, resolveVaultsDir(marker));

    // 6. Collect model files from manifest
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

    // 7. Resolve local imports for each model entry point
    const importResult = await resolveLocalImports(modelEntryPoints, modelsDir);
    const allModelFiles = [...importResult.resolvedFiles];

    // 8. Resolve workflow dependencies if workflows present
    const workflowFiles: Array<{ sourcePath: string; archiveName: string }> =
      [];
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
          ctx.logger.debug`Skipping auto-resolved model (not found): ${mf}`;
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

    // 9a. Collect vault files from manifest
    const vaultEntryPoints: string[] = [];
    const allVaultFiles: string[] = [];
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

    // Resolve local imports for vault entry points
    if (vaultEntryPoints.length > 0) {
      const vaultImportResult = await resolveLocalImports(
        vaultEntryPoints,
        vaultsDir,
      );
      allVaultFiles.push(...vaultImportResult.resolvedFiles);
    }

    // 9. Validate additional files
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

    // 10. Show resolved bundle contents
    renderExtensionPushResolved(
      {
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        repository: manifest.repository,
        modelFiles: allModelFiles.map((f) => relative(repoDir, f)),
        workflowFiles: workflowFiles.map((wf) =>
          relative(repoDir, wf.sourcePath)
        ),
        vaultFiles: allVaultFiles.map((f) => relative(repoDir, f)),
        additionalFiles: additionalFilePaths.map((f) => relative(repoDir, f)),
        platforms: manifest.platforms,
        labels: manifest.labels,
        dependencies: manifest.dependencies,
      },
      ctx.outputMode,
    );

    // 11. Run safety analysis
    const allFiles = [
      ...allModelFiles,
      ...allVaultFiles,
      ...workflowFiles.map((wf) => wf.sourcePath),
      ...additionalFilePaths,
    ];
    const safetyResult = await analyzeExtensionSafety(allFiles);

    if (safetyResult.errors.length > 0) {
      renderExtensionPushSafetyErrors(safetyResult.errors, ctx.outputMode);
      throw new UserError(
        "Extension has safety errors that must be resolved before pushing.",
      );
    }

    if (safetyResult.warnings.length > 0) {
      renderExtensionPushSafetyWarnings(safetyResult.warnings, ctx.outputMode);
      if (!options.yes && ctx.outputMode === "log") {
        const confirmed = await promptConfirmation(
          "Continue with push despite warnings?",
        );
        if (!confirmed) {
          renderExtensionPushCancelled(ctx.outputMode);
          return;
        }
      }
    }

    // 12. Bundle each model entry point
    const denoRuntime = new EmbeddedDenoRuntime();
    const denoPath = await denoRuntime.ensureDeno();
    const bundles = new Map<string, string>(); // relative path (no ext) -> JS
    const compilationErrors: CompilationError[] = [];

    for (const entryPoint of modelEntryPoints) {
      // Use relative path from modelsDir to avoid collisions with nested
      // paths (e.g. aws/ec2/instance.ts and aws/ecs/instance.ts).
      const entryName = relative(modelsDir, entryPoint).replace(/\.ts$/, "");
      try {
        const js = await bundleExtension(entryPoint, denoPath);
        bundles.set(entryName, js);
        ctx.logger.debug`Bundled ${entryName} (${js.length} bytes)`;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        compilationErrors.push({ file: entryPoint, error: msg });
      }
    }

    // Bundle vault entry points
    const vaultBundles = new Map<string, string>();
    for (const entryPoint of vaultEntryPoints) {
      const entryName = relative(vaultsDir, entryPoint).replace(/\.ts$/, "");
      try {
        const js = await bundleExtension(entryPoint, denoPath);
        vaultBundles.set(entryName, js);
        ctx.logger.debug`Bundled vault ${entryName} (${js.length} bytes)`;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        compilationErrors.push({ file: entryPoint, error: msg });
      }
    }

    if (compilationErrors.length > 0) {
      renderExtensionPushCompilationErrors(
        compilationErrors,
        ctx.outputMode,
      );
      throw new UserError(
        "Bundle compilation failed. Fix the errors above and try again.",
      );
    }

    // 12b. Extract content metadata for registry (non-fatal)
    let contentMetadata: ExtensionContentMetadata | undefined;
    try {
      contentMetadata = await extractContentMetadata(
        allModelFiles,
        modelsDir,
        workflowFiles,
      );
      ctx.logger
        .debug`Extracted content metadata: ${contentMetadata.models.length} models, ${contentMetadata.workflows.length} workflows`;
    } catch {
      ctx.logger.debug`Content metadata extraction failed, skipping`;
    }

    // 13. Pre-flight version check (skip in dry-run)
    if (!options.dryRun) {
      const extensionClient = new ExtensionApiClient(credentials.serverUrl);
      const latest = await extensionClient.getLatestVersion(
        manifest.name,
        credentials.apiKey,
      );

      if (latest) {
        if (latest.version === manifest.version) {
          if (ctx.outputMode === "log" && !options.yes) {
            const bumped = CalVer.bump(CalVer.create(latest.version));
            const confirmed = await promptConfirmation(
              `Version ${manifest.version} already exists. Bump to ${bumped.value}?`,
            );
            if (confirmed) {
              manifest.version = bumped.value;
            } else {
              renderExtensionPushCancelled(ctx.outputMode);
              return;
            }
          } else {
            throw new UserError(
              `Version ${manifest.version} already exists for ${manifest.name}. ` +
                `Use a different version or let the CLI bump it interactively.`,
            );
          }
        }
      }
    }

    // 14. Build tar.gz archive
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_ext_" });
    let archiveBytes: Uint8Array;

    try {
      // Create archive directory structure
      const extDir = join(tmpDir, "extension");
      await Deno.mkdir(join(extDir, "models"), { recursive: true });
      await Deno.mkdir(join(extDir, "bundles"), { recursive: true });
      await Deno.mkdir(join(extDir, "workflows"), { recursive: true });
      await Deno.mkdir(join(extDir, "vaults"), { recursive: true });
      await Deno.mkdir(join(extDir, "vault-bundles"), { recursive: true });
      await Deno.mkdir(join(extDir, "files"), { recursive: true });

      // Write normalized manifest
      await Deno.writeTextFile(
        join(extDir, "manifest.yaml"),
        stringifyYaml({
          manifestVersion: manifest.manifestVersion,
          name: manifest.name,
          version: manifest.version,
          description: manifest.description ?? "",
          ...(manifest.repository ? { repository: manifest.repository } : {}),
          models: manifest.models,
          workflows: manifest.workflows,
          vaults: manifest.vaults,
          additionalFiles: manifest.additionalFiles,
          ...(manifest.platforms.length > 0
            ? { platforms: manifest.platforms }
            : {}),
          ...(manifest.labels.length > 0 ? { labels: manifest.labels } : {}),
          dependencies: manifest.dependencies,
        }),
      );

      // Copy model source files (preserving relative paths from modelsDir)
      for (const modelFile of allModelFiles) {
        const relPath = relative(modelsDir, modelFile);
        const destPath = join(extDir, "models", relPath);
        await Deno.mkdir(dirname(destPath), { recursive: true });
        await Deno.copyFile(modelFile, destPath);
      }

      // Write compiled bundles (preserving relative paths from modelsDir)
      for (const [entryName, js] of bundles) {
        const destPath = join(extDir, "bundles", `${entryName}.js`);
        await Deno.mkdir(dirname(destPath), { recursive: true });
        await Deno.writeTextFile(destPath, js);
      }

      // Copy workflow files using unique archive names
      for (const wf of workflowFiles) {
        const destPath = join(extDir, "workflows", wf.archiveName);
        await Deno.copyFile(wf.sourcePath, destPath);
      }

      // Copy vault source files (preserving relative paths from vaultsDir)
      for (const vaultFile of allVaultFiles) {
        const relPath = relative(vaultsDir, vaultFile);
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

      // Copy additional files
      for (const af of additionalFilePaths) {
        const destPath = join(extDir, "files", basename(af));
        await Deno.copyFile(af, destPath);
      }

      // Create tar.gz using the `tar` command with max compression
      const tarPath = join(tmpDir, "extension.tar.gz");
      const tarCommand = new Deno.Command("tar", {
        args: ["-czf", tarPath, "-C", tmpDir, "extension"],
        stdout: "piped",
        stderr: "piped",
        env: { GZIP: "-9", COPYFILE_DISABLE: "1" },
      });
      const tarOutput = await tarCommand.output();
      if (!tarOutput.success) {
        const stderr = new TextDecoder().decode(tarOutput.stderr);
        throw new UserError(`Failed to create archive: ${stderr}`);
      }

      archiveBytes = await Deno.readFile(tarPath);

      // Verify gzip magic bytes
      if (archiveBytes[0] !== 0x1F || archiveBytes[1] !== 0x8B) {
        throw new UserError(
          "Archive creation failed: output is not a valid gzip file.",
        );
      }

      ctx.logger.debug`Archive created: ${archiveBytes.length} bytes`;

      // 15. Dry run — stop here
      if (options.dryRun) {
        renderExtensionPushDryRun(
          {
            name: manifest.name,
            version: manifest.version,
            archiveSize: archiveBytes.length,
          },
          ctx.outputMode,
        );
        return;
      }

      // 16. Confirmation prompt
      if (!options.yes && ctx.outputMode === "log") {
        const confirmed = await promptConfirmation(
          `Push ${manifest.name}@${manifest.version} to registry?`,
        );
        if (!confirmed) {
          renderExtensionPushCancelled(ctx.outputMode);
          return;
        }
      }

      // 17. Three-phase push
      const extensionClient = new ExtensionApiClient(credentials.serverUrl);
      const pushMetadata = {
        name: manifest.name,
        version: manifest.version,
        description: manifest.description ?? "",
        dependencies: manifest.dependencies,
        platforms: manifest.platforms,
        labels: manifest.labels,
        repository: manifest.repository || undefined,
      };

      // Phase 1: Initiate
      ctx.logger.debug("Initiating push...");
      const initResult = await extensionClient.initiatePush(
        pushMetadata,
        credentials.apiKey,
      );

      // Phase 2: Upload archive to S3
      ctx.logger.debug("Uploading archive...");
      await extensionClient.uploadArchive(
        initResult.uploadUrl,
        archiveBytes,
      );

      // Phase 3: Confirm (include content metadata)
      ctx.logger.debug("Confirming push...");
      const confirmResult = await extensionClient.confirmPush(
        { ...pushMetadata, contentMetadata },
        credentials.apiKey,
      );

      // 18. Render success
      renderExtensionPush(
        {
          name: confirmResult.name,
          version: confirmResult.version,
          extensionId: confirmResult.extensionId,
          archiveSize: archiveBytes.length,
          modelCount: allModelFiles.length,
          workflowCount: workflowFiles.length,
          bundleCount: bundles.size,
          vaultCount: allVaultFiles.length,
        },
        ctx.outputMode,
      );
    } finally {
      // 19. Cleanup temp dir
      try {
        await Deno.remove(tmpDir, { recursive: true });
      } catch {
        // Best-effort cleanup
      }
    }
  });
