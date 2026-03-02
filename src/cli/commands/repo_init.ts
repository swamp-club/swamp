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
  renderRepoInit,
  renderRepoUpgrade,
  type RepoInitData,
  type RepoUpgradeData,
} from "../../presentation/output/repo_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { type AiTool, RepoService } from "../../domain/repo/repo_service.ts";
import { VERSION } from "./version.ts";
import { repoIndexCommand } from "./repo_index.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const aiToolType = new EnumType([
  "claude",
  "cursor",
  "opencode",
  "codex",
  "kiro",
]);

// Exported for reuse by repoCommand default action
export async function repoInitAction(
  options: AnyOptions,
  pathArg?: string,
): Promise<void> {
  const ctx = createContext(options as GlobalOptions, ["repo", "init"]);
  ctx.logger.debug`Initializing repository at: ${pathArg ?? "."}`;

  const repoPath = RepoPath.create(pathArg ?? ".");
  const service = new RepoService(VERSION);
  const tool = (options.tool as AiTool) ?? "claude";
  const includeGitignore = options.includeGitignore as boolean | undefined;

  const result = await service.init(repoPath, {
    force: options.force,
    tool,
    includeGitignore,
  });

  ctx.logger.debug`Repository initialized: ${result.path}`;

  const data: RepoInitData = {
    path: result.path,
    version: result.version,
    initializedAt: result.initializedAt,
    skillsCopied: result.skillsCopied,
    instructionsFileCreated: result.instructionsFileCreated,
    settingsCreated: result.settingsCreated,
    gitignoreAction: result.gitignoreAction,
    tool: result.tool,
  };

  renderRepoInit(data, ctx.outputMode);
  ctx.logger.debug("Repo init command completed");
}

export const repoInitCommand = new Command()
  .description("Initialize a new swamp repository")
  .arguments("[path:string]")
  .option("-f, --force", "Reinitialize if already exists")
  .type("aiTool", aiToolType)
  .option(
    "-t, --tool <tool:aiTool>",
    "AI coding tool to configure for (claude, cursor, opencode, codex, kiro)",
    { default: "claude" },
  )
  .option("--include-gitignore", "Manage a swamp section in .gitignore")
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
    const ctx = createContext(options as GlobalOptions, ["repo", "upgrade"]);
    ctx.logger.debug`Upgrading repository at: ${pathArg ?? "."}`;

    const repoPath = RepoPath.create(pathArg ?? ".");
    const service = new RepoService(VERSION);
    const tool = options.tool as AiTool | undefined;
    const includeGitignore = options.includeGitignore as boolean | undefined;

    const result = await service.upgrade(repoPath, {
      tool,
      includeGitignore,
    });

    ctx.logger.debug`Repository upgraded: ${result.path}`;

    const data: RepoUpgradeData = {
      path: result.path,
      previousVersion: result.previousVersion,
      newVersion: result.newVersion,
      upgradedAt: result.upgradedAt,
      skillsUpdated: result.skillsUpdated,
      settingsUpdated: result.settingsUpdated,
      gitignoreAction: result.gitignoreAction,
      tool: result.tool,
    };

    renderRepoUpgrade(data, ctx.outputMode);
    ctx.logger.debug("Repo upgrade command completed");
  });

export const repoCommand = new Command()
  .name("repo")
  .description("Initialize a swamp repository (or manage existing ones)")
  .arguments("[path:string]")
  .option("-f, --force", "Reinitialize if already exists")
  .type("aiTool", aiToolType)
  .option(
    "-t, --tool <tool:aiTool>",
    "AI coding tool to configure for (claude, cursor, opencode, codex, kiro)",
    { default: "claude" },
  )
  .option("--include-gitignore", "Manage a swamp section in .gitignore")
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
        "AI coding tool to configure for (claude, cursor, opencode, codex, kiro)",
        { default: "claude" },
      )
      .option("--include-gitignore", "Manage a swamp section in .gitignore")
      .action(repoInitAction),
  )
  .command("upgrade", repoUpgradeCommand)
  .command("index", repoIndexCommand);
