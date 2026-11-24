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

import { UserError } from "../domain/errors.ts";

// escaping can multiply a slice up to sixfold, still well under the frame cap
export const CONTENT_PART_CHARS = 4 * 1024 * 1024;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** content in slices of at most chars, a surrogate pair kept whole unless chars is 1 */
export function* contentPieces(
  content: string,
  chars: number = CONTENT_PART_CHARS,
): Generator<string> {
  let start = 0;
  while (start < content.length) {
    let end = Math.min(start + chars, content.length);
    if (
      end < content.length && end - start > 1 &&
      isHighSurrogate(content.charCodeAt(end - 1))
    ) {
      end--;
    }
    yield content.slice(start, end);
    start = end;
  }
}

/**
 * the content the parts were cut from; a count or length that differs from the
 * reply's means the parts were not all received, and is refused, not shown short
 */
export function assembleDataGetContent(
  parts: unknown[],
  contentParts: number,
  contentLength: number | undefined,
): string {
  if (typeof contentLength !== "number") {
    throw new UserError(
      "The server sent content parts without their length. Run the command again.",
    );
  }
  if (parts.length !== contentParts) {
    throw new UserError(
      `The server sent ${parts.length} of the ${contentParts} content parts it reported. Run the command again.`,
    );
  }
  const pieces: string[] = [];
  for (const part of parts) {
    const piece = part !== null && typeof part === "object"
      ? (part as { content?: unknown }).content
      : undefined;
    if (typeof piece !== "string") {
      throw new UserError(
        "The server sent a content part without content. Run the command again.",
      );
    }
    pieces.push(piece);
  }
  // clears the caller's array, so it does not keep the parts alive beside the joined content
  parts.length = 0;
  const content = pieces.join("");
  if (content.length !== contentLength) {
    throw new UserError(
      `The server sent ${content.length} of the ${contentLength} content characters it reported. Run the command again.`,
    );
  }
  return content;
}
