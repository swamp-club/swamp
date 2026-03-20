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

import type {
  EventHandlers,
  RepoInitEvent,
  RepoUpgradeEvent,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogRepoInitRenderer implements Renderer<RepoInitEvent> {
  handlers(): EventHandlers<RepoInitEvent> {
    const logger = getSwampLogger(["repo", "init"]);
    return {
      initializing: () => {},
      completed: (e) => {
        const data = e.data;
        console.log("");
        console.log(
          "    ███████╗██╗    ██╗ █████╗ ███╗   ███╗██████╗",
        );
        console.log(
          "    ██╔════╝██║    ██║██╔══██╗████╗ ████║██╔══██╗",
        );
        console.log(
          "    ███████╗██║ █╗ ██║███████║██╔████╔██║██████╔╝",
        );
        console.log(
          "    ╚════██║██║███╗██║██╔══██║██║╚██╔╝██║██╔═══╝",
        );
        console.log(
          "    ███████║╚███╔███╔╝██║  ██║██║ ╚═╝ ██║██║",
        );
        console.log(
          "    ╚══════╝ ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝     ╚═╝╚═╝",
        );
        console.log("");
        console.log(
          "    ╔═══════════════════════════════════════════╗",
        );
        console.log(
          "    ║  WELCOME TO THE CLUB                      ║",
        );
        console.log(
          "    ║  for hackers, by hackers                  ║",
        );
        console.log(
          "    ╚═══════════════════════════════════════════╝",
        );
        console.log("");
        logger
          .info`Initialized swamp repository at ${data.path} (tool: ${data.tool})`;
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonRepoInitRenderer implements Renderer<RepoInitEvent> {
  handlers(): EventHandlers<RepoInitEvent> {
    return {
      initializing: () => {},
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class LogRepoUpgradeRenderer implements Renderer<RepoUpgradeEvent> {
  handlers(): EventHandlers<RepoUpgradeEvent> {
    const logger = getSwampLogger(["repo", "upgrade"]);
    return {
      upgrading: () => {},
      completed: (e) => {
        const data = e.data;
        logger
          .info`Upgraded swamp repository: ${data.previousVersion} → ${data.newVersion} (tool: ${data.tool})`;
        logger.info("  Skills updated: " + data.skillsUpdated.join(", "));
        logger.info(
          "  Instructions: " +
            (data.instructionsUpdated ? "updated" : "unchanged"),
        );
        logger.info(
          "  Settings: " + (data.settingsUpdated ? "updated" : "unchanged"),
        );
        logger.info("  .gitignore: " + data.gitignoreAction);
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonRepoUpgradeRenderer implements Renderer<RepoUpgradeEvent> {
  handlers(): EventHandlers<RepoUpgradeEvent> {
    return {
      upgrading: () => {},
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createRepoInitRenderer(
  mode: OutputMode,
): Renderer<RepoInitEvent> {
  switch (mode) {
    case "json":
      return new JsonRepoInitRenderer();
    case "log":
      return new LogRepoInitRenderer();
  }
}

export function createRepoUpgradeRenderer(
  mode: OutputMode,
): Renderer<RepoUpgradeEvent> {
  switch (mode) {
    case "json":
      return new JsonRepoUpgradeRenderer();
    case "log":
      return new LogRepoUpgradeRenderer();
  }
}
