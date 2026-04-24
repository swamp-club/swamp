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
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import {
  consumeStream,
  createLibSwampContext,
  extensionInstall,
} from "../../libswamp/mod.ts";
import { UserError } from "../../domain/errors.ts";
import { createExtensionInstallRenderer } from "../../presentation/renderers/extension_install.ts";
import { createExtensionInstallDeps } from "../create_extension_install_deps.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const extensionInstallCommand = new Command()
  .name("install")
  .description(
    "Restore pulled extensions from the lockfile.\n\nReads upstream_extensions.json and re-pulls any extensions whose source\nfiles are missing. Use after cloning a repo or in CI.\nTo add a new extension, use 'swamp extension pull <name>' instead.",
  )
  .example("Restore extensions from lockfile", "swamp extension install")
  .arguments("[unexpected:string]")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions, unexpected?: string) {
    if (unexpected) {
      throw new UserError(
        `'swamp extension install' takes no arguments.\n` +
          `To add a new extension, use: swamp extension pull ${unexpected}`,
      );
    }

    const cliCtx = createContext(options as GlobalOptions, [
      "extension",
      "install",
    ]);
    cliCtx.logger.debug`Starting extension install`;

    const repoDir = resolveRepoDir(options.repoDir);
    await requireInitializedRepo({
      repoDir,
      outputMode: cliCtx.outputMode,
    });

    const deps = await createExtensionInstallDeps(repoDir, cliCtx.logger);

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const renderer = createExtensionInstallRenderer(cliCtx.outputMode);

    await consumeStream(
      extensionInstall(ctx, deps),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Extension install command completed");
  });
