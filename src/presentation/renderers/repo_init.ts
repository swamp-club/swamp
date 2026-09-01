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
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import { createExtensionInstallRenderer } from "./extension_install.ts";
import { join } from "@std/path";
import { bold, dim, yellow } from "@std/fmt/colors";

/**
 * Renders a `tools` array for the human-readable status line. Empty list
 * renders as `none` so output is never ambiguous.
 */
function formatToolsList(tools: readonly string[]): string {
  return tools.length === 0 ? "none" : tools.join(", ");
}

interface ToolGuidance {
  launch: string;
  command: string;
  nextStepSummary: string;
}

const TOOL_GUIDANCE: Record<string, ToolGuidance> = {
  claude: {
    launch: "Start Claude Code in this repository, then run:",
    command: "/swamp-getting-started",
    nextStepSummary: "Start Claude Code and run /swamp-getting-started",
  },
  cursor: {
    launch: "Open this project in Cursor, then run:",
    command: "/swamp-getting-started",
    nextStepSummary:
      "Open this project in Cursor and run /swamp-getting-started",
  },
  kiro: {
    launch: "Open this project in Kiro, then select from the / menu:",
    command: "swamp-getting-started",
    nextStepSummary:
      "Open this project in Kiro and select swamp-getting-started from the / menu",
  },
  codex: {
    launch: "Run codex in this directory, then invoke:",
    command: "$swamp-getting-started",
    nextStepSummary: "Run `codex` and invoke $swamp-getting-started",
  },
  amp: {
    launch: "Run amp in this directory and say:",
    command: '"I am new to swamp"',
    nextStepSummary: 'Run `amp` in this directory and say "I am new to swamp"',
  },
  copilot: {
    launch: "Open this project in VS Code with Copilot and say:",
    command: '"I am new to swamp"',
    nextStepSummary:
      'Open this project in VS Code with Copilot and say "I am new to swamp"',
  },
  opencode: {
    launch: "Run opencode in this directory and say:",
    command: '"I am new to swamp"',
    nextStepSummary:
      'Run `opencode` in this directory and say "I am new to swamp"',
  },
  pi: {
    launch: "Run pi in this directory, then invoke:",
    command: "/skill:swamp-getting-started",
    nextStepSummary:
      "Run `pi` in this directory and invoke /skill:swamp-getting-started",
  },
  antigravity: {
    launch: "Run agy in this directory, then invoke:",
    command: "/skill:swamp-getting-started",
    nextStepSummary:
      "Run `agy` in this directory and invoke /skill:swamp-getting-started",
  },
};

function renderToolGuidance(tool: string): void {
  const guidance = TOOL_GUIDANCE[tool];
  if (!guidance) return;
  writeOutput(guidance.launch);
  writeOutput("");
  writeOutput(`  ${bold(guidance.command)}`);
}

/**
 * On-disk paths that swamp's scaffolding writes for each tool. Used to tell
 * the user which files were left behind when a tool is dropped from the
 * enrolled list.
 *
 * Some paths are shared (`.agents/skills/` for amp/opencode/codex/copilot),
 * so the renderer subtracts paths that are still in use by another
 * remaining tool before warning the user — see {@link orphanedPathsFor}.
 */
const TOOL_CLEANUP_PATHS: Partial<Record<string, readonly string[]>> = {
  amp: [".amp/", ".agents/skills/"],
  claude: [".claude/"],
  cursor: [".cursor/"],
  kiro: [".kiro/", ".vscode/settings.local.json"],
  opencode: [".opencode/", ".agents/skills/"],
  codex: [".agents/skills/"],
  copilot: [".agents/skills/", ".github/hooks/"],
  pi: [".pi/"],
  antigravity: [".agents/hooks.json", ".agents/skills/"],
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
    return {
      initializing: () => {},
      completed: (e) => {
        const data = e.data;
        writeOutput("");
        writeOutput(
          "    ███████╗██╗    ██╗ █████╗ ███╗   ███╗██████╗",
        );
        writeOutput(
          "    ██╔════╝██║    ██║██╔══██╗████╗ ████║██╔══██╗",
        );
        writeOutput(
          "    ███████╗██║ █╗ ██║███████║██╔████╔██║██████╔╝",
        );
        writeOutput(
          "    ╚════██║██║███╗██║██╔══██║██║╚██╔╝██║██╔═══╝",
        );
        writeOutput(
          "    ███████║╚███╔███╔╝██║  ██║██║ ╚═╝ ██║██║",
        );
        writeOutput(
          "    ╚══════╝ ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝     ╚═╝╚═╝",
        );
        writeOutput("");
        writeOutput(
          "    ╔═══════════════════════════════════════════╗",
        );
        writeOutput(
          "    ║  WELCOME TO THE CLUB                      ║",
        );
        writeOutput(
          "    ║  for hackers, by hackers                  ║",
        );
        writeOutput(
          "    ╚═══════════════════════════════════════════╝",
        );
        writeOutput("");
        writeOutput(
          `Initialized swamp repository at ${bold(data.path)} ${
            dim(`(tools: ${formatToolsList(data.tools)})`)
          }`,
        );

        for (const removed of data.removedTools) {
          const paths = orphanedPathsFor(removed, data.tools);
          if (paths.length === 0) continue;
          writeOutput(
            `${
              yellow("⚠")
            } ${removed} was dropped from the enrolled tool list. ` +
              `Files in ${paths.join(", ")} were not deleted — ` +
              `remove them by hand if desired.`,
          );
        }

        const knownTools = data.tools.filter((t) => t in TOOL_GUIDANCE);

        writeOutput("");
        if (knownTools.length > 0) {
          writeOutput(bold("Your Swamp repo is ready."));
          writeOutput("");
          for (let i = 0; i < knownTools.length; i++) {
            if (i > 0) writeOutput("");
            renderToolGuidance(knownTools[i]);
          }
          writeOutput("");
          writeOutput(
            "Start with a task you already repeat. Your agent will help you",
          );
          writeOutput(
            "create, run, and inspect your first automation.",
          );
        } else {
          writeOutput(bold("What's next:"));
          writeOutput(
            "  → Run `swamp --help` to see available commands",
          );
        }

        writeOutput("");
        writeOutput(
          `Learn more: ${dim("https://swamp-club.com/manual")}`,
        );
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonRepoInitRenderer implements Renderer<RepoInitEvent> {
  private isAuthenticated: boolean;

  constructor(isAuthenticated: boolean) {
    this.isAuthenticated = isAuthenticated;
  }

  handlers(): EventHandlers<RepoInitEvent> {
    return {
      initializing: () => {},
      completed: (e) => {
        const steps = e.data.tools
          .map((t) => TOOL_GUIDANCE[t]?.nextStepSummary)
          .filter((s): s is string => s !== undefined);
        if (steps.length === 0) {
          steps.push("Run `swamp --help` to see available commands");
        }
        if (!this.isAuthenticated) {
          steps.push(
            "Join & participate in the community: swamp auth login",
          );
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
  private isAuthenticated: boolean;

  constructor(isAuthenticated: boolean) {
    this.isAuthenticated = isAuthenticated;
  }

  handlers(): EventHandlers<RepoUpgradeEvent> {
    const installRenderer = createExtensionInstallRenderer("log");
    const installHandlers = installRenderer.handlers();
    return {
      upgrading: () => {},
      extensions: (e) => dispatchInstallEvent(installHandlers, e.event),
      completed: (e) => {
        const data = e.data;
        writeOutput(
          `Upgraded swamp repository: ${bold(data.previousVersion)} → ${
            bold(data.newVersion)
          } ${dim(`(tools: ${formatToolsList(data.tools)})`)}`,
        );

        if (data.addedTools.length > 0 || data.removedTools.length > 0) {
          const before = formatToolsList(data.previousTools);
          const after = formatToolsList(data.tools);
          writeOutput(`  Tools: [${before}] → [${after}]`);
          for (const removed of data.removedTools) {
            const paths = orphanedPathsFor(removed, data.tools);
            if (paths.length === 0) continue;
            writeOutput(
              `  ${
                yellow("⚠")
              } ${removed} was dropped from the enrolled tool list. ` +
                `Files in ${paths.join(", ")} were not deleted — ` +
                `remove them by hand if desired.`,
            );
          }
          for (const entry of data.extensionsToReinstall) {
            const list = entry.names.join(", ");
            writeOutput(
              `  ${entry.names.length} extension(s) installed for the ` +
                `previous tool were NOT copied to ${entry.tool}. ` +
                `Run \`swamp extension pull <name> --force\` to install ` +
                `for all enrolled tools: ${list}`,
            );
          }
        }

        if (data.localSkillCopies.length > 0) {
          const allNames = data.localSkillCopies.flatMap((c) => c.names);
          writeOutput(
            `${yellow("⚠")} Local copies of ${
              allNames.join(", ")
            } are shadowing the ` +
              "globally installed skills. Delete them manually:",
          );
          for (const copy of data.localSkillCopies) {
            for (const name of copy.names) {
              writeOutput(`  ${join(copy.skillsDir, name)}`);
            }
          }
        }

        if (data.untrustedCollectives.length > 0) {
          writeOutput(
            `${yellow("⚠")} Extensions from untrusted collectives: ${
              data.untrustedCollectives.join(", ")
            }`,
          );
          writeOutput(
            "  These extensions will not auto-resolve until their collectives are trusted.",
          );
          for (const collective of data.untrustedCollectives) {
            writeOutput(
              `  To trust: swamp extension trust add ${collective}`,
            );
          }
          writeOutput(
            "  Or trust all membership collectives: swamp extension trust auto-trust on",
          );
        }

        writeOutput(
          "  Skills updated: " + data.skillsUpdated.join(", "),
        );
        writeOutput(
          "  Instructions: " +
            (data.instructionsUpdated ? "updated" : "unchanged"),
        );
        writeOutput(
          "  Settings: " +
            (data.settingsUpdated ? "updated" : "unchanged"),
        );
        writeOutput("  .gitignore: " + data.gitignoreAction);

        if (data.changedFiles.length > 0) {
          writeOutput("  Changed files:");
          for (const file of data.changedFiles) {
            writeOutput(`    ${file}`);
          }
        }
        if (!this.isAuthenticated) {
          writeOutput(
            "  → Join & participate in the community: swamp auth login",
          );
        }
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
  opts?: { isAuthenticated?: boolean },
): Renderer<RepoInitEvent> {
  const authed = opts?.isAuthenticated ?? false;
  switch (mode) {
    case "json":
      return new JsonRepoInitRenderer(authed);
    case "log":
      return new LogRepoInitRenderer();
  }
}

export function createRepoUpgradeRenderer(
  mode: OutputMode,
  opts?: { isAuthenticated?: boolean },
): Renderer<RepoUpgradeEvent> {
  const authed = opts?.isAuthenticated ?? false;
  switch (mode) {
    case "json":
      return new JsonRepoUpgradeRenderer();
    case "log":
      return new LogRepoUpgradeRenderer(authed);
  }
}
