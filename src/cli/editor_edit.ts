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

import type { EditorSessionResult } from "../libswamp/editor_session.ts";

type EditedCopy = Extract<EditorSessionResult, { status: "edited" }>;

/**
 * Saves an edit made in the editor with `save`, which runs the same path a
 * piped edit takes (swamp-club#4107). On success the temp copy is removed.
 * When the save throws, the copy is kept and the error names it, with the
 * command that retries the edit from it when there is one, so nothing typed
 * in the editor is lost.
 */
export async function saveEditedCopy(
  edit: EditedCopy,
  retryCommand: string | undefined,
  save: () => Promise<void>,
): Promise<void> {
  try {
    await save();
  } catch (error) {
    if (error instanceof Error) {
      error.message = `${error.message}\n` +
        `Your edit is kept at ${edit.tempPath}.` +
        (retryCommand === undefined
          ? ""
          : ` Fix it and retry with: ${retryCommand} < ${edit.tempPath}`);
    }
    throw error;
  }
  await edit.discard();
}
