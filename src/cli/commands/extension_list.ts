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
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import { join, resolve } from "@std/path";
import {
  consumeStream,
  createExtensionListDeps,
  createLibSwampContext,
  extensionList,
  warnLegacyExtensionLayout,
} from "../../libswamp/mod.ts";
import { resolveModelsDir } from "../resolve_models_dir.ts";
import {
  RepoMarkerRepository,
} from "../../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { createExtensionListRenderer } from "../../presentation/renderers/extension_list.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const extensionListCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List upstream installed extensions")
  .example("List installed extensions", "swamp extension list")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "extension",
      "list",
    ]);
    cliCtx.logger.debug`Starting extension list`;

    const repoDir = resolveRepoDir(options.repoDir);
    await requireInitializedRepoReadOnly({
      repoDir,
      outputMode: cliCtx.outputMode,
    });

    // Warn (don't block) if any extensions are still in a legacy layout.
    // list reads the lockfile, which tolerates mixed-generation state.
    const repoPath = RepoPath.create(repoDir);
    const markerRepo = new RepoMarkerRepository();
    const marker = await markerRepo.read(repoPath);
    const modelsDir = resolveModelsDir(marker);
    const absoluteModelsDir = resolve(repoDir, modelsDir);
    const lockfilePath = join(absoluteModelsDir, "upstream_extensions.json");
    await warnLegacyExtensionLayout(
      lockfilePath,
      (msg) => cliCtx.logger.warn(msg),
    );

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = await createExtensionListDeps(repoDir);

    const verbose = cliCtx.verbosity === "verbose";
    const renderer = createExtensionListRenderer(cliCtx.outputMode, verbose);
    await consumeStream(extensionList(ctx, deps), renderer.handlers());

    cliCtx.logger.debug("Extension list command completed");
  });
