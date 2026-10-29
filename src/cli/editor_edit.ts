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

import type { Logger } from "@logtape/logtape";
import { markErrorPaths } from "../domain/errors.ts";
import { markModelWording, modelWording } from "../domain/behavior_wording.ts";
import { configEditConflictOf } from "../domain/datastore_v3/config_edit_conflict.ts";
import type { EditorSessionResult } from "../libswamp/editor_session.ts";

type EditedCopy = Extract<EditorSessionResult, { status: "edited" }>;

/** How a kept copy can be retried, in the words of the command at hand. */
export interface EditedCopyHints {
  /** The command a copy is piped into to retry, when a piped edit can. */
  retry?: string;
  /** The command that loads the current version after a conflict. */
  reload?: string;
  /** What to do with the copy when no piped command can retry it. */
  manual?: string;
}

/**
 * Saves an edit made in the editor with `save`, which runs the same path a
 * piped edit takes (swamp-club#4107). On success the temp copy is removed.
 * When the save throws, the copy is kept and the error names it with how to
 * retry from it, so nothing typed in the editor is lost. After a stale-edit
 * conflict the retry is refused until the current version is loaded, so the
 * hint says to load it first.
 */
export async function saveEditedCopy(
  edit: EditedCopy,
  hints: EditedCopyHints,
  save: () => Promise<void>,
): Promise<void> {
  try {
    await save();
  } catch (error) {
    if (error instanceof Error) {
      const suffix = `\nYour edit is kept at ${edit.tempPath}.` +
        retryHint(error, edit.tempPath, hints);
      // `swamp model edit` prints the error's model spelling, a separate
      // copy of the message, so it gets the same suffix.
      const modelText = modelWording(error);
      error.message += suffix;
      if (modelText !== undefined) markModelWording(error, modelText + suffix);
      markErrorPaths(error, [edit.tempPath]);
    }
    throw error;
  }
  await edit.discard();
}

function retryHint(
  error: unknown,
  path: string,
  hints: EditedCopyHints,
): string {
  if (hints.retry === undefined) {
    return hints.manual === undefined ? "" : ` ${hints.manual}`;
  }
  if (configEditConflictOf(error) !== undefined && hints.reload !== undefined) {
    return ` Load the current version with '${hints.reload}', apply your ` +
      `change to the copy, then retry with: ${hints.retry} < ${path}`;
  }
  return ` Fix it and retry with: ${hints.retry} < ${path}`;
}

/**
 * Warns when an editor that is not known to wait returned with nothing
 * changed: it may have handed the file to another process before the person
 * saved, so the copy was kept and can be saved by piping it.
 */
export function warnIfCopyKept(
  edit: Extract<EditorSessionResult, { status: "unchanged" }>,
  hints: EditedCopyHints,
  logger: Logger,
): void {
  if (edit.keptPath === undefined) return;
  const next = hints.retry !== undefined
    ? `then run: ${hints.retry} < ${edit.keptPath}`
    : `then, with the copy at ${edit.keptPath}: ${hints.manual ?? ""}`;
  logger.warn(
    "{editor} returned without changes. If it opened the file in another " +
      "window, save there, {next}. To have swamp wait, set EDITOR to an " +
      "editor that waits for the file to close.",
    { editor: edit.editor, next },
  );
}
