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
 * a stream-sourced put is read at commit, so the file must not change after
 * staging; the stream errors at its end if it did, and the commit fails with
 * nothing landed
 */

import { createHash } from "node:crypto";
import { markErrorPaths, UserError } from "../../domain/errors.ts";

export const STAGED_CONTENT_CHANGED_CODE = "datastore_v3_content_changed";

export interface StagedContent {
  readonly size: number;
  readonly sha256?: string;
}

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
