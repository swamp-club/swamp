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
import {
  createExtensionFmtDeps,
  extensionFmt,
} from "../../libswamp/extensions/fmt.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import { createExtensionFmtRenderer } from "../../presentation/renderers/extension_fmt.ts";
import {
  createContext,
  type GlobalOptions,
  resolveExtensionsDir,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import { resolveManifestArgument } from "../resolve_manifest_path.ts";
import {
  findDenoConfig,
  isPulledExtensionManifest,
  projectConfigBoundary,
  resolveExtensionFiles,
} from "../resolve_extension_files.ts";
import { UserError } from "../../domain/errors.ts";

interface ExtensionFmtOptions extends GlobalOptions {
  repoDir?: string;
  extensionsDir?: string;
  check?: boolean;
}

export const extensionFmtCommand = new Command()
  .name("fmt")
  .description("Format and lint extension TypeScript files")
  .example(
    "Format extension files",
    "swamp extension fmt extensions/models/my-model/manifest.json",
  )
  .example(
    "Check formatting",
    "swamp extension fmt extensions/models/my-model/manifest.json --check",
  )
  .arguments("<manifest-path:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option(
    "--extensions-dir <dir:string>",
    "Extensions root: the directory that contains extensions/ (models, workflows and skills resolve from it; env: SWAMP_EXTENSIONS_DIR)",
  )
  .option("--check", "Check only, do not auto-fix")
  .action(async function (options: ExtensionFmtOptions, manifestPath: string) {
    const cliCtx = createContext(options, ["extension", "fmt"]);
    cliCtx.logger.debug`Starting extension fmt`;

    const repoDir = resolveRepoDir(options.repoDir);
    const extensionsDir = resolveExtensionsDir(options.extensionsDir);
    const { absoluteManifestPath } = await resolveManifestArgument({
      argument: manifestPath,
      cwd: Deno.cwd(),
      repoDir,
      extensionsDir,
    });
    if (isPulledExtensionManifest(repoDir, absoluteManifestPath)) {
      throw new UserError(
        "Cannot run fmt on a pulled extension. Pulled extensions are read-only " +
          "copies from the registry. To format a local extension, point at its manifest " +
          "under your extensions/ directory instead.",
      );
    }

    const { repoContext } = await requireInitializedRepoReadOnly({
      repoDir,
      outputMode: cliCtx.outputMode,
    });
    const {
      allModelFiles,
      allVaultFiles,
      allDatastoreFiles,
      allReportFiles,
      allWebhookFiles,
      additionalFilePaths,
      extensionsRoot,
    } = await resolveExtensionFiles({
      repoDir,
      manifestPath: absoluteManifestPath,
      repoContext,
      logger: cliCtx.logger,
      extensionsDir,
    });

    // 3. Combine all files and filter to .ts
    const allFiles = [
      ...allModelFiles,
      ...allVaultFiles,
      ...allDatastoreFiles,
      ...allReportFiles,
      ...allWebhookFiles,
      ...additionalFilePaths,
    ];
    const tsFiles = allFiles.filter((f) => f.endsWith(".ts"));

    // The project deno.json, found the way push finds it, so fmt and push
    // format and lint under the same rules.
    const manifestDir = dirname(absoluteManifestPath);
    const denoConfigPath = await findDenoConfig(
      manifestDir,
      projectConfigBoundary(manifestDir, extensionsRoot, repoDir),
    );

    // 4. Create deps, input, renderer and run generator
    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = await createExtensionFmtDeps();
    const renderer = createExtensionFmtRenderer(cliCtx.outputMode);

    await consumeStream(
      extensionFmt(ctx, deps, {
        tsFiles,
        check: options.check ?? false,
        denoConfigPath,
      }),
      renderer.handlers(),
    );

    // 5. Throw if quality checks failed
    if (!renderer.passed()) {
      throw new UserError(renderer.failureMessage());
    }

    cliCtx.logger.debug`Extension fmt command completed`;
  });
