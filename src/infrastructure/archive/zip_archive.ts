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

import { toUint8ArrayStream } from "./tar_archive.ts";

export class ZipArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipArchiveError";
  }
}

export interface ZipExtractOptions {
  signal?: AbortSignal;
}

const END_RECORD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const END_RECORD_SIZE = 22;
const ZIP64_LOCATOR_SIZE = 20;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;
const MAX_COMMENT_SIZE = 0xffff;
const ZIP64_U16 = 0xffff;
const ZIP64_U32 = 0xffffffff;
const FLAG_ENCRYPTED = 0x0001;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;
const READ_CHUNK_SIZE = 64 * 1024;

interface CentralEntry {
  flags: number;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32Update(crc: number, bytes: Uint8Array): number {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

async function readAt(
  file: Deno.FsFile,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  await file.seek(offset, Deno.SeekMode.Start);
  const buf = new Uint8Array(length);
  let filled = 0;
  while (filled < length) {
    const n = await file.read(buf.subarray(filled));
    if (n === null) throw new ZipArchiveError("archive is truncated");
    filled += n;
  }
  return buf;
}

/**
 * a candidate counts only when its comment ends exactly at end of file, so the
 * signature bytes inside a comment are never taken for the record
 */
function findEndRecord(tail: Uint8Array): number {
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  for (let i = tail.length - END_RECORD_SIZE; i >= 0; i--) {
    if (
      view.getUint32(i, true) === END_RECORD_SIGNATURE &&
      i + END_RECORD_SIZE + view.getUint16(i + 20, true) === tail.length
    ) {
      return i;
    }
  }
  throw new ZipArchiveError(
    "no end-of-central-directory record; not a zip archive",
  );
}

async function findEntry(
  file: Deno.FsFile,
  fileSize: number,
  entryName: string,
): Promise<{ entry: CentralEntry; centralDirectoryOffset: number }> {
  const tailLength = Math.min(fileSize, END_RECORD_SIZE + MAX_COMMENT_SIZE);
  const tail = await readAt(file, fileSize - tailLength, tailLength);
  const endAt = findEndRecord(tail);
  const end = new DataView(tail.buffer, endAt, END_RECORD_SIZE);

  const diskNumber = end.getUint16(4, true);
  const centralDisk = end.getUint16(6, true);
  const entriesOnDisk = end.getUint16(8, true);
  const totalEntries = end.getUint16(10, true);
  const centralSize = end.getUint32(12, true);
  const centralOffset = end.getUint32(16, true);

  const hasZip64Locator = endAt >= ZIP64_LOCATOR_SIZE &&
    new DataView(tail.buffer, endAt - ZIP64_LOCATOR_SIZE, 4).getUint32(
        0,
        true,
      ) === ZIP64_LOCATOR_SIGNATURE;
  if (
    hasZip64Locator || totalEntries === ZIP64_U16 ||
    centralSize === ZIP64_U32 || centralOffset === ZIP64_U32
  ) {
    throw new ZipArchiveError("zip64 archives are not supported");
  }
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw new ZipArchiveError("multi-disk zip archives are not supported");
  }
  const endRecordOffset = fileSize - tailLength + endAt;
  if (centralOffset + centralSize > endRecordOffset) {
    throw new ZipArchiveError(
      "central directory runs past the end-of-central-directory record",
    );
  }

  const central = await readAt(file, centralOffset, centralSize);
  const view = new DataView(central.buffer);
  const wanted = new TextEncoder().encode(entryName);
  let found: CentralEntry | undefined;
  let p = 0;
  for (let i = 0; i < totalEntries; i++) {
    if (
      p + CENTRAL_HEADER_SIZE > central.length ||
      view.getUint32(p, true) !== CENTRAL_HEADER_SIGNATURE
    ) {
      throw new ZipArchiveError("central directory is corrupt");
    }
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    const next = p + CENTRAL_HEADER_SIZE + nameLength + extraLength +
      commentLength;
    if (next > central.length) {
      throw new ZipArchiveError("central directory is corrupt");
    }
    const name = central.subarray(
      p + CENTRAL_HEADER_SIZE,
      p + CENTRAL_HEADER_SIZE + nameLength,
    );
    if (
      name.length === wanted.length && name.every((b, j) => b === wanted[j])
    ) {
      // two entries under one name could be read differently by other tools
      if (found) {
        throw new ZipArchiveError(
          `archive has more than one entry named ${entryName}`,
        );
      }
      found = {
        flags: view.getUint16(p + 8, true),
        method: view.getUint16(p + 10, true),
        crc32: view.getUint32(p + 16, true),
        compressedSize: view.getUint32(p + 20, true),
        uncompressedSize: view.getUint32(p + 24, true),
        localHeaderOffset: view.getUint32(p + 42, true),
      };
    }
    p = next;
  }
  if (!found) {
    throw new ZipArchiveError(`archive has no entry named ${entryName}`);
  }
  return { entry: found, centralDirectoryOffset: centralOffset };
}

function rangeStream(
  file: Deno.FsFile,
  length: number,
): ReadableStream<Uint8Array> {
  let remaining = length;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (remaining === 0) {
        controller.close();
        return;
      }
      const buf = new Uint8Array(Math.min(READ_CHUNK_SIZE, remaining));
      const n = await file.read(buf);
      if (n === null) {
        controller.error(new ZipArchiveError("archive is truncated"));
        return;
      }
      remaining -= n;
      controller.enqueue(buf.subarray(0, n));
    },
  }, { highWaterMark: 0 });
}

async function writeAll(file: Deno.FsFile, bytes: Uint8Array): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    written += await file.write(bytes.subarray(written));
  }
}

/**
 * sizes and CRC come from the central directory, never the local header, so
 * entries written with a data descriptor read the same; destPath is the
 * caller's, so no name inside the archive ever becomes a path
 */
export async function extractZipEntry(
  archivePath: string,
  entryName: string,
  destPath: string,
  options: ZipExtractOptions = {},
): Promise<void> {
  const { signal } = options;
  signal?.throwIfAborted();
  const file = await Deno.open(archivePath, { read: true });
  let out: Deno.FsFile | undefined;
  try {
    const fileSize = (await file.stat()).size;
    const { entry, centralDirectoryOffset } = await findEntry(
      file,
      fileSize,
      entryName,
    );

    if (entry.flags & FLAG_ENCRYPTED) {
      throw new ZipArchiveError(`entry ${entryName} is encrypted`);
    }
    if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATED) {
      throw new ZipArchiveError(
        `entry ${entryName} uses unsupported compression method ${entry.method}`,
      );
    }
    if (
      entry.compressedSize === ZIP64_U32 ||
      entry.uncompressedSize === ZIP64_U32 ||
      entry.localHeaderOffset === ZIP64_U32
    ) {
      throw new ZipArchiveError("zip64 archives are not supported");
    }
    if (
      entry.method === METHOD_STORED &&
      entry.compressedSize !== entry.uncompressedSize
    ) {
      throw new ZipArchiveError(
        `entry ${entryName} is stored but its sizes differ`,
      );
    }

    if (entry.localHeaderOffset + LOCAL_HEADER_SIZE > centralDirectoryOffset) {
      throw new ZipArchiveError(
        `entry ${entryName} has a local header past the central directory`,
      );
    }
    const local = new DataView(
      (await readAt(file, entry.localHeaderOffset, LOCAL_HEADER_SIZE)).buffer,
    );
    if (local.getUint32(0, true) !== LOCAL_HEADER_SIGNATURE) {
      throw new ZipArchiveError(
        `entry ${entryName} has a corrupt local header`,
      );
    }
    const dataStart = entry.localHeaderOffset + LOCAL_HEADER_SIZE +
      local.getUint16(26, true) + local.getUint16(28, true);
    if (dataStart + entry.compressedSize > centralDirectoryOffset) {
      throw new ZipArchiveError(
        `entry ${entryName} data runs past the central directory`,
      );
    }

    await file.seek(dataStart, Deno.SeekMode.Start);
    let stream = rangeStream(file, entry.compressedSize);
    if (entry.method === METHOD_DEFLATED) {
      stream = (stream as unknown as ReadableStream<BufferSource>)
        .pipeThrough(new DecompressionStream("deflate-raw"))
        .pipeThrough(toUint8ArrayStream());
    }

    out = await Deno.open(destPath, {
      write: true,
      create: true,
      truncate: true,
    });
    const reader = stream.getReader();
    let total = 0;
    let crc = 0;
    try {
      while (true) {
        signal?.throwIfAborted();
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          // DecompressionStream reports corrupt input as a TypeError
          if (error instanceof TypeError) {
            throw new ZipArchiveError(
              `entry ${entryName} has corrupt compressed data: ${error.message}`,
            );
          }
          throw error;
        }
        if (chunk.done) break;
        total += chunk.value.length;
        if (total > entry.uncompressedSize) {
          throw new ZipArchiveError(
            `entry ${entryName} decompresses to more than its declared ${entry.uncompressedSize} bytes`,
          );
        }
        crc = crc32Update(crc, chunk.value);
        await writeAll(out, chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }

    if (total !== entry.uncompressedSize) {
      throw new ZipArchiveError(
        `entry ${entryName} decompressed to ${total} bytes, expected ${entry.uncompressedSize}`,
      );
    }
    if (crc !== entry.crc32) {
      throw new ZipArchiveError(`entry ${entryName} failed its CRC-32 check`);
    }
    out.close();
    out = undefined;
  } catch (error) {
    if (out) {
      out.close();
      await Deno.remove(destPath).catch(() => {});
    }
    throw error;
  } finally {
    file.close();
  }
}
