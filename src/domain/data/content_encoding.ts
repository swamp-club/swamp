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

export type ContentEncoding = "utf-8" | "base64";

export interface EncodedContent {
  readonly content: string;
  readonly contentEncoding: ContentEncoding;
}

/**
 * valid UTF-8 is text; anything else is base64, since a lenient decode would
 * replace invalid bytes with U+FFFD; depends on the bytes, not the declared
 * content type
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
