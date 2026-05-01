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

/**
 * Replace a binary at `targetPath` with the file at `sourcePath`.
 *
 * On Linux, overwriting a running binary fails with ETXTBSY because the kernel
 * prevents writing to an inode with active text mappings. The standard fix is
 * to remove the directory entry first (the running process keeps its fd open),
 * then move the new file into place.
 *
 * Strategy:
 * 1. Try `Deno.rename()` — atomic, no ETXTBSY (operates on directory entries).
 * 2. If rename fails with EXDEV (cross-filesystem), fall back to
 *    `Deno.remove()` + `Deno.copyFile()`.
 */
async function replaceBinary(
  sourcePath: string,
  targetPath: string,
): Promise<void> {
  try {
    // Unlink first to release the inode on Linux
    try {
      await Deno.remove(targetPath);
    } catch (error) {
      // NotFound is fine — target may not exist yet
      if (error instanceof Deno.errors.NotFound) {
        // OK
      } else if (error instanceof Deno.errors.PermissionDenied) {
        throw new UserError(
          `Cannot update ${targetPath}: permission denied. Re-run with: sudo swamp update`,
        );
      } else {
        throw error;
      }
    }
    await Deno.rename(sourcePath, targetPath);
  } catch (error) {
    // EXDEV: source and target on different filesystems — rename won't work
    const code = error instanceof Error
      ? (error as Error & { code?: string }).code
      : undefined;
    if (code === "EXDEV") {
      // Target already removed above, so copyFile won't hit ETXTBSY
      await Deno.copyFile(sourcePath, targetPath);
    } else {
      throw error;
    }
  }
}

/**
 * HTTP adapter implementing UpdateChecker.
 * Checks artifacts.systeminit.com for the latest swamp binary.
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
   * Download the tarball, verify its checksum, and install the binary.
   */
  async downloadAndInstall(
    url: string,
    binaryPath: string,
    expectedChecksum: string,
  ): Promise<void> {
    const tempDir = await Deno.makeTempDir({ prefix: "swamp-update-" });

    try {
      const tarballPath = `${tempDir}/swamp.tar.gz`;

      // Download the tarball
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

      const file = await Deno.open(tarballPath, {
        write: true,
        create: true,
      });
      try {
        await response.body.pipeTo(file.writable);
      } catch (error: unknown) {
        // Clean up partial download
        try {
          await Deno.remove(tarballPath);
        } catch {
          // Best-effort cleanup
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new UserError(`Download failed: ${message}`);
      }

      // Verify tarball integrity before extraction
      const tarballBytes = await Deno.readFile(tarballPath);
      const actualChecksum = await computeChecksum(tarballBytes);
      verifyChecksum(expectedChecksum, actualChecksum);

      // Extract the tarball
      try {
        const tarFile = await Deno.open(tarballPath, { read: true });
        await extractTarGz(tarFile.readable, tempDir);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new UserError(`Failed to extract update: ${message}`);
      }

      // Find the extracted binary
      const extractedBinary = `${tempDir}/swamp`;
      try {
        await Deno.stat(extractedBinary);
      } catch {
        throw new UserError(
          "Failed to find swamp binary in downloaded archive",
        );
      }

      // macOS: remove quarantine attribute from extracted binary before copying.
      // When fetch() writes to disk, macOS tags the file with com.apple.quarantine.
      // tar preserves this on extraction, and Gatekeeper will SIGKILL the binary.
      if (Deno.build.os === "darwin") {
        await removeQuarantine(extractedBinary);
      }

      // Replace the current binary (unlink-then-rename to avoid ETXTBSY on Linux)
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
