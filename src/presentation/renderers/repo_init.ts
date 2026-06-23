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

import type {
  EventHandlers,
  ExtensionInstallData,
  ExtensionInstallEvent,
  RepoInitEvent,
  RepoUpgradeEvent,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import { createExtensionInstallRenderer } from "./extension_install.ts";
import { join } from "@std/path";

/**
 * Renders a `tools` array for the human-readable status line. Empty list
 * renders as `none` so output is never ambiguous.
 */
function formatToolsList(tools: readonly string[]): string {
  return tools.length === 0 ? "none" : tools.join(", ");
}

const TOOL_NEXT_STEPS: Record<string, string> = {
  claude: "Start Claude Code and run /swamp-getting-started",
  cursor: "Open this project in Cursor and run /swamp-getting-started",
  codex: "Run `codex` and invoke $swamp-getting-started",
  copilot:
    'Open this project in VS Code with Copilot and say "I am new to swamp"',
  opencode: 'Run `opencode` in this directory and say "I am new to swamp"',
  kiro:
    "Open this project in Kiro and select swamp-getting-started from the / menu",
};

/**
 * On-disk paths that swamp's scaffolding writes for each tool. Used to tell
 * the user which files were left behind when a tool is dropped from the
 * enrolled list.
 *
 * Some paths are shared (`.agents/skills/` for opencode/codex/copilot),
 * so the renderer subtracts paths that are still in use by another
 * remaining tool before warning the user — see {@link orphanedPathsFor}.
 */
const TOOL_CLEANUP_PATHS: Partial<Record<string, readonly string[]>> = {
  claude: [".claude/"],
  cursor: [".cursor/"],
  kiro: [".kiro/", ".vscode/settings.local.json"],
  opencode: [".opencode/", ".agents/skills/"],
  codex: [".agents/skills/"],
  copilot: [".agents/skills/", ".github/hooks/"],
};

/**
 * Returns the on-disk paths a dropped tool wrote that aren't still in use by
 * another remaining tool. Empty when every path is shared (no orphans —
 * suppress the note entirely so we don't tell the user to delete files
 * still in use by another enrolled tool).
 */
function orphanedPathsFor(
  dropped: string,
  remaining: readonly string[],
): string[] {
  const droppedPaths = TOOL_CLEANUP_PATHS[dropped] ?? [`.${dropped}/`];
  const stillUsedPaths = new Set<string>();
  for (const tool of remaining) {
    for (const path of TOOL_CLEANUP_PATHS[tool] ?? []) {
      stillUsedPaths.add(path);
    }
  }
  return droppedPaths.filter((p) => !stillUsedPaths.has(p));
}

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
        logger.info`Initialized swamp repository at ${data.path} (tools: ${
          formatToolsList(data.tools)
        })`;
        // Force-reinit may have dropped tools — surface so the user knows
        // their old scaffolding files remain on disk and can be removed.
        // Suppress when every path is shared with a still-enrolled tool.
        for (const removed of data.removedTools) {
          const paths = orphanedPathsFor(removed, data.tools);
          if (paths.length === 0) continue;
          logger.info(
            `Note: ${removed} was dropped from the enrolled tool list. ` +
              `Files in ${paths.join(", ")} were not deleted — ` +
              `remove them by hand if desired.`,
          );
        }

        const steps = data.tools
          .map((t) => TOOL_NEXT_STEPS[t])
          .filter((s): s is string => s !== undefined);
        if (steps.length === 0) {
          steps.push("Run `swamp --help` to see available commands");
        }
        console.log("");
        logger.info("What's next:");
        for (const step of steps) {
          logger.info(`  → ${step}`);
        }
        logger.info("  → Read the manual at https://swamp-club.com/manual");
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
        const steps = e.data.tools
          .map((t) => TOOL_NEXT_STEPS[t])
          .filter((s): s is string => s !== undefined);
        if (steps.length === 0) {
          steps.push("Run `swamp --help` to see available commands");
        }
        console.log(JSON.stringify({ ...e.data, nextSteps: steps }, null, 2));
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
    // Delegate per-extension install/migration progress to the extension
    // install renderer so output stays consistent with what users see
    // when they run `swamp extension install` directly. The upgrade
    // renderer is a thin layer around it.
    const installRenderer = createExtensionInstallRenderer("log");
    const installHandlers = installRenderer.handlers();
    return {
      upgrading: () => {},
      extensions: (e) => dispatchInstallEvent(installHandlers, e.event),
      completed: (e) => {
        const data = e.data;
        logger
          .info`Upgraded swamp repository: ${data.previousVersion} → ${data.newVersion} (tools: ${
          formatToolsList(data.tools)
        })`;

        // Surface a tools-changed diff line whenever the enrolled list
        // shifted. Suppressed for plain `swamp repo upgrade` (no tool
        // flag) so the common case doesn't get noisier.
        if (data.addedTools.length > 0 || data.removedTools.length > 0) {
          const before = formatToolsList(data.previousTools);
          const after = formatToolsList(data.tools);
          logger.info(`  Tools: [${before}] → [${after}]`);
          for (const removed of data.removedTools) {
            const paths = orphanedPathsFor(removed, data.tools);
            if (paths.length === 0) continue;
            logger.info(
              `  Note: ${removed} was dropped from the enrolled tool list. ` +
                `Files in ${paths.join(", ")} were not deleted — ` +
                `remove them by hand if desired.`,
            );
          }
          for (const entry of data.extensionsToReinstall) {
            const list = entry.names.join(", ");
            logger.info(
              `  ${entry.names.length} extension(s) installed for the ` +
                `previous tool were NOT copied to ${entry.tool}. ` +
                `Re-run \`swamp extension pull <name>\` to install ` +
                `for ${entry.tool}: ${list}`,
            );
          }
        }

        if (data.localSkillCopies.length > 0) {
          logger.warn(
            "Local swamp skill copies are shadowing the globally " +
              "installed skills. Delete them manually:",
          );
          for (const copy of data.localSkillCopies) {
            for (const name of copy.names) {
              logger.warn(`  ${join(copy.skillsDir, name)}`);
            }
          }
        }

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
    // JSON mode must emit exactly ONE top-level JSON object per
    // invocation — downstream parsers that read stdout as a single
    // document break otherwise. Capture the install pass's summary
    // and fold it into the upgrade's final `completed` object rather
    // than delegating to JsonExtensionInstallRenderer (which would
    // console.log its own JSON mid-stream).
    let extensionInstall: ExtensionInstallData | undefined;
    return {
      upgrading: () => {},
      extensions: (e) => {
        if (e.event.kind === "completed") {
          extensionInstall = e.event.data;
        }
      },
      completed: (e) => {
        const payload = extensionInstall
          ? { ...e.data, extensionInstall }
          : e.data;
        console.log(JSON.stringify(payload, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

/**
 * Routes a single `ExtensionInstallEvent` to the matching handler on
 * the delegate install renderer. Keeping the dispatch in one place
 * ensures the log and JSON upgrade renderers stay in lockstep with any
 * future event kinds added to `ExtensionInstallEvent`.
 */
function dispatchInstallEvent(
  handlers: EventHandlers<ExtensionInstallEvent>,
  event: ExtensionInstallEvent,
): void {
  switch (event.kind) {
    case "resolving":
      handlers.resolving?.(event);
      return;
    case "installing":
      handlers.installing?.(event);
      return;
    case "migrating":
      handlers.migrating?.(event);
      return;
    case "completed":
      handlers.completed?.(event);
      return;
    case "error":
      handlers.error?.(event);
      return;
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
