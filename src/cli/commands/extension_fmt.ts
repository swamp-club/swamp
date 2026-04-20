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
  consumeStream,
  createExtensionFmtDeps,
  createLibSwampContext,
  extensionFmt,
} from "../../libswamp/mod.ts";
import { createExtensionFmtRenderer } from "../../presentation/renderers/extension_fmt.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { resolveExtensionFiles } from "../resolve_extension_files.ts";
import { UserError } from "../../domain/errors.ts";

interface ExtensionFmtOptions extends GlobalOptions {
  repoDir?: string;
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
  .option("--check", "Check only, do not auto-fix")
  .action(async function (options: ExtensionFmtOptions, manifestPath: string) {
    const cliCtx = createContext(options, ["extension", "fmt"]);
    cliCtx.logger.debug`Starting extension fmt`;

    // 1. Validate repo
    const repoDir = resolveRepoDir(options.repoDir);
    const { repoContext } = await requireInitializedRepo({
      repoDir,
      outputMode: cliCtx.outputMode,
    });

    // 2. Resolve extension files (manifest, models, workflows, additional files)
    const {
      allModelFiles,
      allVaultFiles,
      allDriverFiles,
      allDatastoreFiles,
      allReportFiles,
      additionalFilePaths,
    } = await resolveExtensionFiles({
      repoDir,
      manifestPath,
      repoContext,
      logger: cliCtx.logger,
    });

    // 3. Combine all files and filter to .ts
    const allFiles = [
      ...allModelFiles,
      ...allVaultFiles,
      ...allDriverFiles,
      ...allDatastoreFiles,
      ...allReportFiles,
      ...additionalFilePaths,
    ];
    const tsFiles = allFiles.filter((f) => f.endsWith(".ts"));

    // 4. Create deps, input, renderer and run generator
    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = await createExtensionFmtDeps();
    const renderer = createExtensionFmtRenderer(cliCtx.outputMode);

    await consumeStream(
      extensionFmt(ctx, deps, { tsFiles, check: options.check ?? false }),
      renderer.handlers(),
    );

    // 5. Throw if quality checks failed
    if (!renderer.passed()) {
      throw new UserError(renderer.failureMessage());
    }

    cliCtx.logger.debug`Extension fmt command completed`;
  });
