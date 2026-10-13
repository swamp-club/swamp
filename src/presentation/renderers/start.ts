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

import { maxOf } from "../../domain/array_extrema.ts";
import { bold, cyan, dim, green, yellow } from "@std/fmt/colors";
import type { EventHandlers } from "../../libswamp/stream.ts";
import type {
  StartInspection,
  StartPrepareEvent,
  StartTaskSummary,
} from "../../libswamp/start/start.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

/** Output for `swamp start` and `swamp start status`. */
export interface StartRenderer {
  prepareHandlers(): EventHandlers<StartPrepareEvent>;
  workspaceOpened(path: string, created: boolean): void;
  /**
   * The page is up at `url`. `dashboard` is set for `swamp dashboard`, whose
   * page is one repo's dashboard rather than the start page.
   */
  pageReady(url: string, opened: boolean, dashboard?: boolean): void;
  launchedEnd(displayName: string): void;
  /**
   * The server stopped. `dashboard` is set when it served one repo's
   * dashboard (`swamp dashboard`), which is what to run again.
   */
  paused(dashboard?: boolean): void;
  /**
   * `workspaceName` is the `--workspace` filter, when one was given; it
   * changes the empty-result line from "no workspaces yet" to "no workspace
   * by that name".
   */
  inspection(data: StartInspection, workspaceName?: string): void;
}

class LogStartRenderer implements StartRenderer {
  prepareHandlers(): EventHandlers<StartPrepareEvent> {
    return {
      signed_in_checked: (e) => {
        const state = e.state;
        if (state.kind === "signed_in") {
          writeOutput(
            `${green("✓")} Signed in to Swamp Club${
              state.username ? ` as ${bold(state.username)}` : ""
            }`,
          );
        } else if (state.kind === "not_signed_in") {
          writeOutput(
            `${dim("•")} Not signed in yet — you'll sign in in the browser`,
          );
        } else {
          writeOutput(`${yellow("!")} Swamp couldn't verify your account`);
          writeOutput(dim(indentLines(state.reason)));
        }
      },
      workspace_ready: (e) => {
        writeOutput(
          `${green("✓")} Workspace ${e.created ? "created" : "opened"}: ${
            cyan(e.path)
          }`,
        );
      },
      completed: () => {},
      error: (e) => {
        throw new UserError(e.error.message, e.error.code);
      },
    };
  }

  pageReady(url: string, opened: boolean, dashboard = false): void {
    writeOutput("");
    this.urlLine(url, opened, dashboard);
    writeOutput(
      dim("This terminal keeps the page running. Press Ctrl-C to stop it."),
    );
  }

  launchedEnd(displayName: string): void {
    writeOutput("");
    writeOutput(
      `${
        green("✓")
      } ${displayName} is running in its own window. You can close this one.`,
    );
  }

  paused(dashboard = false): void {
    writeOutput("");
    writeOutput(
      dashboard
        ? "Stopped. Run `swamp dashboard` to open it again."
        : "Stopped. Run `swamp start` to get back to your workspaces.",
    );
  }

  workspaceOpened(path: string, created: boolean): void {
    writeOutput(
      `${green("✓")} Workspace ${created ? "created" : "opened"}: ${
        cyan(path)
      }`,
    );
  }

  inspection(data: StartInspection, workspaceName?: string): void {
    if (data.signedIn === "signed_in") {
      writeOutput(
        `${green("✓")} Signed in to Swamp Club${
          data.username ? ` as ${bold(data.username)}` : ""
        }`,
      );
    } else if (data.signedIn === "blocked") {
      writeOutput(`${yellow("!")} Swamp couldn't verify your account`);
      if (data.blockedReason) {
        writeOutput(dim(indentLines(data.blockedReason)));
      }
    } else if (data.signedIn === "unknown") {
      writeOutput(
        `${yellow("!")} Swamp couldn't check whether you're signed in`,
      );
    } else {
      writeOutput(
        `${
          dim("•")
        } Not signed in. Run \`swamp start\` (or \`swamp auth login\`) to sign in.`,
      );
    }
    writeOutput("");
    if (data.workspaces.length === 0 && workspaceName !== undefined) {
      writeOutput(`No workspace named ${bold(workspaceName)}.`);
    } else if (data.workspaces.length === 0) {
      writeOutput(dim("No workspaces yet. Run `swamp start` to create one."));
    } else {
      writeOutput(bold("Workspaces"));
      for (const w of data.workspaces) {
        const count = w.tasks.length === 0
          ? "no tasks yet"
          : w.tasks.length === 1
          ? "1 task"
          : `${w.tasks.length} tasks`;
        writeOutput(
          `  ${bold(w.name)}  ${dim(count)}${
            w.running ? green("  open in swamp start") : ""
          }`,
        );
        writeOutput(`    ${dim(w.path)}`);
        for (const task of w.tasks) {
          writeOutput(`    • ${task.title}`);
          writeOutput(`      ${dim(taskDetail(task))}`);
        }
      }
    }
    writeOutput("");
    writeOutput(bold("Agents"));
    const nameWidth = maxOf(data.agents.map((a) => a.displayName.length)) ?? 0;
    for (const a of data.agents) {
      const mark = a.found ? green("✓") : dim("✗");
      const where = a.found
        ? `${a.binaryPath}${
          a.launchable ? "" : dim("  (can't be started with a task yet)")
        }`
        : dim(`not on PATH (looked for ${a.binary})`);
      writeOutput(`  ${mark} ${a.displayName.padEnd(nameWidth)} ${where}`);
    }
  }

  private urlLine(url: string, opened: boolean, dashboard: boolean): void {
    writeOutput(pageReadyLine(opened, dashboard, bold));
    writeOutput(`  ${cyan(url)}`);
  }
}

/**
 * A task's created time for people: `2026-10-12 14:05`, in local time.
 */
export function formatCreated(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${
    pad(d.getHours())
  }:${pad(d.getMinutes())}`;
}

/** The line under a task in `swamp start status`: when created, and where it is. */
export function taskDetail(task: StartTaskSummary): string {
  const state = task.step === "launched"
    ? `launched with ${task.harnessDisplayName ?? task.harness}`
    : task.step === "task"
    ? "not started"
    : `at the ${task.step} step`;
  return `created ${formatCreated(task.createdAt)} · ${state}`;
}

/** Indents each line of a multi-line message under a status line. */
function indentLines(text: string): string {
  return text.split("\n").map((line) => `    ${line}`).join("\n");
}

class JsonStartRenderer implements StartRenderer {
  prepareHandlers(): EventHandlers<StartPrepareEvent> {
    return {
      signed_in_checked: () => {},
      workspace_ready: () => {},
      completed: () => {},
      error: (e) => {
        throw new UserError(e.error.message, e.error.code);
      },
    };
  }
  workspaceOpened(): void {}
  pageReady(): void {}
  launchedEnd(): void {}
  paused(): void {}
  inspection(data: StartInspection): void {
    writeOutput(JSON.stringify(data, null, 2));
  }
}

export function createStartRenderer(mode: OutputMode): StartRenderer {
  switch (mode) {
    case "json":
      return new JsonStartRenderer();
    case "log":
      return new LogStartRenderer();
  }
}

/**
 * The line above the page's URL: what was opened, or that it should be.
 * `swamp dashboard` names the repo's dashboard, never `swamp start`.
 */
export function pageReadyLine(
  opened: boolean,
  dashboard: boolean,
  emphasis: (text: string) => string = (text) => text,
): string {
  if (!opened) return "Open this page in your browser to continue:";
  return dashboard
    ? `Opened ${
      emphasis("this repo's dashboard")
    } in your browser. If it didn't appear, open:`
    : `Opened ${
      emphasis("swamp start")
    } in your browser. If it didn't appear, open:`;
}
