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

/** One entry of a hand-built tar archive. */
export interface RawTarEntry {
  /** Header path, at most 100 bytes, written as given. */
  path: string;
  /** The header's typeflag byte, e.g. `0`, `1`, `2`, `6` or `Z`. */
  typeflag: string;
  /** The entry's body; its length is the header's size. */
  body?: string;
  linkname?: string;
}

const encoder = new TextEncoder();

function writeField(
  header: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void {
  const bytes = encoder.encode(value);
  if (bytes.length > length) {
    throw new Error(`tar header field too long: ${value}`);
  }
  header.set(bytes, offset);
}

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0");
}

function ustarHeader(
  entry: RawTarEntry,
  size: number,
): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(512);
  writeField(header, 0, 100, entry.path);
  writeField(header, 100, 8, octal(0o644, 8));
  writeField(header, 108, 8, octal(0, 8));
  writeField(header, 116, 8, octal(0, 8));
  writeField(header, 124, 12, octal(size, 12));
  writeField(header, 136, 12, octal(0, 12));
  writeField(header, 156, 1, entry.typeflag);
  writeField(header, 157, 100, entry.linkname ?? "");
  writeField(header, 257, 6, "ustar\0");
  writeField(header, 263, 2, "00");
  writeField(header, 329, 8, octal(0, 8));
  writeField(header, 337, 8, octal(0, 8));
  // The checksum is summed with its own field read as spaces.
  header.fill(0x20, 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  writeField(header, 148, 8, `${octal(sum, 7)}\0`);
  return header;
}

/**
 * A `.tar.gz` holding exactly `entries`, header by header, for entry kinds
 * `TarStream` cannot write: hardlinks, devices, FIFOs, unknown typeflags,
 * and symlinks without creating one on disk.
 */
export async function buildRawTarGz(
  entries: readonly RawTarEntry[],
): Promise<Uint8Array> {
  const blocks: Uint8Array<ArrayBuffer>[] = [];
  for (const entry of entries) {
    const body = encoder.encode(entry.body ?? "");
    blocks.push(ustarHeader(entry, body.length));
    if (body.length > 0) {
      const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
      padded.set(body);
      blocks.push(padded);
    }
  }
  blocks.push(new Uint8Array(1024));
  const compressed = new Blob(blocks).stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}
