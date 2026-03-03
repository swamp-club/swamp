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
import { resolve } from "@std/path";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { resolveModelsDir } from "../resolve_models_dir.ts";
import {
  RepoMarkerRepository,
} from "../../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { readUpstreamExtensions } from "./extension_pull.ts";
import {
  type ExtensionListEntry,
  renderExtensionList,
} from "../../presentation/output/extension_list_output.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const extensionListCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List upstream installed extensions")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, ["extension", "list"]);
    ctx.logger.debug`Starting extension list`;

    const repoDir = options.repoDir ?? ".";
    await requireInitializedRepo({
      repoDir,
      outputMode: ctx.outputMode,
    });

    const repoPath = RepoPath.create(repoDir);
    const markerRepo = new RepoMarkerRepository();
    const marker = await markerRepo.read(repoPath);
    const modelsDir = resolveModelsDir(marker);
    const absoluteModelsDir = resolve(repoDir, modelsDir);

    const upstreamData = await readUpstreamExtensions(absoluteModelsDir);

    const entries: ExtensionListEntry[] = Object.entries(upstreamData)
      .map(([name, entry]) => ({
        name,
        version: entry.version,
        pulledAt: entry.pulledAt ?? "",
        files: entry.files ?? [],
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const verbose = ctx.verbosity === "verbose";

    renderExtensionList({ extensions: entries }, ctx.outputMode, verbose);

    ctx.logger.debug("Extension list command completed");
  });
