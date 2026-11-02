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

import { dirname, join } from "@std/path";
import { getLogger } from "@logtape/logtape";
import type { Platform } from "../../domain/update/platform.ts";
import {
  describePermissionDenied,
  type UpdateChecker,
} from "../../domain/update/update_service.ts";
import { UserError } from "../../domain/errors.ts";
import {
  checksumUrlFromTarballUrl,
  parseChecksumFile,
  verifyChecksum,
} from "../../domain/update/integrity.ts";
import { computeChecksum } from "../../domain/models/checksum.ts";
import { extractTarGz } from "../archive/tar_archive.ts";
import {
  removeAbandonedTempDirs,
  removeAbandonedTempFiles,
} from "../persistence/abandoned_temp_files.ts";
import { abortableSleep, type Sleep } from "../http/rate_limit.ts";
import type { DownloadOptions } from "../../domain/update/download_progress.ts";
import { downloadToFile } from "./resumable_download.ts";

const logger = getLogger(["swamp", "update"]);

const CHECK_TIMEOUT_MS = 5000;
const CHECK_RETRY_BASE_DELAY_MS = 1000;
const UPDATE_TEMP_DIR_PREFIX = "swamp-update-";

export interface HttpUpdateCheckerOptions {
  maxAttempts?: number;
  sleep?: Sleep;
  /**
   * tests set this: an install sweeps abandoned update directories from it, and
   * a test must not touch the real temp dir
   */
  tempRoot?: string;
  downloadStallTimeoutMs?: number;
  downloadMaxAttempts?: number;
  fileOps?: BinaryFileOps;
}

export interface BinaryFileOps {
  rename(oldPath: string, newPath: string): Promise<void>;
  copyFile(fromPath: string, toPath: string): Promise<void>;
  remove(path: string): Promise<void>;
}

const denoFileOps: BinaryFileOps = {
  rename: (oldPath, newPath) => Deno.rename(oldPath, newPath),
  copyFile: (fromPath, toPath) => Deno.copyFile(fromPath, toPath),
  remove: (path) => Deno.remove(path),
};

type AttemptResult<T> = { ok: true; value: T } | { ok: false; reason: string };

async function extractZip(
  archivePath: string,
  destDir: string,
): Promise<void> {
  const cmd = new Deno.Command("powershell.exe", {
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force`,
    ],
    stdout: "null",
    stderr: "piped",
  });
  const result = await cmd.output();
  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr);
    throw new Error(`Expand-Archive failed: ${stderr}`);
  }
}

/**
 * files fetched are tagged com.apple.quarantine and Gatekeeper SIGKILLs
 * unsigned binaries carrying it; darwin only, best-effort
 */
async function removeQuarantine(path: string): Promise<void> {
  if (Deno.build.os !== "darwin") return;
  try {
    const cmd = new Deno.Command("xattr", {
      args: ["-d", "com.apple.quarantine", path],
      stdout: "null",
      stderr: "null",
    });
    await cmd.output();
  } catch {
    // Best-effort, ignore failures
  }
}

export async function cleanupStaleBinary(binaryPath: string): Promise<void> {
  const oldPath = binaryPath + ".old";
  try {
    await Deno.remove(oldPath);
  } catch {
    // File doesn't exist or is still locked — either is fine
  }
}

/**
 * POSIX atomic rename keeps running processes on the old inode. Windows cannot
 * overwrite a running exe but can rename it, so move it to .old and roll back
 * on failure
 */
export async function replaceBinary(
  sourcePath: string,
  targetPath: string,
  ops: BinaryFileOps = denoFileOps,
): Promise<void> {
  // sweep temp files abandoned by a crashed update; fresh ones stay, as a
  // concurrent update may still be copying
  const targetDir = dirname(targetPath);
  await removeAbandonedTempFiles(targetDir, ".swamp.tmp.");

  if (Deno.build.os === "windows") {
    await replaceBinaryWindows(sourcePath, targetPath, ops);
    return;
  }

  try {
    await ops.rename(sourcePath, targetPath);
  } catch (error) {
    if (error instanceof Deno.errors.PermissionDenied) {
      throw new UserError(await describePermissionDenied(targetPath));
    }
    // EXDEV: source and target are on different filesystems, so copy to a temp
    // file in the target directory, then atomic rename
    const code = error instanceof Error
      ? (error as Error & { code?: string }).code
      : undefined;
    if (code === "EXDEV") {
      const tmpPath = join(targetDir, `.swamp.tmp.${crypto.randomUUID()}`);
      try {
        await ops.copyFile(sourcePath, tmpPath);
        await ops.rename(tmpPath, targetPath);
      } catch (innerError) {
        try {
          await ops.remove(tmpPath);
        } catch {
          // Best-effort cleanup
        }
        if (innerError instanceof Deno.errors.PermissionDenied) {
          throw new UserError(await describePermissionDenied(targetPath));
        }
        throw innerError;
      }
    } else {
      throw error;
    }
  }
}

export async function replaceBinaryWindows(
  sourcePath: string,
  targetPath: string,
  ops: BinaryFileOps = denoFileOps,
): Promise<void> {
  const oldPath = targetPath + ".old";
  const tmpPath = join(
    dirname(targetPath),
    `.swamp.tmp.${crypto.randomUUID()}`,
  );
  const removeTmp = async () => {
    try {
      await ops.remove(tmpPath);
    } catch {
      // Best-effort cleanup; an abandoned temp file is swept next update
    }
  };

  await cleanupStaleBinary(targetPath);

  // stage beside the target so swamp.exe is absent only between the two
  // renames; fall back to copy on EXDEV (cross-volume)
  try {
    try {
      await ops.rename(sourcePath, tmpPath);
    } catch (renameError) {
      const code = renameError instanceof Error
        ? (renameError as Error & { code?: string }).code
        : undefined;
      if (code !== "EXDEV") throw renameError;
      await ops.copyFile(sourcePath, tmpPath);
    }
  } catch (stageError) {
    await removeTmp();
    if (stageError instanceof Deno.errors.PermissionDenied) {
      throw new UserError(await describePermissionDenied(targetPath));
    }
    throw stageError;
  }

  // Windows allows renaming a locked file, just not overwriting or deleting it
  let targetExisted = false;
  try {
    await ops.rename(targetPath, oldPath);
    targetExisted = true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      // Target doesn't exist yet (fresh install) — proceed directly
    } else {
      await removeTmp();
      if (error instanceof Deno.errors.PermissionDenied) {
        throw new UserError(await describePermissionDenied(targetPath));
      }
      throw error;
    }
  }

  try {
    await ops.rename(tmpPath, targetPath);
  } catch (renameError) {
    // roll back so the user is not left without a binary
    if (targetExisted) {
      try {
        await ops.rename(oldPath, targetPath);
      } catch {
        // if rollback fails, the .old file remains for manual recovery
      }
    }
    await removeTmp();
    if (renameError instanceof Deno.errors.PermissionDenied) {
      throw new UserError(await describePermissionDenied(targetPath));
    }
    throw renameError;
  }
}

function describeCheckFailure(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return `the update server did not respond within ${
      CHECK_TIMEOUT_MS / 1000
    }s`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * The error for an update check whose every attempt failed. Only the last
 * attempt's failure is named: earlier ones may have failed differently.
 */
function checkFailedError(reason: string, attempts: number): UserError {
  if (attempts === 1) {
    return new UserError(`Failed to check for updates: ${reason}`);
  }
  return new UserError(
    `Failed to check for updates after ${attempts} attempts. Last attempt: ${reason}`,
  );
}

function checksumFailedError(reason: string, attempts: number): UserError {
  if (attempts === 1) {
    return new UserError(`Failed to fetch checksum: ${reason}`);
  }
  return new UserError(
    `Failed to fetch checksum after ${attempts} attempts. Last attempt: ${reason}`,
  );
}

export class HttpUpdateChecker implements UpdateChecker {
  private readonly maxAttempts: number;
  private readonly sleep: Sleep;
  private readonly tempRoot: string | undefined;
  private readonly downloadStallTimeoutMs: number | undefined;
  private readonly downloadMaxAttempts: number | undefined;
  private readonly fileOps: BinaryFileOps;

  constructor(options: HttpUpdateCheckerOptions = {}) {
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 1);
    this.sleep = options.sleep ?? abortableSleep;
    this.tempRoot = options.tempRoot;
    this.downloadStallTimeoutMs = options.downloadStallTimeoutMs;
    this.downloadMaxAttempts = options.downloadMaxAttempts;
    this.fileOps = options.fileOps ?? denoFileOps;
  }

  /**
   * HEAD to the stable URL without following redirects; the location header is
   * the versioned URL. Timeouts, connection errors and 5xx retry with backoff;
   * abort stops at once
   */
  async checkForUpdate(
    platform: Platform,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const url = platform.stableUrl();
    const response = await this.withRetry(
      "Update check",
      async (attemptSignal) => {
        const response = await fetch(url, {
          method: "HEAD",
          redirect: "manual",
          signal: attemptSignal,
        });
        if (response.status < 500) return { ok: true, value: response };
        await response.body?.cancel();
        return { ok: false, reason: `HTTP ${response.status}` };
      },
      checkFailedError,
      signal,
    );

    const redirectLocation = response.headers.get("location") ||
      response.headers.get("x-amz-website-redirect-location") ||
      response.headers.get("x-amz-meta-x-amz-website-redirect-location");

    if (redirectLocation) {
      return redirectLocation;
    }

    if (response.ok) {
      return url;
    }

    if (response.status === 404) {
      throw new UserError(
        `No binary available for ${platform}. This platform may not be supported yet.`,
      );
    }

    throw new UserError(
      `Failed to check for updates: HTTP ${response.status}`,
    );
  }

  private async withRetry<T>(
    what: string,
    request: (attemptSignal: AbortSignal) => Promise<AttemptResult<T>>,
    failedError: (reason: string, attempts: number) => UserError,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    for (let attempt = 1;; attempt++) {
      signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(CHECK_TIMEOUT_MS);
      const attemptSignal = signal
        ? AbortSignal.any([signal, timeout])
        : timeout;
      let reason: string;
      try {
        const result = await request(attemptSignal);
        if (result.ok) return result.value;
        reason = result.reason;
      } catch (error: unknown) {
        if (signal?.aborted) throw signal.reason;
        if (error instanceof UserError) throw error;
        reason = describeCheckFailure(error);
      }
      if (attempt >= this.maxAttempts) {
        throw failedError(reason, attempt);
      }
      const delayMs = CHECK_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      logger
        .debug`${what} attempt ${attempt} of ${this.maxAttempts} failed (${reason}); retrying in ${delayMs}ms`;
      await this.sleep(delayMs, signal);
    }
  }

  async fetchChecksum(
    tarballUrl: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const checksumUrl = checksumUrlFromTarballUrl(tarballUrl);
    const content = await this.withRetry(
      "Checksum fetch",
      async (attemptSignal) => {
        const response = await fetch(checksumUrl, { signal: attemptSignal });
        if (response.status >= 500) {
          await response.body?.cancel();
          return { ok: false, reason: `HTTP ${response.status}` };
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new UserError(
            `Failed to fetch checksum: HTTP ${response.status} from ${checksumUrl}`,
          );
        }
        return { ok: true, value: await response.text() };
      },
      checksumFailedError,
      signal,
    );
    return parseChecksumFile(content);
  }

  /**
   * aborting before the binary is replaced rejects with its reason; the temp
   * directory is removed either way
   */
  async downloadAndInstall(
    url: string,
    binaryPath: string,
    expectedChecksum: string,
    options: DownloadOptions = {},
  ): Promise<void> {
    const { signal } = options;
    const isZip = url.endsWith(".zip");
    const tempDir = await Deno.makeTempDir({
      dir: this.tempRoot,
      prefix: UPDATE_TEMP_DIR_PREFIX,
    });
    // sweep what an earlier killed update left behind; the new directory is
    // fresh, so the sweep keeps it
    await removeAbandonedTempDirs(dirname(tempDir), UPDATE_TEMP_DIR_PREFIX);

    try {
      const archiveExt = isZip ? "zip" : "tar.gz";
      const archivePath = `${tempDir}/swamp.${archiveExt}`;

      await downloadToFile(url, archivePath, {
        ...options,
        stallTimeoutMs: this.downloadStallTimeoutMs,
        maxAttempts: this.downloadMaxAttempts,
        sleep: this.sleep,
      });
      signal?.throwIfAborted();

      const archiveBytes = await Deno.readFile(archivePath);
      const actualChecksum = await computeChecksum(archiveBytes);
      verifyChecksum(expectedChecksum, actualChecksum);

      if (isZip) {
        try {
          await extractZip(archivePath, tempDir);
        } catch (error: unknown) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          throw new UserError(`Failed to extract update: ${message}`);
        }
      } else {
        try {
          const tarFile = await Deno.open(archivePath, { read: true });
          await extractTarGz(tarFile.readable, tempDir);
        } catch (error: unknown) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          throw new UserError(`Failed to extract update: ${message}`);
        }
      }

      const binaryFilename = isZip ? "swamp.exe" : "swamp";
      const extractedBinary = `${tempDir}/${binaryFilename}`;
      try {
        await Deno.stat(extractedBinary);
      } catch {
        throw new UserError(
          `Failed to find ${binaryFilename} in downloaded archive`,
        );
      }

      // drop the archive so it is not kept on disk alongside the extracted and
      // old binaries through the replace
      try {
        await Deno.remove(archivePath);
      } catch (error) {
        logger.debug`Could not remove ${archivePath}: ${error}`;
      }

      // fetch tags the file com.apple.quarantine, tar preserves it, and
      // Gatekeeper SIGKILLs the binary, so clear it before copying
      if (Deno.build.os === "darwin") {
        await removeQuarantine(extractedBinary);
      }

      // The last point the update can be cancelled. Once the swap starts it
      // runs to the end, so a Ctrl+C never leaves a half-replaced install.
      signal?.throwIfAborted();

      await replaceBinary(extractedBinary, binaryPath, this.fileOps);

      if (Deno.build.os !== "windows") {
        await Deno.chmod(binaryPath, 0o755);
      }

      // also clear quarantine on the final path in case copyFile propagates it
      if (Deno.build.os === "darwin") {
        await removeQuarantine(binaryPath);
      }
    } finally {
      try {
        await Deno.remove(tempDir, { recursive: true });
      } catch {
        // Best-effort cleanup
      }
    }
  }
}
