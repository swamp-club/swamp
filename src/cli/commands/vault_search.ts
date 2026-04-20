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
  type VaultDescribeData,
  vaultSearch,
  type VaultSearchDeps,
  type VaultSearchItem,
} from "../../libswamp/mod.ts";
import { createVaultSearchRenderer } from "../../presentation/renderers/vault_search.tsx";
import { createVaultDescribeRenderer } from "../../presentation/renderers/vault_describe.ts";
import {
  createContext,
  type GlobalOptions,
  interactiveOutputMode,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Creates a fetchPreview closure that fetches full vault detail data.
 * This bridges the presentation layer to the libswamp vaultDescribe application
 * service, capturing the repoDir dependency.
 */
function createVaultFetchPreview(
  repoDir: string,
): (item: VaultSearchItem) => Promise<VaultDescribeData> {
  const libCtx = createLibSwampContext();
  const describeDeps = createVaultDescribeDeps(repoDir);

  return async (item: VaultSearchItem): Promise<VaultDescribeData> => {
    let result: VaultDescribeData | undefined;
    await consumeStream(vaultDescribe(libCtx, describeDeps, item.name), {
      resolving: () => {},
      completed: (e) => {
        result = e.data;
      },
      error: () => {},
    });
    if (!result) {
      throw new Error(`Vault not found: ${item.name}`);
    }
    return result;
  };
}

export async function vaultSearchAction(
  options: AnyOptions,
  query?: string,
): Promise<void> {
  const ctx = createContext(options as GlobalOptions, ["vault", "search"]);
  const effectiveMode = interactiveOutputMode(ctx);
  const libCtx = createLibSwampContext();
  ctx.logger.debug`Searching vaults with query: ${query ?? "(none)"}`;

  const { repoContext } = await requireInitializedRepoReadOnly({
    repoDir: resolveRepoDir(options.repoDir),
    outputMode: effectiveMode,
  });

  const deps: VaultSearchDeps = {
    findAllVaults: () => repoContext.vaultConfigRepo.findAll(),
  };

  const repoDir = resolveRepoDir(options.repoDir);
  const fetchPreview = effectiveMode === "log"
    ? createVaultFetchPreview(repoDir)
    : undefined;

  const renderer = createVaultSearchRenderer(effectiveMode, fetchPreview);
  await consumeStream(
    vaultSearch(libCtx, deps, { query }),
    renderer.handlers(),
  );

  const selected = renderer.selectedItem();
  if (selected) {
    ctx.logger.debug`Selected vault: ${selected.name}`;
    // In JSON mode, still display the full vault describe output after auto-select
    if (effectiveMode === "json") {
      const describeRenderer = createVaultDescribeRenderer(effectiveMode);
      const describeDeps = createVaultDescribeDeps(repoDir);
      await consumeStream(
        vaultDescribe(libCtx, describeDeps, selected.name),
        describeRenderer.handlers(),
      );
    }
    // In interactive mode, the scrollback from the picker already contains
    // the vault detail, so no additional vaultDescribe call is needed.
  } else {
    ctx.logger.debug`Search cancelled`;
  }

  ctx.logger.debug("Vault search command completed");
}

export const vaultSearchCommand = new Command()
  .name("search")
  .description("Search for vaults in the repository")
  .example("Browse all vaults", "swamp vault search")
  .example("Search by keyword", "swamp vault search aws")
  .arguments("[query:string]")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(vaultSearchAction);
