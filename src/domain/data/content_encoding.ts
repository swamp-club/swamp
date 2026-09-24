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
 * How artifact content is represented as a string: `utf-8` is the decoded
 * text, `base64` is the bytes base64-encoded.
 */
export type ContentEncoding = "utf-8" | "base64";

/** Artifact content as a string, with the encoding needed to read it back. */
export interface EncodedContent {
  readonly content: string;
  readonly contentEncoding: ContentEncoding;
}

/**
 * Represents artifact bytes as a string without losing any of them.
 *
 * Valid UTF-8 is returned as text (a leading byte-order mark is dropped, as
 * `TextDecoder` does by default). Anything else is base64-encoded, because a
 * lenient decode would replace each invalid byte with U+FFFD. The choice
 * depends on the bytes, not on the declared content type.
 */
export function encodeContent(bytes: Uint8Array): EncodedContent {
  try {
    return {
      content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      contentEncoding: "utf-8",
    };
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return { content: bytes.toBase64(), contentEncoding: "base64" };
  }
}
