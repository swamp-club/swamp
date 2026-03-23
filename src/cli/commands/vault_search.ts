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
  createLibSwampContext,
  createVaultDescribeDeps,
  vaultDescribe,
  vaultSearch,
  type VaultSearchDeps,
} from "../../libswamp/mod.ts";
import { createVaultSearchRenderer } from "../../presentation/renderers/vault_search.tsx";
import { createVaultDescribeRenderer } from "../../presentation/renderers/vault_describe.ts";
import {
  createContext,
  type GlobalOptions,
  interactiveOutputMode,
} from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const vaultSearchCommand = new Command()
  .name("search")
  .description("Search for vaults in the repository")
  .arguments("[query:string]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(async function (options: AnyOptions, query?: string) {
    const ctx = createContext(options as GlobalOptions, ["vault", "search"]);
    const effectiveMode = interactiveOutputMode(ctx);
    const libCtx = createLibSwampContext();
    ctx.logger.debug`Searching vaults with query: ${query ?? "(none)"}`;

    const { repoContext } = await requireInitializedRepoReadOnly({
      repoDir: options.repoDir ?? ".",
      outputMode: effectiveMode,
    });

    const deps: VaultSearchDeps = {
      findAllVaults: () => repoContext.vaultConfigRepo.findAll(),
    };

    const renderer = createVaultSearchRenderer(effectiveMode);
    await consumeStream(
      vaultSearch(libCtx, deps, { query }),
      renderer.handlers(),
    );

    const selected = renderer.selectedItem();
    if (selected) {
      ctx.logger.debug`Selected vault: ${selected.name}`;
      const describeRenderer = createVaultDescribeRenderer(effectiveMode);
      const describeDeps = createVaultDescribeDeps(options.repoDir ?? ".");
      await consumeStream(
        vaultDescribe(libCtx, describeDeps, selected.name),
        describeRenderer.handlers(),
      );
    } else {
      ctx.logger.debug`Search cancelled`;
    }

    ctx.logger.debug("Vault search command completed");
  });
