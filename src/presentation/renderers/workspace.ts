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

import { bold, cyan, dim, green, yellow } from "@std/fmt/colors";
import { maxOf } from "../../domain/array_extrema.ts";
import type { EventHandlers } from "../../libswamp/stream.ts";
import { userErrorFromSwampError } from "../../libswamp/errors.ts";
import type { SwampError } from "../../libswamp/errors.ts";
import type { WorkspaceCreateEvent } from "../../libswamp/workspace/create.ts";
import type {
  WorkspaceFolderState,
  WorkspaceSummary,
} from "../../libswamp/workspace/deps.ts";
import type { WorkspaceGetEvent } from "../../libswamp/workspace/get.ts";
import type { WorkspaceImportEvent } from "../../libswamp/workspace/import.ts";
import type { WorkspaceListEvent } from "../../libswamp/workspace/list.ts";
import type { WorkspaceRemoveEvent } from "../../libswamp/workspace/remove.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";

type DataEvent<D> =
  | { kind: "completed"; data: D }
  | { kind: "error"; error: SwampError };

function handlers<D>(
  mode: OutputMode,
  log: (data: D) => string[],
): EventHandlers<DataEvent<D>> {
  return {
    completed: (e) => {
      if (mode === "json") {
        console.log(JSON.stringify(e.data, null, 2));
      } else {
        writeOutput(log(e.data).join("\n"));
      }
    },
    error: (e) => {
      throw userErrorFromSwampError(e.error);
    },
  };
}

/** A note for a workspace whose folder isn't a usable repo; "" when it is. */
export function folderNote(folder: WorkspaceFolderState): string {
  switch (folder) {
    case "ok":
      return "";
    case "missing":
      return "folder missing";
    case "not_a_repo":
      return "not a swamp folder";
  }
}

/** The log lines of `swamp workspace list`. */
export function workspaceListLines(
  workspaces: readonly WorkspaceSummary[],
): string[] {
  if (workspaces.length === 0) {
    return [
      "No workspaces yet. Create one with 'swamp workspace create <name>'.",
    ];
  }
  const width = maxOf(workspaces.map((w) => w.name.length)) ?? 0;
  return workspaces.map((w) => {
    const notes = [
      ...(w.imported ? ["imported"] : []),
      ...(w.folder === "ok" ? [] : [folderNote(w.folder)]),
    ];
    const note = notes.length > 0 ? ` ${dim(`(${notes.join(", ")})`)}` : "";
    const name = bold(w.name.padEnd(width));
    return w.folder === "ok"
      ? `${name}  ${w.path}${note}`
      : `${name}  ${w.path}${yellow(note)}`;
  });
}

export function createWorkspaceCreateHandlers(
  mode: OutputMode,
): EventHandlers<WorkspaceCreateEvent> {
  return handlers(mode, (d) => [
    `${green("✓")} Created workspace ${bold(d.name)}: ${cyan(d.path)}`,
  ]);
}

export function createWorkspaceImportHandlers(
  mode: OutputMode,
): EventHandlers<WorkspaceImportEvent> {
  return handlers(mode, (d) => [
    d.alreadyRegistered
      ? `${dim("•")} ${cyan(d.path)} is already the workspace ${bold(d.name)}`
      : `${green("✓")} Imported workspace ${bold(d.name)}: ${cyan(d.path)}`,
  ]);
}

export function createWorkspaceListHandlers(
  mode: OutputMode,
): EventHandlers<WorkspaceListEvent> {
  return handlers(mode, (d) => workspaceListLines(d.workspaces));
}

export function createWorkspaceGetHandlers(
  mode: OutputMode,
): EventHandlers<WorkspaceGetEvent> {
  return handlers(mode, (d) => {
    const key = (k: string) => bold(cyan(`${k}:`));
    const lines = [
      `${key("Name")} ${bold(d.name)}`,
      `${key("Path")} ${d.path}${
        d.folder === "ok" ? "" : ` ${yellow(`(${folderNote(d.folder)})`)}`
      }`,
      `${key("Created")} ${d.createdAt}`,
      `${key("Imported")} ${d.imported ? "yes" : "no"}`,
      `${key("Trusted")} ${d.trusted ? "yes" : "no"}`,
      `${key("Agents")} ${
        d.enrolledTools.length > 0 ? d.enrolledTools.join(", ") : dim("none")
      }`,
    ];
    if (d.openInStart) {
      lines.push(`${key("Open in")} swamp start`);
    }
    return lines;
  });
}

export function createWorkspaceRemoveHandlers(
  mode: OutputMode,
): EventHandlers<WorkspaceRemoveEvent> {
  return handlers(mode, (d) => {
    const lines = [
      `${green("✓")} Removed workspace ${bold(d.name)}`,
      `  Its folder is still at ${cyan(d.path)}`,
      dim(`  Bring it back with: swamp workspace import "${d.path}"`),
    ];
    if (d.openInStart) {
      lines.push(
        `${
          yellow("!")
        } A swamp start still has this workspace open; it keeps working there until it closes.`,
      );
    }
    return lines;
  });
}
