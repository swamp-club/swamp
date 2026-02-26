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
import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import { UserError } from "../../domain/errors.ts";
import { parseExtensionManifest } from "../../domain/extensions/extension_manifest.ts";
import { resolveLocalImports } from "../../domain/extensions/extension_import_resolver.ts";
import { resolveWorkflowDependencies } from "../../domain/extensions/extension_dependency_resolver.ts";
import { analyzeExtensionSafety } from "../../domain/extensions/extension_safety_analyzer.ts";
import { bundleExtension } from "../../domain/models/bundle.ts";
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

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

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
  .action(async function (options: AnyOptions, manifestPath: string) {
    const ctx = createContext(options as GlobalOptions, ["extension", "push"]);
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

    // 5. Resolve models dir
    const modelsDir = resolve(repoDir, "extensions/models");

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
    const workflowFiles: string[] = [];
    if (manifest.workflows.length > 0) {
      const workflowsDir = resolve(repoDir, "workflows");
      // Validate workflow files exist
      for (const wfRef of manifest.workflows) {
        const wfPath = resolve(workflowsDir, wfRef);
        try {
          await Deno.stat(wfPath);
        } catch {
          throw new UserError(
            `Workflow file not found: ${wfRef} (expected at ${wfPath})`,
          );
        }
        workflowFiles.push(wfPath);
      }

      // Also resolve models referenced by workflows
      const wfNames = manifest.workflows.map((wf) =>
        basename(wf, ".yaml").replace(/_/g, "-")
      );
      const depResult = await resolveWorkflowDependencies(wfNames, {
        workflowRepo: repoContext.workflowRepo,
        definitionRepo: repoContext.definitionRepo,
        modelsDir,
      });

      // Merge auto-resolved model files (dedup)
      const existingSet = new Set(allModelFiles);
      for (const mf of depResult.modelFiles) {
        if (!existingSet.has(mf)) {
          allModelFiles.push(mf);
          existingSet.add(mf);
        }
      }

      // Merge workflow files from dependency resolution
      const wfSet = new Set(workflowFiles);
      for (const wf of depResult.workflowFiles) {
        if (!wfSet.has(wf)) {
          workflowFiles.push(wf);
          wfSet.add(wf);
        }
      }
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
        modelFiles: allModelFiles.map((f) => relative(repoDir, f)),
        workflowFiles: workflowFiles.map((f) => relative(repoDir, f)),
        additionalFiles: additionalFilePaths.map((f) => relative(repoDir, f)),
        dependencies: manifest.dependencies,
      },
      ctx.outputMode,
    );

    // 11. Run safety analysis
    const allFiles = [
      ...allModelFiles,
      ...workflowFiles,
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
    const bundles = new Map<string, string>(); // entryPoint basename -> JS content
    const compilationErrors: CompilationError[] = [];

    for (const entryPoint of modelEntryPoints) {
      const entryName = basename(entryPoint, ".ts");
      try {
        const js = await bundleExtension(entryPoint, denoPath);
        bundles.set(entryName, js);
        ctx.logger.debug`Bundled ${entryName} (${js.length} bytes)`;
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
      await Deno.mkdir(join(extDir, "files"), { recursive: true });

      // Write normalized manifest
      await Deno.writeTextFile(
        join(extDir, "manifest.yaml"),
        stringifyYaml({
          manifestVersion: manifest.manifestVersion,
          name: manifest.name,
          version: manifest.version,
          description: manifest.description ?? "",
          models: manifest.models,
          workflows: manifest.workflows,
          additionalFiles: manifest.additionalFiles,
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

      // Write compiled bundles (flat)
      for (const [entryName, js] of bundles) {
        await Deno.writeTextFile(
          join(extDir, "bundles", `${entryName}.js`),
          js,
        );
      }

      // Copy workflow files
      for (const wfFile of workflowFiles) {
        const destPath = join(extDir, "workflows", basename(wfFile));
        await Deno.copyFile(wfFile, destPath);
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
        env: { GZIP: "-9" },
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

      // Phase 3: Confirm
      ctx.logger.debug("Confirming push...");
      const confirmResult = await extensionClient.confirmPush(
        pushMetadata,
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
