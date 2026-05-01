// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { basename, dirname, join, normalize, relative } from "@std/path";
import { TarStream, type TarStreamInput } from "@std/tar/tar-stream";
import { UntarStream } from "@std/tar/untar-stream";

/**
 * `DecompressionStream` is typed to emit `BufferSource`, which TypeScript
 * doesn't accept where `UntarStream` expects `Uint8Array`. Wrap each chunk
 * defensively so the TS lib types line up; at runtime every chunk really is
 * a `Uint8Array` from the gzip decoder.
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

/**
 * An entry written by the tar reader during streaming extraction.
 *
 * The entry holds the raw tar header along with an absolute target path
 * (derived from the configured extraction root) so callers can apply
 * additional validation — e.g. symlink-escape checks — before any bytes hit
 * disk.
 */
export interface ExtractedEntry {
  /** Path inside the archive (as recorded in the tar header). */
  archivePath: string;
  /** The fully-resolved on-disk target path. */
  targetPath: string;
  /** Whether the entry is a regular file. */
  isFile: boolean;
  /** Whether the entry is a directory. */
  isDirectory: boolean;
  /** Whether the entry is a symlink. */
  isSymlink: boolean;
  /** Symlink target as recorded in the header (only set for symlinks). */
  linkname: string | null;
  /** POSIX mode bits as recorded in the header. */
  mode: number;
}

/**
 * Whether a tar typeflag indicates a hardlink (typeflag '1') or a symlink
 * (typeflag '2'). We treat both as link-typed entries; only symlinks are
 * created on disk, hardlinks are skipped (they're vanishingly rare in our
 * archives and risky cross-platform).
 */
function isLinkTypeflag(typeflag: string): boolean {
  return typeflag === "1" || typeflag === "2";
}

function isDirectoryTypeflag(typeflag: string): boolean {
  return typeflag === "5";
}

/**
 * Validates that `targetPath` stays within `extractRoot`. Throws when the
 * archive entry's path resolves outside the root (the classic ../ traversal
 * attack against tar extraction).
 */
function ensureNoTraversal(targetPath: string, extractRoot: string): void {
  const rel = relative(extractRoot, targetPath);
  if (rel.startsWith("..") || rel === "..") {
    throw new Error(
      `Archive entry escapes extract root: ${targetPath}`,
    );
  }
}

/**
 * Streams a `.tar.gz` byte stream into `extractRoot`, calling `onEntry` for
 * each entry before any bytes are written. `onEntry` may throw to abort
 * extraction (e.g. on a path-traversal violation discovered during validation).
 *
 * Behavior preserved from the previous shell-out:
 * - Symlinks are recreated as symlinks (not dereferenced).
 * - File modes are honored where present in the archive header.
 * - Path-traversal entries (`../foo`) abort extraction with an error.
 *
 * Note: macOS resource-fork files (`._foo`) leak into archives only when the
 * archiver is the BSD `tar` binary on darwin reading from an HFS+/APFS source
 * tree. Since we now produce archives via `TarStream` from explicit per-file
 * input, those AppleDouble files cannot appear unless a caller explicitly
 * adds them — there is no equivalent of the `COPYFILE_DISABLE=1` env var
 * because the underlying mechanism doesn't run.
 */
export async function extractTarGz(
  source: ReadableStream<Uint8Array>,
  extractRoot: string,
  onEntry?: (entry: ExtractedEntry) => void | Promise<void>,
): Promise<void> {
  await ensureDir(extractRoot);
  const root = await Deno.realPath(extractRoot);

  // `pipeThrough` typings on `ReadableStream<Uint8Array>` are tighter than
  // what `DecompressionStream` accepts as its writable side; cast to the
  // BufferSource-shaped stream that `DecompressionStream` actually needs.
  const compressed = source as unknown as ReadableStream<BufferSource>;
  const stream = compressed
    .pipeThrough(new DecompressionStream("gzip"))
    .pipeThrough(toUint8ArrayStream())
    .pipeThrough(new UntarStream());

  for await (const entry of stream) {
    const typeflag = entry.header.typeflag;

    // PAX extended-header entries (typeflag 'x' / 'g') and macOS AppleDouble
    // resource forks (`._foo`) are noise injected by BSD `tar` on darwin
    // sources. They have no place in our archives — skip them so we don't
    // litter the extract dir with metadata files.
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
    // `normalize` resolves `..` segments relative to nothing; check the raw
    // archive path for traversal attempts, then again on the resolved target.
    if (
      normalized.startsWith("..") ||
      normalized === ".." ||
      normalized.startsWith("/") ||
      normalized.startsWith("\\")
    ) {
      // Drain any readable to release the lock so the next entry can resolve.
      if (entry.readable) {
        await entry.readable.cancel();
      }
      throw new Error(`Archive contains unsafe path: ${entry.path}`);
    }

    const targetPath = join(root, normalized);
    ensureNoTraversal(targetPath, root);

    const isDir = isDirectoryTypeflag(typeflag);
    const isLink = isLinkTypeflag(typeflag);
    const isSymlink = typeflag === "2";
    const isFile = !isDir && !isLink && entry.readable !== undefined;

    const meta: ExtractedEntry = {
      archivePath: entry.path,
      targetPath,
      isFile,
      isDirectory: isDir,
      isSymlink,
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
      // Determine link type by probing the resolved symlink target — Windows
      // refuses dir symlinks pointing at a missing target without { type }.
      // POSIX ignores the `type` argument.
      let linkType: "file" | "dir" = "file";
      try {
        const stat = await Deno.stat(
          join(dirname(targetPath), entry.header.linkname),
        );
        if (stat.isDirectory) linkType = "dir";
      } catch {
        // Broken or not-yet-extracted target — default to "file"
      }
      try {
        await Deno.symlink(entry.header.linkname, targetPath, {
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
      // Other typeflags (block/char devices, FIFOs, etc.) — skip.
      continue;
    }

    await ensureDir(dirname(targetPath));
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
 * Reads a `.tar.gz` byte stream and returns the list of archive paths without
 * writing anything to disk. Used for pre-extraction safety checks (e.g.
 * "archive contains unsafe path").
 */
export async function listTarGzEntries(
  source: ReadableStream<Uint8Array>,
): Promise<string[]> {
  const entries: string[] = [];
  const compressed = source as unknown as ReadableStream<BufferSource>;
  const stream = compressed
    .pipeThrough(new DecompressionStream("gzip"))
    .pipeThrough(toUint8ArrayStream())
    .pipeThrough(new UntarStream());

  for await (const entry of stream) {
    const typeflag = entry.header.typeflag;
    // Skip PAX extended-header and macOS AppleDouble companion entries —
    // see extractTarGz for the matching filter.
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
 * Recursively walks `sourceDir` and writes a gzip-compressed tar archive to
 * `archivePath`. The archive paths are relative to `sourceDir.parent`, so
 * passing `/tmp/foo/extension` writes entries like `extension/...`,
 * matching `tar -czf out.tar.gz -C /tmp/foo extension`.
 *
 * AppleDouble files (`._foo`) are not produced because we walk the source
 * tree explicitly via `Deno.readDir` rather than asking BSD `tar` to copy
 * extended attributes — the underlying mechanism doesn't run.
 */
export async function createTarGz(
  sourceDir: string,
  archivePath: string,
): Promise<void> {
  const resolvedSource = await Deno.realPath(sourceDir);
  const archiveTopName = basename(resolvedSource);
  const parent = dirname(resolvedSource);

  const inputs: TarStreamInput[] = [];
  await collectEntries(resolvedSource, parent, archiveTopName, inputs);

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

async function collectEntries(
  absPath: string,
  parent: string,
  topName: string,
  out: TarStreamInput[],
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
      options: { mode: stat.mode ?? undefined },
    });
    const children: string[] = [];
    for await (const child of Deno.readDir(absPath)) {
      if (child.name.startsWith("._")) continue;
      children.push(child.name);
    }
    children.sort();
    for (const name of children) {
      await collectEntries(join(absPath, name), parent, topName, out);
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
      options: { mode: stat.mode ?? undefined },
    });
    return;
  }

  // Sockets, FIFOs, devices, etc. — skip.
}
