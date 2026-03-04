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
import { basename, dirname, join, relative } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { resolveExtensionFiles } from "../resolve_extension_files.ts";
import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import { UserError } from "../../domain/errors.ts";
import { analyzeExtensionSafety } from "../../domain/extensions/extension_safety_analyzer.ts";
import { checkExtensionQuality } from "../../domain/extensions/extension_quality_checker.ts";
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
  renderExtensionPushNamespaceErrors,
  renderExtensionPushQualityErrors,
  renderExtensionPushResolved,
  renderExtensionPushSafetyErrors,
  renderExtensionPushSafetyWarnings,
} from "../../presentation/output/extension_push_output.ts";
import { validateContentNamespaces } from "../../domain/extensions/extension_namespace_validator.ts";

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

    // 2. Resolve extension files (manifest, models, workflows, additional files)
    const resolved = await resolveExtensionFiles({
      repoDir,
      manifestPath,
      repoContext,
      logger: ctx.logger,
    });
    const {
      manifest,
      modelsDir,
      modelEntryPoints,
      allModelFiles,
      vaultsDir,
      vaultEntryPoints,
      allVaultFiles,
      workflowFiles,
      additionalFilePaths,
    } = resolved;

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

    // 9b. Extract content metadata early (for display and later registry push)
    let contentMetadata: ExtensionContentMetadata | undefined;
    try {
      contentMetadata = await extractContentMetadata(
        allModelFiles,
        modelsDir,
        workflowFiles,
        allVaultFiles,
        vaultsDir,
      );
      ctx.logger
        .debug`Extracted content metadata: ${contentMetadata.models.length} models, ${contentMetadata.workflows.length} workflows, ${contentMetadata.vaults.length} vaults`;
    } catch {
      ctx.logger.debug`Content metadata extraction failed, skipping`;
    }

    // 9c. Validate content namespaces
    if (contentMetadata) {
      const namespaceResult = validateContentNamespaces(
        manifest.name,
        contentMetadata,
      );
      if (!namespaceResult.valid) {
        const slashIndex = manifest.name.indexOf("/");
        const expectedNamespace = manifest.name.slice(0, slashIndex + 1);
        renderExtensionPushNamespaceErrors(
          expectedNamespace,
          namespaceResult.mismatches,
          ctx.outputMode,
        );
        throw new UserError(
          "Extension content uses namespaces that don't match the extension package. " +
            "All model types, vault types, and workflow names must use the same namespace as the extension.",
        );
      }
    }

    // 10. Show resolved bundle contents (use extracted metadata for richer display)
    // Build lookup maps keyed by the relative path from models/vaults dir
    // to avoid false matches when files share a suffix (e.g. instance.ts).
    const extractedModelsByFile = new Map(
      (contentMetadata?.models ?? []).map((m) => [m.fileName, m]),
    );
    const extractedVaultsByFile = new Map(
      (contentMetadata?.vaults ?? []).map((v) => [v.fileName, v]),
    );

    const resolvedModels = allModelFiles.map((f) => {
      const relPath = relative(repoDir, f);
      const extracted = extractedModelsByFile.get(relative(modelsDir, f));
      return {
        type: extracted?.type ?? relPath,
        fileName: relPath,
        globalArguments: extracted?.globalArguments,
      };
    });
    const resolvedVaults = allVaultFiles.map((f) => {
      const relPath = relative(repoDir, f);
      const extracted = extractedVaultsByFile.get(relative(vaultsDir, f));
      return {
        type: extracted?.type ?? relPath,
        fileName: relPath,
        name: extracted?.name,
        hasConfigSchema: extracted?.hasConfigSchema,
        configFields: extracted?.configFields,
      };
    });

    renderExtensionPushResolved(
      {
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        repository: manifest.repository,
        models: resolvedModels,
        workflowFiles: workflowFiles.map((wf) =>
          relative(repoDir, wf.sourcePath)
        ),
        vaults: resolvedVaults,
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

    // 11b. Resolve deno binary (reused by quality check + bundling)
    const denoRuntime = new EmbeddedDenoRuntime();
    const denoPath = await denoRuntime.ensureDeno();

    // 11c. Quality checks (formatting + lint)
    const qualityResult = await checkExtensionQuality(allFiles, denoPath);
    if (!qualityResult.passed) {
      renderExtensionPushQualityErrors(qualityResult.issues, ctx.outputMode);
      throw new UserError(
        "Extension has formatting or lint issues. Run 'swamp extension fmt <manifest-path>' to fix.",
      );
    }

    // 12. Bundle each model entry point
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
