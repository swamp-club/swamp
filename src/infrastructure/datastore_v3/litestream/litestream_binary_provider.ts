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
 * Obtains a verified Litestream binary for v3 replication (swamp-club#3358).
 *
 * The binary sees bucket credentials and every commit, so a binary that does
 * not hash to the pin is never returned. {@link LitestreamBinaryProvider.resolve}
 * hashes it on every call, and callers call it before every start.
 *
 * Where the binary comes from, in order:
 *
 * 1. `SWAMP_LITESTREAM_PATH`, for offline machines and the serve Docker
 *    image. Checked against the pin, never copied.
 * 2. The cache, `<swamp data dir>/litestream/<version>/`. A version directory
 *    whose binary is missing or does not match is refused, never replaced:
 *    the user deletes the directory.
 * 3. Upstream's GitHub release. The archive is hashed before anything is
 *    extracted, the binary after. It is staged in a temp directory beside
 *    the cache and renamed into place, so two processes racing on first use
 *    settle on whichever rename lands first, and the other one hashes the
 *    winner's binary.
 *
 * Dormant: nothing in production calls it until the Litestream sidecar
 * (Phase 4D) does. `integration/datastore_v3_rules_test.ts` pins that.
 */

import { join } from "@std/path";
import { markErrorPaths, UserError } from "../../../domain/errors.ts";
import { computeChecksum } from "../../../domain/models/checksum.ts";
import {
  litestreamArchiveName,
  litestreamArchiveUrl,
  litestreamAvailability,
  litestreamBinaryName,
  type LitestreamPin,
  type LitestreamTarget,
} from "../../../domain/datastore_v3/litestream_release.ts";
import { extractTarGz } from "../../archive/tar_archive.ts";
import type { Fetcher } from "../../http/recording_fetcher.ts";
import { getSwampDataDir } from "../../persistence/paths.ts";
import { LITESTREAM_PIN } from "./litestream_pin.ts";

/** The environment variable naming a binary the user installed themselves. */
export const LITESTREAM_PATH_ENV = "SWAMP_LITESTREAM_PATH";

/** The cache's directory under the swamp data dir. */
export const LITESTREAM_CACHE_DIR = "litestream";

/** Upstream archives are 13–14 MB; anything far past that is not one. */
export const DEFAULT_MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;

/** The binary is about 40 MB unpacked. */
export const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024;

export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/** Staging directories older than this were left by a crashed process. */
export const ABANDONED_STAGING_MAX_AGE_MS = 10 * 60 * 1000;

const STAGING_PREFIX = ".tmp-";
const EXTRACT_SUBDIR = ".extract";
const LICENSE_FILE = "LICENSE";

/** Litestream cannot be obtained or cannot run here. */
export class LitestreamUnavailableError extends UserError {
  constructor(message: string) {
    super(message, "litestream_unavailable");
    this.name = "LitestreamUnavailableError";
  }
}

/** A binary or archive does not hash to the pin, so it is never run. */
export class LitestreamIntegrityError extends UserError {
  constructor(message: string) {
    super(message, "litestream_integrity");
    this.name = "LitestreamIntegrityError";
  }
}

/** The filesystem operations the provider needs. */
export interface LitestreamFs {
  /** The file's bytes, or undefined when it does not exist. */
  readFile(path: string): Promise<Uint8Array | undefined>;
  /** Whether anything exists at the path. */
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  makeTempDir(dir: string, prefix: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  /**
   * Directories under `dir` whose names start with `prefix`, with their
   * modification time in ms. One removed while it is listed is left out.
   */
  listDirs(
    dir: string,
    prefix: string,
  ): Promise<{ name: string; mtimeMs: number }[]>;
}

/** Unpacks an archive's whole contents into `destDir`. */
export type LitestreamArchiveExtractor = (
  archive: Uint8Array,
  archiveName: string,
  destDir: string,
) => Promise<void>;

export interface LitestreamBinaryProviderOptions {
  /** The swamp data dir; the cache lives in its `litestream/` directory. */
  readonly dataDir: string;
  /** The value of `SWAMP_LITESTREAM_PATH`, if set. */
  readonly overridePath?: string;
  readonly pin?: LitestreamPin;
  readonly os?: string;
  readonly arch?: string;
  readonly fetch?: Fetcher;
  readonly fs?: LitestreamFs;
  readonly extract?: LitestreamArchiveExtractor;
  /** Clears macOS quarantine from a freshly installed binary. */
  readonly clearQuarantine?: (path: string) => Promise<void>;
  readonly downloadTimeoutMs?: number;
  readonly maxDownloadBytes?: number;
  readonly now?: () => number;
}

export interface ResolvedLitestreamBinary {
  readonly path: string;
  readonly version: string;
  readonly source: "override" | "cache" | "download";
}

/** A path's modification time in ms, or undefined once it is gone. */
export async function modificationTimeMs(
  path: string,
): Promise<number | undefined> {
  try {
    return (await Deno.lstat(path)).mtime?.getTime() ?? 0;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

export const denoLitestreamFs: LitestreamFs = {
  async readFile(path) {
    try {
      return await Deno.readFile(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    }
  },
  async exists(path) {
    try {
      await Deno.lstat(path);
      return true;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      throw error;
    }
  },
  async mkdir(path) {
    await Deno.mkdir(path, { recursive: true });
  },
  makeTempDir(dir, prefix) {
    return Deno.makeTempDir({ dir, prefix });
  },
  rename(from, to) {
    return Deno.rename(from, to);
  },
  async remove(path) {
    try {
      await Deno.remove(path, { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  },
  async chmod(path, mode) {
    // Windows has no mode bits; Deno.chmod throws there.
    if (Deno.build.os !== "windows") await Deno.chmod(path, mode);
  },
  async listDirs(dir, prefix) {
    const dirs: { name: string; mtimeMs: number }[] = [];
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isDirectory || !entry.name.startsWith(prefix)) continue;
      // Another process may rename or remove its staging dir between the
      // listing and the stat.
      const mtimeMs = await modificationTimeMs(join(dir, entry.name));
      if (mtimeMs !== undefined) dirs.push({ name: entry.name, mtimeMs });
    }
    return dirs;
  },
};

/**
 * Unpacks a `.tar.gz` in-process, and a `.zip` with PowerShell's
 * `Expand-Archive` (zip archives are Windows-only, as in the update checker).
 */
export const defaultLitestreamExtractor: LitestreamArchiveExtractor = async (
  archive,
  archiveName,
  destDir,
) => {
  if (!archiveName.endsWith(".zip")) {
    await extractTarGz(ReadableStream.from([archive]), destDir, undefined, {
      maxDecompressedBytes: MAX_EXTRACTED_BYTES,
    });
    return;
  }
  await Deno.mkdir(destDir, { recursive: true });
  const zipPath = join(destDir, archiveName);
  await Deno.writeFile(zipPath, archive);
  const quote = (path: string) => `'${path.replaceAll("'", "''")}'`;
  const result = await new Deno.Command("powershell.exe", {
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -Path ${quote(zipPath)} -DestinationPath ${
        quote(destDir)
      } -Force`,
    ],
    stdout: "null",
    stderr: "piped",
  }).output().finally(() => Deno.remove(zipPath).catch(() => {}));
  if (!result.success) {
    throw new Error(
      `Expand-Archive failed: ${new TextDecoder().decode(result.stderr)}`,
    );
  }
};

/**
 * Removes the quarantine attribute macOS may set on a downloaded binary
 * (best-effort, as the update checker does). A no-op elsewhere.
 */
export async function clearMacOSQuarantine(path: string): Promise<void> {
  if (Deno.build.os !== "darwin") return;
  try {
    await new Deno.Command("xattr", {
      args: ["-d", "com.apple.quarantine", path],
      stdout: "null",
      stderr: "null",
    }).output();
  } catch {
    // Best-effort: the attribute is usually absent on fetch() downloads.
  }
}

export class LitestreamBinaryProvider {
  private readonly pin: LitestreamPin;
  private readonly os: string;
  private readonly arch: string;
  private readonly fetch: Fetcher;
  private readonly fs: LitestreamFs;
  private readonly extract: LitestreamArchiveExtractor;
  private readonly clearQuarantine: (path: string) => Promise<void>;
  private readonly downloadTimeoutMs: number;
  private readonly maxDownloadBytes: number;
  private readonly now: () => number;
  private readonly cacheRoot: string;

  constructor(private readonly options: LitestreamBinaryProviderOptions) {
    this.pin = options.pin ?? LITESTREAM_PIN;
    this.os = options.os ?? Deno.build.os;
    this.arch = options.arch ?? Deno.build.arch;
    this.fetch = options.fetch ?? fetch;
    this.fs = options.fs ?? denoLitestreamFs;
    this.extract = options.extract ?? defaultLitestreamExtractor;
    this.clearQuarantine = options.clearQuarantine ?? clearMacOSQuarantine;
    this.downloadTimeoutMs = options.downloadTimeoutMs ??
      DEFAULT_DOWNLOAD_TIMEOUT_MS;
    this.maxDownloadBytes = options.maxDownloadBytes ??
      DEFAULT_MAX_DOWNLOAD_BYTES;
    this.now = options.now ?? Date.now;
    this.cacheRoot = join(options.dataDir, LITESTREAM_CACHE_DIR);
  }

  /** The cache directory for the pinned version. */
  get versionDir(): string {
    return join(this.cacheRoot, this.pin.version);
  }

  /**
   * Returns the path of a binary that hashes to the pin, downloading it on
   * first use. Call it before every start of the binary.
   */
  async resolve(signal?: AbortSignal): Promise<ResolvedLitestreamBinary> {
    const availability = litestreamAvailability(this.pin, this.os, this.arch);
    if (!availability.available) {
      throw new LitestreamUnavailableError(availability.reason);
    }
    const target = availability.target;
    const version = this.pin.version;

    const override = this.options.overridePath;
    if (override !== undefined && override !== "") {
      await this.verifyOverride(override, target);
      return { path: override, version, source: "override" };
    }

    if (await this.fs.exists(this.versionDir)) {
      return {
        path: await this.verifyCached(target),
        version,
        source: "cache",
      };
    }

    const archive = await this.download(target, signal);
    return await this.install(target, archive);
  }

  private async verifyOverride(
    path: string,
    target: LitestreamTarget,
  ): Promise<void> {
    const expected = this.pin.digests(target).binarySha256;
    const bytes = await this.fs.readFile(path);
    if (bytes === undefined) {
      throw markErrorPaths(
        new LitestreamUnavailableError(
          `${LITESTREAM_PATH_ENV} points at ${path}, which does not exist.`,
        ),
        [path],
      );
    }
    const actual = await computeChecksum(bytes);
    if (actual !== expected) {
      throw markErrorPaths(
        new LitestreamIntegrityError(
          `${LITESTREAM_PATH_ENV} points at ${path}, which is not ` +
            `Litestream ${this.pin.version} for ${target}: its SHA-256 is ` +
            `${actual}, the pinned one is ${expected}. swamp will not run it.`,
        ),
        [path],
      );
    }
  }

  /** Hashes the cached binary; a missing or wrong one is refused. */
  private async verifyCached(target: LitestreamTarget): Promise<string> {
    const versionDir = this.versionDir;
    const path = join(versionDir, litestreamBinaryName(target));
    const expected = this.pin.digests(target).binarySha256;
    const bytes = await this.fs.readFile(path);
    const problem = bytes === undefined
      ? `has no ${litestreamBinaryName(target)}`
      : await computeChecksum(bytes).then((actual) =>
        actual === expected ? undefined : `holds a binary whose SHA-256 is ` +
          `${actual}, not the pinned ${expected}`
      );
    if (problem === undefined) return path;
    throw markErrorPaths(
      new LitestreamIntegrityError(
        `The Litestream cache ${versionDir} ${problem}. swamp will not run ` +
          `it. Delete the directory ${versionDir} and swamp downloads ` +
          `Litestream ${this.pin.version} again on next use.`,
      ),
      [versionDir],
    );
  }

  private async download(
    target: LitestreamTarget,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array> {
    const url = litestreamArchiveUrl(this.pin.version, target);
    const timeout = AbortSignal.timeout(this.downloadTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let archive: Uint8Array;
    try {
      const response = await this.fetch(url, { signal: combined });
      if (!response.ok) {
        await response.body?.cancel();
        throw this.offline(target, `HTTP ${response.status}`);
      }
      archive = await this.readCapped(response, target);
    } catch (error) {
      if (error instanceof UserError) throw error;
      if (timeout.aborted) {
        throw this.offline(
          target,
          `timed out after ${Math.round(this.downloadTimeoutMs / 1000)}s`,
        );
      }
      if (signal?.aborted) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw this.offline(target, `network error: ${reason}`);
    }
    const expected = this.pin.digests(target).archiveSha256;
    const actual = await computeChecksum(archive);
    if (actual !== expected) {
      throw new LitestreamIntegrityError(
        `The downloaded ${
          litestreamArchiveName(this.pin.version, target)
        } has SHA-256 ${actual}, not the pinned ${expected}. swamp did not ` +
          `extract or run it.`,
      );
    }
    return archive;
  }

  /** Reads the body, refusing one larger than the cap. */
  private async readCapped(
    response: Response,
    target: LitestreamTarget,
  ): Promise<Uint8Array> {
    if (response.body === null) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.maxDownloadBytes) {
        await reader.cancel();
        throw this.offline(
          target,
          `the response exceeded ${this.maxDownloadBytes} bytes`,
        );
      }
      chunks.push(value);
    }
    const archive = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      archive.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return archive;
  }

  /** The error that tells the user exactly how to install it by hand. */
  private offline(
    target: LitestreamTarget,
    cause: string,
  ): LitestreamUnavailableError {
    const version = this.pin.version;
    const digests = this.pin.digests(target);
    const binaryName = litestreamBinaryName(target);
    const cachePath = join(this.versionDir, binaryName);
    return markErrorPaths(
      new LitestreamUnavailableError(
        `Could not download Litestream ${version} (${cause}). v3 replication ` +
          `needs it. To install it by hand:\n` +
          `  1. Download ${litestreamArchiveUrl(version, target)}\n` +
          `     (SHA-256 ${digests.archiveSha256}).\n` +
          `  2. Extract ${binaryName} from it ` +
          `(SHA-256 ${digests.binarySha256}).\n` +
          `  3. Put it at ${cachePath}, or set ${LITESTREAM_PATH_ENV} to ` +
          `its path.`,
      ),
      [cachePath],
    );
  }

  /** Stages the archive's binary beside the cache, then renames it in. */
  private async install(
    target: LitestreamTarget,
    archive: Uint8Array,
  ): Promise<ResolvedLitestreamBinary> {
    const version = this.pin.version;
    const binaryName = litestreamBinaryName(target);
    await this.fs.mkdir(this.cacheRoot);
    await this.removeAbandonedStaging();
    const staging = await this.fs.makeTempDir(
      this.cacheRoot,
      `${STAGING_PREFIX}${version}-`,
    );
    let installed = false;
    try {
      const scratch = join(staging, EXTRACT_SUBDIR);
      await this.extract(
        archive,
        litestreamArchiveName(version, target),
        scratch,
      );
      const staged = join(staging, binaryName);
      if (!(await this.fs.exists(join(scratch, binaryName)))) {
        throw new LitestreamIntegrityError(
          `The Litestream ${version} archive for ${target} has no ` +
            `${binaryName}.`,
        );
      }
      await this.fs.rename(join(scratch, binaryName), staged);
      if (await this.fs.exists(join(scratch, LICENSE_FILE))) {
        await this.fs.rename(
          join(scratch, LICENSE_FILE),
          join(staging, LICENSE_FILE),
        );
      }
      await this.fs.remove(scratch);

      const expected = this.pin.digests(target).binarySha256;
      const bytes = await this.fs.readFile(staged);
      const actual = bytes === undefined ? "missing" : await computeChecksum(
        bytes,
      );
      if (actual !== expected) {
        throw new LitestreamIntegrityError(
          `The ${binaryName} in the Litestream ${version} archive has ` +
            `SHA-256 ${actual}, not the pinned ${expected}. swamp will not ` +
            `run it.`,
        );
      }
      await this.fs.chmod(staged, 0o755);
      await this.clearQuarantine(staged);

      try {
        await this.fs.rename(staging, this.versionDir);
        installed = true;
      } catch (error) {
        // A rename onto a non-empty directory fails on every platform, so a
        // version directory that exists now means another process won.
        if (!(await this.fs.exists(this.versionDir))) throw error;
      }
    } finally {
      if (!installed) {
        // Cleanup must not shadow the error that got us here; a staging
        // directory left behind is swept on a later miss.
        await this.fs.remove(staging).catch(() => {});
      }
    }
    return {
      path: await this.verifyCached(target),
      version,
      source: installed ? "download" : "cache",
    };
  }

  /** Removes staging directories a crashed process left behind. */
  private async removeAbandonedStaging(): Promise<void> {
    const cutoff = this.now() - ABANDONED_STAGING_MAX_AGE_MS;
    for (const dir of await this.fs.listDirs(this.cacheRoot, STAGING_PREFIX)) {
      if (dir.mtimeMs < cutoff) {
        await this.fs.remove(join(this.cacheRoot, dir.name));
      }
    }
  }
}

/**
 * The provider wired to the real network, filesystem, swamp data dir and
 * `SWAMP_LITESTREAM_PATH`.
 */
export function defaultLitestreamBinaryProvider(): LitestreamBinaryProvider {
  return new LitestreamBinaryProvider({
    dataDir: getSwampDataDir(),
    overridePath: Deno.env.get(LITESTREAM_PATH_ENV),
  });
}
