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

import { UserError } from "../errors.ts";

/** The largest task, in UTF-8 bytes, a start session accepts. */
export const MAX_TASK_BYTES = 32 * 1024;

/** The longest task title before it is cut and "…" appended. */
export const MAX_TITLE_CHARS = 120;

/**
 * What the user asked their agent to do, as typed in the start page.
 *
 * The text is kept verbatim (only outer whitespace is trimmed) because it
 * goes into the brief unchanged; Swamp hosts no model and never summarises
 * or interprets it.
 */
export class StartTask {
  private constructor(readonly text: string) {}

  static create(text: string): StartTask {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      throw new UserError("Describe the task before continuing.");
    }
    if (new TextEncoder().encode(trimmed).length > MAX_TASK_BYTES) {
      throw new UserError(
        `The task is longer than ${
          MAX_TASK_BYTES / 1024
        } KiB. Shorten it and try again.`,
      );
    }
    return new StartTask(trimmed);
  }

  /** The first non-empty line, cut to {@link MAX_TITLE_CHARS} characters. */
  title(): string {
    const first =
      this.text.split(/\r\n|\r|\n/).map((l) => l.trim()).find((l) =>
        l.length > 0
      ) ??
        "";
    const chars = Array.from(first);
    return chars.length > MAX_TITLE_CHARS
      ? chars.slice(0, MAX_TITLE_CHARS).join("") + "…"
      : first;
  }
}
