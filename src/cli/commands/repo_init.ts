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

import { Command, EnumType } from "@cliffy/command";
import {
  consumeStream,
  createLibSwampContext,
  createRepoInitDeps,
  createRepoUpgradeDeps,
  repoInit,
  repoUpgrade,
} from "../../libswamp/mod.ts";
import {
  createRepoInitRenderer,
  createRepoUpgradeRenderer,
} from "../../presentation/renderers/repo_init.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { VERSION } from "./version.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const aiToolType = new EnumType([
  "claude",
  "cursor",
  "opencode",
  "codex",
  "kiro",
  "none",
]);

// Exported for reuse by repoCommand default action
export async function repoInitAction(
  options: AnyOptions,
  pathArg?: string,
): Promise<void> {
  const cliCtx = createContext(options as GlobalOptions, ["repo", "init"]);
  cliCtx.logger.debug`Initializing repository at: ${pathArg ?? "."}`;

  const ctx = createLibSwampContext({ logger: cliCtx.logger });
  const deps = createRepoInitDeps(VERSION);
  const renderer = createRepoInitRenderer(cliCtx.outputMode);
  await consumeStream(
    repoInit(ctx, deps, {
      path: pathArg ?? ".",
      force: !!options.force,
      tool: (options.tool as string) ?? "claude",
      version: VERSION,
    }),
    renderer.handlers(),
  );

  cliCtx.logger.debug("Repo init command completed");
}

export const repoInitCommand = new Command()
  .description("Initialize a new swamp repository")
  .arguments("[path:string]")
  .option("-f, --force", "Reinitialize if already exists")
  .type("aiTool", aiToolType)
  .option(
    "-t, --tool <tool:aiTool>",
    "AI coding tool to configure for (claude, cursor, opencode, codex, kiro, none)",
    { default: "claude" },
  )
  .action(repoInitAction);

export const repoUpgradeCommand = new Command()
  .description("Upgrade an existing swamp repository")
  .arguments("[path:string]")
  .type("aiTool", aiToolType)
  .option(
    "-t, --tool <tool:aiTool>",
    "Switch to a different AI coding tool",
  )
  .option("--include-gitignore", "Manage a swamp section in .gitignore")
  .action(async function (options: AnyOptions, pathArg?: string) {
    const cliCtx = createContext(options as GlobalOptions, ["repo", "upgrade"]);
    cliCtx.logger.debug`Upgrading repository at: ${pathArg ?? "."}`;

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createRepoUpgradeDeps(VERSION);
    const renderer = createRepoUpgradeRenderer(cliCtx.outputMode);
    await consumeStream(
      repoUpgrade(ctx, deps, {
        path: pathArg ?? ".",
        tool: options.tool as string | undefined,
        includeGitignore: options.includeGitignore as boolean | undefined,
        version: VERSION,
      }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Repo upgrade command completed");
  });

export const repoCommand = new Command()
  .name("repo")
  .description("Initialize a swamp repository (or manage existing ones)")
  .arguments("[path:string]")
  .option("-f, --force", "Reinitialize if already exists")
  .type("aiTool", aiToolType)
  .option(
    "-t, --tool <tool:aiTool>",
    "AI coding tool to configure for (claude, cursor, opencode, codex, kiro, none)",
    { default: "claude" },
  )
  .action(repoInitAction)
  .command(
    "init",
    new Command()
      .description("Initialize a new swamp repository")
      .hidden()
      .arguments("[path:string]")
      .option("-f, --force", "Reinitialize if already exists")
      .type("aiTool", aiToolType)
      .option(
        "-t, --tool <tool:aiTool>",
        "AI coding tool to configure for (claude, cursor, opencode, codex, kiro, none)",
        { default: "claude" },
      )
      .action(repoInitAction),
  )
  .command("upgrade", repoUpgradeCommand);
