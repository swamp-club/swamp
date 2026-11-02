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

import { ensureDir } from "@std/fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
} from "@std/path";
import { TarStream, type TarStreamInput } from "@std/tar/tar-stream";
import { UntarStream } from "@std/tar/untar-stream";
import { markErrorPaths } from "../../domain/errors.ts";

/**
 * DecompressionStream is typed to emit BufferSource, which UntarStream rejects;
 * at runtime every chunk is a Uint8Array, so wrap to satisfy the TS lib types
 */
function toUint8ArrayStream(): TransformStream<BufferSource, Uint8Array> {
  return new TransformStream({
    transform(chunk, controller) {
      if (chunk instanceof Uint8Array) {
        controller.enqueue(chunk);
      } else if (chunk instanceof ArrayBuffer) {
        controller.enqueue(new Uint8Array(chunk));
      } else {
        controller.enqueue(
          new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
        );
      }
    },
  });
}

export class ArchiveSizeLimitError extends Error {
  constructor(readonly maxDecompressedBytes: number) {
    super(
      `Archive decompresses to more than ${maxDecompressedBytes} bytes`,
    );
    this.name = "ArchiveSizeLimitError";
  }
}

export interface TarGzReadOptions {
  maxDecompressedBytes?: number;
}

/**
 * erroring the transform also cancels its upstream, so the source (e.g. an
 * FsFile.readable) is released
 */
function byteLimitStream(
  maxBytes: number,
): TransformStream<Uint8Array, Uint8Array> {
  let total = 0;
  return new TransformStream({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        controller.error(new ArchiveSizeLimitError(maxBytes));
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

function untarGz(
  source: ReadableStream<Uint8Array>,
  options: TarGzReadOptions,
  signal?: AbortSignal,
) {
  // pipeThrough typings on ReadableStream<Uint8Array> are tighter than
  // DecompressionStream accepts; cast to the BufferSource-shaped stream it
  // needs
  const readable = signal ? cancelOnAbort(source, signal) : source;
  const compressed = readable as unknown as ReadableStream<BufferSource>;
  let decompressed = compressed
    .pipeThrough(new DecompressionStream("gzip"), { signal })
    .pipeThrough(toUint8ArrayStream());
  if (options.maxDecompressedBytes !== undefined) {
    decompressed = decompressed.pipeThrough(
      byteLimitStream(options.maxDecompressedBytes),
    );
  }
  return decompressed.pipeThrough(new UntarStream());
}

/**
 * aborting a pipe cancels its source only once the pending write settles, which
 * never happens on a backpressured DecompressionStream; cancel the reader
 * directly so file handles close
 */
function cancelOnAbort(
  source: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const onAbort = () => {
    reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        signal.removeEventListener("abort", onAbort);
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
    cancel(reason) {
      signal.removeEventListener("abort", onAbort);
      return reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
}

/**
 * UntarStream's readable does not forward cancellation to its input, so abort
 * the source when the consumer leaves the loop early or its file handle stays
 * open
 */
async function* abortOnEarlyExit<T>(
  stream: ReadableStream<T>,
  abort: AbortController,
): AsyncGenerator<T> {
  let finished = false;
  try {
    for await (const item of stream) yield item;
    finished = true;
  } finally {
    if (!finished) abort.abort();
  }
}

export interface ExtractedEntry {
  archivePath: string;
  targetPath: string;
  kind: TarEntryKind;
  linkname: string | null;
  mode: number;
}

/**
 * unsupported covers every typeflag not named here; UntarStream gives those a
 * body, so judging by body would read them as files
 */
export type TarEntryKind =
  | "file"
  | "directory"
  | "symlink"
  | "hardlink"
  | "character-device"
  | "block-device"
  | "fifo"
  | "unsupported";

const TAR_ENTRY_KINDS: Readonly<Record<string, TarEntryKind>> = {
  "0": "file",
  "7": "file", // contiguous file, read as a regular file
  "1": "hardlink",
  "2": "symlink",
  "3": "character-device",
  "4": "block-device",
  "5": "directory",
  "6": "fifo",
};

/** The kind of entry a typeflag records (`UntarStream` reads NUL as `0`). */
function tarEntryKind(typeflag: string): TarEntryKind {
  return Object.hasOwn(TAR_ENTRY_KINDS, typeflag)
    ? TAR_ENTRY_KINDS[typeflag]
    : "unsupported";
}

/**
 * only symlinks are created on disk; hardlinks are skipped as rare and risky
 * cross-platform
 */
function isLinkTypeflag(typeflag: string): boolean {
  return typeflag === "1" || typeflag === "2";
}

function isDirectoryTypeflag(typeflag: string): boolean {
  return typeflag === "5";
}

function ensureNoTraversal(targetPath: string, extractRoot: string): void {
  const rel = relative(extractRoot, targetPath);
  if (rel.startsWith("..") || rel === "..") {
    throw markErrorPaths(
      new Error(
        `Archive entry escapes extract root: ${targetPath}`,
      ),
      [targetPath],
    );
  }
}

/**
 * onEntry may throw to abort before bytes are written; files written before a
 * size-limit abort stay under extractRoot for the caller to remove
 */
export async function extractTarGz(
  source: ReadableStream<Uint8Array>,
  extractRoot: string,
  onEntry?: (entry: ExtractedEntry) => void | Promise<void>,
  options: TarGzReadOptions = {},
): Promise<void> {
  let root: string;
  try {
    await ensureDir(extractRoot);
    root = await Deno.realPath(extractRoot);
  } catch (error) {
    // The source has not been read yet; cancel it so a file-backed stream
    // releases its handle instead of leaking it.
    await source.cancel().catch(() => {});
    throw error;
  }

  const abort = new AbortController();
  const stream = untarGz(source, options, abort.signal);

  for await (const entry of abortOnEarlyExit(stream, abort)) {
    const typeflag = entry.header.typeflag;

    // skip PAX headers and AppleDouble resource forks so metadata files do not
    // litter the extract dir
    if (
      typeflag === "x" || typeflag === "g" || typeflag === "L" ||
      typeflag === "K"
    ) {
      if (entry.readable) await entry.readable.cancel();
      continue;
    }
    if (
      entry.path.split("/").some((seg) => seg.startsWith("._")) ||
      entry.path.startsWith("PaxHeader/") ||
      entry.path.includes("/PaxHeader/")
    ) {
      if (entry.readable) await entry.readable.cancel();
      continue;
    }

    const normalized = normalize(entry.path);
    // normalize resolves .. relative to nothing, so check the raw archive path
    // for traversal and then the resolved target
    if (
      normalized.startsWith("..") ||
      normalized === ".." ||
      normalized.startsWith("/") ||
      normalized.startsWith("\\")
    ) {
      if (entry.readable) {
        await entry.readable.cancel();
      }
      throw markErrorPaths(
        new Error(`Archive contains unsafe path: ${entry.path}`),
        [entry.path],
      );
    }

    const targetPath = join(root, normalized);
    ensureNoTraversal(targetPath, root);

    const isDir = isDirectoryTypeflag(typeflag);
    const isLink = isLinkTypeflag(typeflag);
    const isSymlink = typeflag === "2";

    const meta: ExtractedEntry = {
      archivePath: entry.path,
      targetPath,
      kind: tarEntryKind(typeflag),
      linkname: isLink ? entry.header.linkname : null,
      mode: entry.header.mode & 0o7777,
    };

    if (onEntry) {
      await onEntry(meta);
    }

    if (isDir) {
      await ensureDir(targetPath);
      continue;
    }

    if (isSymlink) {
      const linkTarget = entry.header.linkname;

      // Reject absolute symlink targets — they always escape the root.
      // `isAbsolute` handles POSIX `/`, Windows `\`, and drive-letter `C:\`.
      if (isAbsolute(linkTarget)) {
        throw markErrorPaths(
          new Error(
            `Archive contains symlink with absolute target: ${entry.path} → ${linkTarget}`,
          ),
          [entry.path, linkTarget],
        );
      }

      const resolvedLinkTarget = normalize(
        join(dirname(targetPath), linkTarget),
      );
      ensureNoTraversal(resolvedLinkTarget, root);

      // Defense-in-depth: verify the symlink's parent directory hasn't been
      // redirected outside root by an earlier symlink entry.
      await ensureDir(dirname(targetPath));
      const realSymlinkParent = await Deno.realPath(dirname(targetPath));
      ensureNoTraversal(realSymlinkParent, root);

      // Determine link type by probing the resolved symlink target — Windows
      // refuses dir symlinks pointing at a missing target without { type }.
      // POSIX ignores the `type` argument.
      let linkType: "file" | "dir" = "file";
      try {
        const stat = await Deno.stat(
          join(dirname(targetPath), linkTarget),
        );
        if (stat.isDirectory) linkType = "dir";
      } catch {
        // Broken or not-yet-extracted target — default to "file"
      }
      try {
        await Deno.symlink(linkTarget, targetPath, {
          type: linkType,
        });
      } catch (error) {
        // Some archives carry duplicate symlink entries; ignore "exists" and
        // re-throw anything else.
        if (!(error instanceof Deno.errors.AlreadyExists)) {
          throw error;
        }
      }
      continue;
    }

    if (typeflag === "1") {
      // Hardlinks are uncommon in our archives and have inconsistent
      // cross-platform semantics; skip silently.
      continue;
    }

    if (!entry.readable) {
      continue;
    }

    await ensureDir(dirname(targetPath));

    // Defense-in-depth: resolve the real path of the parent directory to
    // catch symlink-through-directory escapes where an earlier entry planted
    // a symlink that redirects this write outside the extract root.
    const realParent = await Deno.realPath(dirname(targetPath));
    ensureNoTraversal(realParent, root);

    const file = await Deno.open(targetPath, {
      write: true,
      create: true,
      truncate: true,
    });
    try {
      await entry.readable.pipeTo(file.writable);
    } catch (error) {
      // file.writable is already closed by pipeTo on error paths.
      throw error;
    }

    if (Deno.build.os !== "windows" && meta.mode > 0) {
      try {
        await Deno.chmod(targetPath, meta.mode);
      } catch {
        // Best-effort — some filesystems (e.g. mounted FAT) reject chmod.
      }
    }
  }
}

/**
 * entry bodies are still decompressed to reach the next header, so
 * maxDecompressedBytes bounds this pass too
 */
export async function listTarGzEntries(
  source: ReadableStream<Uint8Array>,
  options: TarGzReadOptions = {},
): Promise<string[]> {
  const entries: string[] = [];
  const stream = untarGz(source, options);

  for await (const entry of stream) {
    const typeflag = entry.header.typeflag;
    const skipMeta = typeflag === "x" || typeflag === "g" ||
      typeflag === "L" || typeflag === "K" ||
      entry.path.split("/").some((seg) => seg.startsWith("._")) ||
      entry.path.startsWith("PaxHeader/") ||
      entry.path.includes("/PaxHeader/");
    if (!skipMeta) {
      entries.push(entry.path);
    }
    if (entry.readable) {
      await entry.readable.cancel();
    }
  }
  return entries;
}

/**
 * Windows reports 0o666 for every file and folder, leaving folders without the
 * execute bit; record 0o755 folders and 0o644 files so POSIX extractors that
 * honour modes can enter them
 */
export async function createTarGz(
  sourceDir: string,
  archivePath: string,
  os: typeof Deno.build.os = Deno.build.os,
): Promise<void> {
  const resolvedSource = await Deno.realPath(sourceDir);
  const archiveTopName = basename(resolvedSource);
  const parent = dirname(resolvedSource);

  const inputs: TarStreamInput[] = [];
  await collectEntries(resolvedSource, parent, archiveTopName, inputs, os);

  const file = await Deno.open(archivePath, {
    write: true,
    create: true,
    truncate: true,
  });

  await ReadableStream.from(inputs)
    .pipeThrough(new TarStream())
    .pipeThrough(new CompressionStream("gzip"))
    .pipeTo(file.writable);
}

const WINDOWS_DIRECTORY_MODE = 0o755;
const WINDOWS_FILE_MODE = 0o644;

async function collectEntries(
  absPath: string,
  parent: string,
  topName: string,
  out: TarStreamInput[],
  os: typeof Deno.build.os,
): Promise<void> {
  const stat = await Deno.lstat(absPath);
  // Record the path relative to the archive root using forward slashes —
  // ustar requires POSIX separators regardless of the host OS.
  const archivePath = relative(parent, absPath).split(/\\|\//).join("/");

  if (stat.isSymlink) {
    const linkname = await Deno.readLink(absPath);
    out.push({
      type: "symlink",
      path: archivePath,
      linkname,
    });
    return;
  }

  if (stat.isDirectory) {
    // Skip macOS AppleDouble files defensively even though Deno.readDir
    // shouldn't surface them on APFS reads — guards against archives staged
    // from a hand-crafted source tree that happens to include them.
    if (basename(archivePath).startsWith("._")) {
      return;
    }
    out.push({
      type: "directory",
      path: archivePath + "/",
      options: {
        mode: os === "windows"
          ? WINDOWS_DIRECTORY_MODE
          : stat.mode ?? undefined,
      },
    });
    const children: string[] = [];
    for await (const child of Deno.readDir(absPath)) {
      if (child.name.startsWith("._")) continue;
      children.push(child.name);
    }
    children.sort();
    for (const name of children) {
      await collectEntries(join(absPath, name), parent, topName, out, os);
    }
    return;
  }

  if (stat.isFile) {
    if (basename(archivePath).startsWith("._")) {
      return;
    }
    const file = await Deno.open(absPath, { read: true });
    out.push({
      type: "file",
      path: archivePath,
      size: stat.size,
      readable: file.readable,
      options: {
        mode: os === "windows" ? WINDOWS_FILE_MODE : stat.mode ?? undefined,
      },
    });
    return;
  }
}
