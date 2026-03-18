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
  gitignoreAction: string;
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
  instructionsUpdated: boolean;
  settingsUpdated: boolean;
  gitignoreAction: string;
  tool: string;
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
    logger.info("  Skills updated: " + data.skillsUpdated.join(", "));
    logger.info(
      "  Instructions: " +
        (data.instructionsUpdated ? "updated" : "unchanged"),
    );
    logger.info(
      "  Settings: " + (data.settingsUpdated ? "updated" : "unchanged"),
    );
    logger.info("  .gitignore: " + data.gitignoreAction);
  }
}
