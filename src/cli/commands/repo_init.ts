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
  renderRepoInit,
  renderRepoUpgrade,
  type RepoInitData,
  type RepoUpgradeData,
} from "../../presentation/output/repo_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { RepoService } from "../../domain/repo/repo_service.ts";
import { VERSION } from "./version.ts";
import { repoIndexCommand } from "./repo_index.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const repoInitCommand = new Command()
  .description("Initialize a new swamp repository")
  .arguments("[path:string]")
  .option("-f, --force", "Reinitialize if already exists")
  .action(async function (options: AnyOptions, pathArg?: string) {
    const ctx = createContext(options as GlobalOptions, ["repo", "init"]);
    ctx.logger.debug`Initializing repository at: ${pathArg ?? "."}`;

    const repoPath = RepoPath.create(pathArg ?? ".");
    const service = new RepoService(VERSION);

    const result = await service.init(repoPath, { force: options.force });

    ctx.logger.debug`Repository initialized: ${result.path}`;

    const data: RepoInitData = {
      path: result.path,
      version: result.version,
      initializedAt: result.initializedAt,
      skillsCopied: result.skillsCopied,
      claudeMdCreated: result.claudeMdCreated,
      claudeSettingsCreated: result.claudeSettingsCreated,
    };

    renderRepoInit(data, ctx.outputMode);
    ctx.logger.debug("Repo init command completed");
  });

export const repoUpgradeCommand = new Command()
  .description("Upgrade an existing swamp repository")
  .arguments("[path:string]")
  .action(async function (options: AnyOptions, pathArg?: string) {
    const ctx = createContext(options as GlobalOptions, ["repo", "upgrade"]);
    ctx.logger.debug`Upgrading repository at: ${pathArg ?? "."}`;

    const repoPath = RepoPath.create(pathArg ?? ".");
    const service = new RepoService(VERSION);

    const result = await service.upgrade(repoPath);

    ctx.logger.debug`Repository upgraded: ${result.path}`;

    const data: RepoUpgradeData = {
      path: result.path,
      previousVersion: result.previousVersion,
      newVersion: result.newVersion,
      upgradedAt: result.upgradedAt,
      skillsUpdated: result.skillsUpdated,
      claudeSettingsUpdated: result.claudeSettingsUpdated,
    };

    renderRepoUpgrade(data, ctx.outputMode);
    ctx.logger.debug("Repo upgrade command completed");
  });

export const repoCommand = new Command()
  .name("repo")
  .description("Manage swamp repositories")
  .action(function () {
    this.showHelp();
  })
  .command("init", repoInitCommand)
  .command("upgrade", repoUpgradeCommand)
  .command("index", repoIndexCommand);
