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

/**
 * Remove macOS quarantine extended attribute (best-effort).
 * Files downloaded via fetch() get tagged with com.apple.quarantine,
 * and Gatekeeper will SIGKILL unsigned binaries that have it.
 */
async function removeQuarantine(path: string): Promise<void> {
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
   * Download the tarball and install the binary.
   */
  async downloadAndInstall(url: string, binaryPath: string): Promise<void> {
    const tempDir = await Deno.makeTempDir({ prefix: "swamp-update-" });

    try {
      const tarballPath = `${tempDir}/swamp.tar.gz`;

      // Download the tarball
      const response = await fetch(url);
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
      } catch {
        // writable stream may already be closed by pipeTo, that's fine
      }

      // Extract the tarball
      const extract = new Deno.Command("tar", {
        args: ["-xzf", tarballPath, "-C", tempDir],
        stdout: "piped",
        stderr: "piped",
      });
      const extractResult = await extract.output();
      if (!extractResult.success) {
        const stderr = new TextDecoder().decode(extractResult.stderr);
        throw new UserError(`Failed to extract update: ${stderr}`);
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

      // Replace the current binary
      await Deno.copyFile(extractedBinary, binaryPath);
      await Deno.chmod(binaryPath, 0o755);

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
