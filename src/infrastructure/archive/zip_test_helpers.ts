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

export interface TestZipEntry {
  name: string;
  data: Uint8Array;
  method?: 0 | 8 | number;
  flags?: number;
  /** sizes and CRC go in a trailing descriptor; the local header carries zeros */
  dataDescriptor?: boolean;
  localExtra?: Uint8Array;
  centralExtra?: Uint8Array;
  crc32?: number;
  compressedSize?: number;
  uncompressedSize?: number;
  /** written as the body in place of data; data still sets the CRC and sizes */
  rawBody?: Uint8Array;
}

export interface TestZipOptions {
  comment?: Uint8Array;
  totalEntries?: number;
  zip64Locator?: boolean;
}

/** bitwise, unlike the reader's table, so the two cannot share a mistake */
export function referenceCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let k = 0; k < 8; k++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = ReadableStream.from([data.slice()]).pipeThrough(
    new CompressionStream("deflate-raw"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function header(size: number, fill: (view: DataView) => void): Uint8Array {
  const bytes = new Uint8Array(size);
  fill(new DataView(bytes.buffer));
  return bytes;
}

export async function buildZip(
  entries: TestZipEntry[],
  options: TestZipOptions = {},
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const method = entry.method ?? 8;
    const body = entry.rawBody ??
      (method === 8 ? await deflateRaw(entry.data) : entry.data);
    const name = encoder.encode(entry.name);
    const crc = entry.crc32 ?? referenceCrc32(entry.data);
    const compressedSize = entry.compressedSize ?? body.length;
    const uncompressedSize = entry.uncompressedSize ?? entry.data.length;
    const flags = (entry.flags ?? 0) | (entry.dataDescriptor ? 0x0008 : 0);
    const localExtra = entry.localExtra ?? new Uint8Array();
    const centralExtra = entry.centralExtra ?? new Uint8Array();
    const inLocal = !entry.dataDescriptor;

    const local = header(30, (v) => {
      v.setUint32(0, 0x04034b50, true);
      v.setUint16(4, 20, true);
      v.setUint16(6, flags, true);
      v.setUint16(8, method, true);
      v.setUint32(14, inLocal ? crc : 0, true);
      v.setUint32(18, inLocal ? compressedSize : 0, true);
      v.setUint32(22, inLocal ? uncompressedSize : 0, true);
      v.setUint16(26, name.length, true);
      v.setUint16(28, localExtra.length, true);
    });
    const descriptor = entry.dataDescriptor
      ? header(16, (v) => {
        v.setUint32(0, 0x08074b50, true);
        v.setUint32(4, crc, true);
        v.setUint32(8, compressedSize, true);
        v.setUint32(12, uncompressedSize, true);
      })
      : new Uint8Array();

    const localOffset = offset;
    for (const p of [local, name, localExtra, body, descriptor]) {
      parts.push(p);
      offset += p.length;
    }

    centrals.push(
      header(46, (v) => {
        v.setUint32(0, 0x02014b50, true);
        v.setUint16(4, 20, true);
        v.setUint16(6, 20, true);
        v.setUint16(8, flags, true);
        v.setUint16(10, method, true);
        v.setUint32(16, crc, true);
        v.setUint32(20, compressedSize, true);
        v.setUint32(24, uncompressedSize, true);
        v.setUint16(28, name.length, true);
        v.setUint16(30, centralExtra.length, true);
        v.setUint32(42, localOffset, true);
      }),
      name,
      centralExtra,
    );
  }

  const central = concat(centrals);
  const centralOffset = offset;
  parts.push(central);
  offset += central.length;

  if (options.zip64Locator) {
    parts.push(header(20, (v) => v.setUint32(0, 0x07064b50, true)));
  }

  const comment = options.comment ?? new Uint8Array();
  const total = options.totalEntries ?? entries.length;
  parts.push(
    header(22, (v) => {
      v.setUint32(0, 0x06054b50, true);
      v.setUint16(8, total, true);
      v.setUint16(10, total, true);
      v.setUint32(12, central.length, true);
      v.setUint32(16, centralOffset, true);
      v.setUint16(20, comment.length, true);
    }),
    comment,
  );
  return concat(parts);
}
