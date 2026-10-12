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

import type { StartTask } from "./start_task.ts";

/**
 * The folder every task's brief lives in, relative to the workspace root.
 * It sits beside the agent instruction files, where people and agents read
 * it, not in the hidden runtime state under `.swamp/`.
 */
export const TASKS_DIR = "tasks";

/**
 * Where `swamp start` kept the one brief of a workspace before every task
 * had its own. Only migration reads it.
 */
export const LEGACY_BRIEF_PATH = "TASK.md";

/**
 * What a task's brief path may look like, relative to the workspace and
 * always with `/`: `tasks/2026-10-12-list-my-vpcs.md`. It is checked before
 * it reaches a launch prompt or a file path, so nothing read from disk can
 * leave `tasks/` or carry shell or quoting characters.
 */
export const BRIEF_FILE_PATTERN = /^tasks\/[a-z0-9][a-z0-9-]*\.md$/;

/** True when `path` is a well-formed task brief path. */
export function isBriefFile(path: string): boolean {
  return BRIEF_FILE_PATTERN.test(path);
}

/** The first line of every brief this version writes. */
export const BRIEF_HEADER = "<!-- swamp start brief v1 -->";

/**
 * Renders the brief the agent reads. The task goes in verbatim; no other
 * user input appears anywhere in it.
 */
export function renderBrief(input: {
  task: StartTask;
  workspacePath: string;
  harnessDisplayName: string;
  /**
   * True when the workspace is the user's existing project, imported where
   * it is, rather than a folder `swamp start` created.
   */
  imported?: boolean;
}): string {
  const workspaceLine = input.imported
    ? `- Workspace: ${input.workspacePath}. This is the user's existing project, registered as a Swamp workspace; leave files unrelated to the task alone.`
    : `- Workspace: ${input.workspacePath}. Created by \`swamp start\`; it holds only Swamp's files.`;
  return [
    BRIEF_HEADER,
    "# Task",
    "",
    input.task.text,
    "",
    "# Context",
    "",
    workspaceLine,
    `- Agent: ${input.harnessDisplayName}`,
    "",
    "# How to work on this",
    "",
    "1. Before you run anything that touches a real system, confirm the target with",
    "   the user: which account, cluster, project or repository.",
    "2. Use the swamp-getting-started skill from its brief entry point.",
    "3. Prefer a method that reads (get, list, describe) for the first run.",
    "4. Show the user the result in this conversation.",
    "",
  ].join("\n");
}

/**
 * The task text a brief was written for, or null when the text isn't a
 * swamp brief. Used to tell which task an older brief belongs to.
 */
export function briefTaskText(text: string): string | null {
  if (!isSwampBrief(text)) return null;
  const start = text.indexOf("\n# Task\n\n");
  const end = text.indexOf("\n\n# Context\n\n- Workspace: ");
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start + "\n# Task\n\n".length, end);
}

/** True when a file's text is a brief swamp wrote, not someone's own file. */
export function isSwampBrief(text: string): boolean {
  return text.startsWith(BRIEF_HEADER);
}

/**
 * The file name a task's brief gets: the task's creation date and a slug of
 * its title, `2026-10-11-list-my-vpcs.md`. It always matches
 * {@link BRIEF_FILE_PATTERN} once put under `tasks/`.
 */
export function briefFileName(createdAt: string, title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  ).slice(0, 60).replace(/-+$/, "");
  return `${createdAt.slice(0, 10)}-${slug || "task"}.md`;
}
