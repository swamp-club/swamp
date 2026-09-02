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
  // Clean up stale temp files from a previous crashed update
  const targetDir = dirname(targetPath);
  try {
    for await (const entry of Deno.readDir(targetDir)) {
      if (entry.name.startsWith(".swamp.tmp.")) {
        try {
          await Deno.remove(join(targetDir, entry.name));
        } catch {
          // Best-effort cleanup
        }
      }
    }
  } catch {
    // readDir may fail on permission errors — not fatal
  }

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

/**
 * HTTP adapter implementing UpdateChecker.
 * Checks artifacts.swamp-club.com for the latest swamp binary.
 */
export class HttpUpdateChecker implements UpdateChecker {
  /**
   * Issue a HEAD request to the stable URL with manual redirect handling.
   * The redirect location header contains the versioned URL.
   * Returns the redirect URL, or null if no redirect (already at latest).
   */
  async checkForUpdate(platform: Platform): Promise<string | null> {
    const url = platform.stableUrl();
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });

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
   * Fetch the expected SHA-256 checksum for a tarball.
   */
  async fetchChecksum(tarballUrl: string): Promise<string> {
    const checksumUrl = checksumUrlFromTarballUrl(tarballUrl);

    let response: Response;
    try {
      response = await fetch(checksumUrl);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new UserError(`Failed to fetch checksum: ${message}`);
    }

    if (!response.ok) {
      throw new UserError(
        `Failed to fetch checksum: HTTP ${response.status} from ${checksumUrl}`,
      );
    }

    const content = await response.text();
    return parseChecksumFile(content);
  }

  /**
   * Download the archive, verify its checksum, and install the binary.
   */
  async downloadAndInstall(
    url: string,
    binaryPath: string,
    expectedChecksum: string,
  ): Promise<void> {
    const isZip = url.endsWith(".zip");
    const tempDir = await Deno.makeTempDir({ prefix: "swamp-update-" });

    try {
      const archiveExt = isZip ? "zip" : "tar.gz";
      const archivePath = `${tempDir}/swamp.${archiveExt}`;

      // Download the archive
      let response: Response;
      try {
        response = await fetch(url);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new UserError(`Download failed: ${message}`);
      }
      if (!response.ok) {
        throw new UserError(
          `Failed to download update: HTTP ${response.status}`,
        );
      }
      if (!response.body) {
        throw new UserError("Failed to download update: empty response body");
      }

      const file = await Deno.open(archivePath, {
        write: true,
        create: true,
      });
      try {
        await response.body.pipeTo(file.writable);
      } catch (error: unknown) {
        // Clean up partial download
        try {
          await Deno.remove(archivePath);
        } catch {
          // Best-effort cleanup
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new UserError(`Download failed: ${message}`);
      }

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
