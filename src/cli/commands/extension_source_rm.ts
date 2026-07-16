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
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  consumeStream,
  createLibSwampContext,
  createSourceRemoveDeps,
  sourceRemove,
} from "../../libswamp/mod.ts";
import { createSourceModifyRenderer } from "../../presentation/renderers/extension_source_modify.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { resolveUniqueLocalSkillsDirs } from "../../domain/repo/skill_dirs.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const extensionSourceRmCommand = new Command()
  .name("rm")
  .description("Remove a local extension source")
  .example(
    "Remove a source",
    'swamp extension source rm "~/code/swamp-extensions/model/aws/*"',
  )
  .arguments("<path:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions, path: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "extension",
      "source",
      "rm",
    ]);
    cliCtx.logger.debug`Removing extension source: ${path}`;

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const repoDir = resolveRepoDir(options.repoDir);
    const markerRepo = new RepoMarkerRepository();
    const marker = await markerRepo.read(RepoPath.create(repoDir));
    const tools = marker?.tools?.length ? marker.tools : ["claude"];
    const skillsDirs = resolveUniqueLocalSkillsDirs(repoDir, tools);
    const deps = await createSourceRemoveDeps(repoDir, skillsDirs);

    const renderer = createSourceModifyRenderer(cliCtx.outputMode);
    await consumeStream(
      sourceRemove(ctx, deps, path),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Extension source rm command completed");
  });
