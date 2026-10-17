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

/**
 * A content file's stream, checked against what was staged
 * (swamp-club#3564). A stream-sourced put is read when its unit commits,
 * not when it is staged, so the file must not change in between; if it did
 * (a reader catching up over a stalled writer's checkout), the commit would
 * carry bytes its metadata does not describe. The stream errors at its end
 * instead, and the unit's commit fails with nothing landed.
 *
 * @module
 */

import { createHash } from "node:crypto";
import { markErrorPaths, UserError } from "../../domain/errors.ts";

/** Error code for a content file that changed between staging and commit. */
export const STAGED_CONTENT_CHANGED_CODE = "datastore_v3_content_changed";

/** What a content file held when its put was staged. */
export interface StagedContent {
  readonly size: number;
  /** Its SHA-256, hex, when the staging knew it. */
  readonly sha256?: string;
}

/** A content file no longer holds what its staged put described. */
export class StagedContentChangedError extends UserError {
  constructor(path: string, what: string) {
    super(
      `The content file ${path} changed after it was staged (${what}), so ` +
        `it was not committed. Another process may have rewritten this ` +
        `checkout's files; run the command again.`,
      STAGED_CONTENT_CHANGED_CODE,
    );
    this.name = "StagedContentChangedError";
  }
}

/**
 * `stream`, the content of `path`, erroring at its end with
 * {@link StagedContentChangedError} when its length or digest is not what
 * `staged` says.
 */
export function verifiedContentStream(
  stream: ReadableStream<Uint8Array>,
  path: string,
  staged: StagedContent,
): ReadableStream<Uint8Array> {
  const hash = staged.sha256 !== undefined ? createHash("sha256") : undefined;
  let size = 0;
  const changed = (what: string) =>
    markErrorPaths(new StagedContentChangedError(path, what), [path]);
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.length;
        if (size > staged.size) {
          throw changed(`more than the ${staged.size} bytes staged`);
        }
        hash?.update(chunk);
        controller.enqueue(chunk);
      },
      flush() {
        if (size !== staged.size) {
          throw changed(`${size} bytes, not the ${staged.size} staged`);
        }
        if (hash !== undefined && hash.digest("hex") !== staged.sha256) {
          throw changed("its digest is not the one staged");
        }
      },
    }),
  );
}
