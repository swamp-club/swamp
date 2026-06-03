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
  consumeStream,
  createLibSwampContext,
  createVaultInspectDeps,
  vaultInspect,
} from "../../libswamp/mod.ts";
import { createVaultInspectRenderer } from "../../presentation/renderers/vault_inspect.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const vaultInspectCommand = new Command()
  .name("inspect")
  .description(
    `Show annotations for a vault secret.

Displays the metadata (URL, notes, labels) attached to a secret
via \`swamp vault annotate\`.`,
  )
  .arguments("<vault_name:string> <key:string>")
  .example(
    "Inspect a secret's annotations",
    "swamp vault inspect my-vault API_KEY",
  )
  .example(
    "JSON output",
    "swamp vault inspect my-vault API_KEY --json",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (
    options: AnyOptions,
    vaultName: string,
    key: string,
  ) {
    const cliCtx = createContext(options as GlobalOptions, [
      "vault",
      "inspect",
    ]);
    cliCtx.logger
      .debug`Inspecting annotation for secret in vault: ${vaultName}`;

    const { repoDir } = await requireInitializedRepo({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createVaultInspectDeps(repoDir);

    const renderer = createVaultInspectRenderer(cliCtx.outputMode);
    await consumeStream(
      vaultInspect(ctx, deps, vaultName, key),
      renderer.handlers(),
    );
  });
