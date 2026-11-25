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

import {
  type LoadedItemRef,
  type ResourceLoadGuard,
  ResourceTooLargeToLoadError,
} from "./resource_load_guard.ts";

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

function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/**
 * encodeContent once the guard admits the bytes; heldBytes and remedy are for
 * a read that holds several items, as refusalFor takes them
 */
export function encodeLoadableContent(
  guard: ResourceLoadGuard,
  item: LoadedItemRef,
  bytes: Uint8Array,
  heldBytes = 0,
  remedy?: string,
): EncodedContent {
  const refusal = guard.refusalFor(item, bytes.length, heldBytes, remedy);
  if (refusal) throw refusal;
  const encodedChars = base64Length(bytes.length);
  if (encodedChars <= guard.maxDecodableBytes) return encodeContent(bytes);
  // only UTF-8 text of this size fits in a string; its base64 form would not
  try {
    return {
      content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      contentEncoding: "utf-8",
    };
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new ResourceTooLargeToLoadError(item, bytes.length, "text-length", {
      encodedChars,
    });
  }
}

export interface ContentPreview {
  readonly text: string;
  readonly truncated: boolean;
}

/** the first maxBytes as text; a character cut at the end is dropped */
export function decodePreview(
  bytes: Uint8Array,
  maxBytes: number,
): ContentPreview {
  if (bytes.length <= maxBytes) {
    return { text: new TextDecoder().decode(bytes), truncated: false };
  }
  return {
    text: new TextDecoder().decode(bytes.subarray(0, maxBytes), {
      stream: true,
    }),
    truncated: true,
  };
}
