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
 * chunked so decoding a large file of lines neither holds the event loop nor
 * hits V8's string limit
 */
export const NDJSON_CHUNK_BYTES = 1024 * 1024;

const NEWLINE = 10;

/** ends on a line boundary, so no line is split between two decodes */
export function chunkEnd(
  content: Uint8Array,
  start: number,
  chunkBytes = NDJSON_CHUNK_BYTES,
): number {
  const limit = start + chunkBytes;
  if (limit >= content.length) return content.length;
  const last = content.lastIndexOf(NEWLINE, limit - 1);
  if (last >= start) return last + 1;
  const next = content.indexOf(NEWLINE, limit);
  return next === -1 ? content.length : next + 1;
}
