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

import type { OutputMode } from "./output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["repo"]);

/**
 * Data for repo init output.
 */
export interface RepoInitData {
  path: string;
  version: string;
  initializedAt: string;
  skillsCopied: string[];
  instructionsFileCreated: boolean;
  settingsCreated: boolean;
  gitignoreCreated: boolean;
  tool: string;
}

/**
 * Data for repo upgrade output.
 */
export interface RepoUpgradeData {
  path: string;
  previousVersion: string;
  newVersion: string;
  upgradedAt: string;
  skillsUpdated: string[];
  settingsUpdated: boolean;
  tool: string;
}

/**
 * Data for repo index rebuild output.
 */
export interface RepoIndexRebuildData {
  path: string;
  modelsIndexed: number;
  workflowsIndexed: number;
  workflowRunsIndexed: number;
}

/**
 * Data for repo index verify output.
 */
export interface RepoIndexVerifyData {
  path: string;
  valid: boolean;
  brokenLinks: string[];
  missingTargets: string[];
}

/**
 * Data for repo index prune output.
 */
export interface RepoIndexPruneData {
  path: string;
  removedLinks: string[];
}

export function renderRepoInit(data: RepoInitData, mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    // ASCII banner for the swamp club
    console.log("");
    console.log("    ███████╗██╗    ██╗ █████╗ ███╗   ███╗██████╗");
    console.log("    ██╔════╝██║    ██║██╔══██╗████╗ ████║██╔══██╗");
    console.log("    ███████╗██║ █╗ ██║███████║██╔████╔██║██████╔╝");
    console.log("    ╚════██║██║███╗██║██╔══██║██║╚██╔╝██║██╔═══╝");
    console.log("    ███████║╚███╔███╔╝██║  ██║██║ ╚═╝ ██║██║");
    console.log("    ╚══════╝ ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝     ╚═╝╚═╝");
    console.log("");
    console.log("    ╔═══════════════════════════════════════════╗");
    console.log("    ║  WELCOME TO THE CLUB                      ║");
    console.log("    ║  for hackers, by hackers                  ║");
    console.log("    ╚═══════════════════════════════════════════╝");
    console.log("");
    logger
      .info`Initialized swamp repository at ${data.path} (tool: ${data.tool})`;
  }
}

export function renderRepoUpgrade(
  data: RepoUpgradeData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    logger
      .info`Upgraded swamp repository: ${data.previousVersion} \u2192 ${data.newVersion} (tool: ${data.tool})`;
  }
}

export function renderRepoIndexRebuild(
  data: RepoIndexRebuildData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const total = data.modelsIndexed + data.workflowsIndexed +
      data.workflowRunsIndexed;
    logger.info`Rebuilt repository index: ${total} entries indexed`;
  }
}

export function renderRepoIndexVerify(
  data: RepoIndexVerifyData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const status = data.valid ? "VALID" : "INVALID";
    logger.info`Index verification: ${status}`;
  }
}

export function renderRepoIndexPrune(
  data: RepoIndexPruneData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    logger.info`Pruned ${data.removedLinks.length} broken symlink(s)`;
  }
}
