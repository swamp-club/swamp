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
import type { UpdateChecker } from "../../domain/update/update_service.ts";
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

/** How long one update-check request may take before it is abandoned. */
const CHECK_TIMEOUT_MS = 5000;
/** Wait before each retry of the update check: 1s, then 2s, then 4s… */
const CHECK_RETRY_BASE_DELAY_MS = 1000;
/** Name prefix of the temp directory each update downloads into. */
const UPDATE_TEMP_DIR_PREFIX = "swamp-update-";

/** Options for {@link HttpUpdateChecker}. */
export interface HttpUpdateCheckerOptions {
  /**
   * How many times `checkForUpdate` sends its request before giving up.
   * Timeouts, connection errors and HTTP 5xx are retried. Defaults to 1.
   */
  maxAttempts?: number;
  /** Waits between attempts; replaced in tests. */
  sleep?: Sleep;
  /** Where update temp directories go; defaults to the OS temp dir. */
  tempRoot?: string;
  /** Replaced in tests; see {@link downloadToFile}. */
  downloadStallTimeoutMs?: number;
  downloadMaxAttempts?: number;
}

/** One request's result: a value, or the reason to try again. */
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
 * Remove macOS quarantine extended attribute (best-effort).
 * Files downloaded via fetch() get tagged with com.apple.quarantine,
 * and Gatekeeper will SIGKILL unsigned binaries that have it.
 *
 * Only meaningful on darwin — `xattr` is not present on Linux or Windows,
 * and the quarantine attribute is a macOS-specific concept. Calls on other
 * platforms become a no-op.
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

function permissionDeniedMessage(targetPath: string): string {
  if (Deno.build.os === "windows") {
    return `Cannot update ${targetPath}: permission denied. Try running the terminal as Administrator.`;
  }
  return `Cannot update ${targetPath}: permission denied. Re-run with: sudo swamp update`;
}

/**
 * Best-effort cleanup of a stale `.old` binary left by a previous update.
 * Exported so the CLI startup path can call it on Windows.
 */
export async function cleanupStaleBinary(binaryPath: string): Promise<void> {
  const oldPath = binaryPath + ".old";
  try {
    await Deno.remove(oldPath);
  } catch {
    // File doesn't exist or is still locked — either is fine
  }
}

/**
 * Replace a binary at `targetPath` with the file at `sourcePath`.
 *
 * On POSIX (macOS, Linux): atomic rename creates a new inode at the target
 * path. Running processes keep their vnode reference to the old inode —
 * no SIGKILL on macOS, no ETXTBSY on Linux.
 *
 * On Windows: running executables are locked and cannot be overwritten,
 * but CAN be renamed. Strategy: rename the running binary to `.old`,
 * then rename the new binary into place. If placement fails, rollback
 * by renaming `.old` back. The `.old` file is cleaned up on next launch.
 *
 * POSIX fallback: if rename fails with EXDEV (cross-filesystem), copy to
 * a temp file in the target directory (same filesystem), then rename.
 */
async function replaceBinary(
  sourcePath: string,
  targetPath: string,
): Promise<void> {
  // Clean up temp files abandoned by a previous crashed update. Fresh ones
  // are kept — they may belong to a concurrent update still copying.
  const targetDir = dirname(targetPath);
  await removeAbandonedTempFiles(targetDir, ".swamp.tmp.");

  if (Deno.build.os === "windows") {
    await replaceBinaryWindows(sourcePath, targetPath);
    return;
  }

  try {
    await Deno.rename(sourcePath, targetPath);
  } catch (error) {
    if (error instanceof Deno.errors.PermissionDenied) {
      throw new UserError(permissionDeniedMessage(targetPath));
    }
    // EXDEV: source and target on different filesystems — rename won't work.
    // Copy to a temp file in the target directory, then atomic rename.
    const code = error instanceof Error
      ? (error as Error & { code?: string }).code
      : undefined;
    if (code === "EXDEV") {
      const tmpPath = join(targetDir, `.swamp.tmp.${crypto.randomUUID()}`);
      try {
        await Deno.copyFile(sourcePath, tmpPath);
        await Deno.rename(tmpPath, targetPath);
      } catch (innerError) {
        try {
          await Deno.remove(tmpPath);
        } catch {
          // Best-effort cleanup
        }
        if (innerError instanceof Deno.errors.PermissionDenied) {
          throw new UserError(permissionDeniedMessage(targetPath));
        }
        throw innerError;
      }
    } else {
      throw error;
    }
  }
}

async function replaceBinaryWindows(
  sourcePath: string,
  targetPath: string,
): Promise<void> {
  const oldPath = targetPath + ".old";

  // Clean up stale .old from a previous update
  await cleanupStaleBinary(targetPath);

  // Rename the running binary out of the way — Windows allows renaming
  // a locked file, just not overwriting or deleting it.
  let targetExisted = false;
  try {
    await Deno.rename(targetPath, oldPath);
    targetExisted = true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      // Target doesn't exist yet (fresh install) — proceed directly
    } else if (error instanceof Deno.errors.PermissionDenied) {
      throw new UserError(permissionDeniedMessage(targetPath));
    } else {
      throw error;
    }
  }

  // Place the new binary at the target path.
  // Try rename first; fall back to copy if EXDEV (cross-volume, e.g.
  // %TEMP% on D: and swamp installed on C:).
  try {
    await Deno.rename(sourcePath, targetPath);
  } catch (renameError) {
    const code = renameError instanceof Error
      ? (renameError as Error & { code?: string }).code
      : undefined;
    if (code === "EXDEV") {
      try {
        await Deno.copyFile(sourcePath, targetPath);
      } catch (copyError) {
        if (targetExisted) {
          try {
            await Deno.rename(oldPath, targetPath);
          } catch {
            // Rollback failed — .old file still exists for manual recovery
          }
        }
        if (copyError instanceof Deno.errors.PermissionDenied) {
          throw new UserError(permissionDeniedMessage(targetPath));
        }
        throw copyError;
      }
    } else {
      // Rollback: restore the old binary so the user isn't left without one
      if (targetExisted) {
        try {
          await Deno.rename(oldPath, targetPath);
        } catch {
          // Rollback failed — .old file still exists for manual recovery
        }
      }
      if (renameError instanceof Deno.errors.PermissionDenied) {
        throw new UserError(permissionDeniedMessage(targetPath));
      }
      throw renameError;
    }
  }
}

/** Says why one update-check request failed. */
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

/** The error for a checksum fetch whose every attempt failed. */
function checksumFailedError(reason: string, attempts: number): UserError {
  if (attempts === 1) {
    return new UserError(`Failed to fetch checksum: ${reason}`);
  }
  return new UserError(
    `Failed to fetch checksum after ${attempts} attempts. Last attempt: ${reason}`,
  );
}

/**
 * HTTP adapter implementing UpdateChecker.
 * Checks artifacts.swamp-club.com for the latest swamp binary.
 */
export class HttpUpdateChecker implements UpdateChecker {
  private readonly maxAttempts: number;
  private readonly sleep: Sleep;
  private readonly tempRoot: string | undefined;
  private readonly downloadStallTimeoutMs: number | undefined;
  private readonly downloadMaxAttempts: number | undefined;

  constructor(options: HttpUpdateCheckerOptions = {}) {
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 1);
    this.sleep = options.sleep ?? abortableSleep;
    this.tempRoot = options.tempRoot;
    this.downloadStallTimeoutMs = options.downloadStallTimeoutMs;
    this.downloadMaxAttempts = options.downloadMaxAttempts;
  }

  /**
   * Issue a HEAD request to the stable URL with manual redirect handling.
   * The redirect location header contains the versioned URL.
   * Returns the redirect URL, or null if no redirect (already at latest).
   *
   * A timeout, connection error or HTTP 5xx is retried with backoff up to
   * `maxAttempts`; when the last attempt fails it becomes a UserError.
   * Aborting `signal` stops at once, with no further attempt.
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

    // Check for redirect via Location header or S3 metadata
    const redirectLocation = response.headers.get("location") ||
      response.headers.get("x-amz-website-redirect-location") ||
      response.headers.get("x-amz-meta-x-amz-website-redirect-location");

    if (redirectLocation) {
      return redirectLocation;
    }

    // 200 means we're at the actual file (stable URL IS the latest)
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

  /**
   * Run `request` with a per-attempt timeout, retrying a timeout, connection
   * error or retryable result with backoff up to `maxAttempts`. A UserError
   * from `request` is not retried. Aborting `signal` rethrows its reason at
   * once.
   */
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

  /**
   * Fetch the expected SHA-256 checksum for a tarball, retrying transient
   * failures like the update check does.
   */
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
   * Download the archive, verify its checksum, and install the binary.
   * Aborting `options.signal` before the binary is replaced rejects with its
   * reason; the temp directory is removed either way.
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
    // Remove what an earlier update killed mid-download left behind. The new
    // directory is fresh, so the sweep keeps it.
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

      // Verify archive integrity before extraction
      const archiveBytes = await Deno.readFile(archivePath);
      const actualChecksum = await computeChecksum(archiveBytes);
      verifyChecksum(expectedChecksum, actualChecksum);

      // Extract the archive
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

      // Find the extracted binary
      const binaryFilename = isZip ? "swamp.exe" : "swamp";
      const extractedBinary = `${tempDir}/${binaryFilename}`;
      try {
        await Deno.stat(extractedBinary);
      } catch {
        throw new UserError(
          `Failed to find ${binaryFilename} in downloaded archive`,
        );
      }

      // macOS: remove quarantine attribute from extracted binary before copying.
      // When fetch() writes to disk, macOS tags the file with com.apple.quarantine.
      // tar preserves this on extraction, and Gatekeeper will SIGKILL the binary.
      if (Deno.build.os === "darwin") {
        await removeQuarantine(extractedBinary);
      }

      // The last point the update can be cancelled. Once the swap starts it
      // runs to the end, so a Ctrl+C never leaves a half-replaced install.
      signal?.throwIfAborted();

      // Replace the current binary (atomic rename to preserve running processes)
      await replaceBinary(extractedBinary, binaryPath);

      // chmod is meaningless on Windows (file permissions live in the ACL,
      // not POSIX mode bits). Only set the executable bit on POSIX hosts.
      if (Deno.build.os !== "windows") {
        await Deno.chmod(binaryPath, 0o755);
      }

      // Also clear quarantine on the final path (in case copyFile propagates it)
      if (Deno.build.os === "darwin") {
        await removeQuarantine(binaryPath);
      }
    } finally {
      // Cleanup temp directory
      try {
        await Deno.remove(tempDir, { recursive: true });
      } catch {
        // Best-effort cleanup
      }
    }
  }
}
