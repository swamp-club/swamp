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
import { dirname, join, resolve, SEPARATOR } from "@std/path";
import type { SourceDownloader } from "../../domain/source/mod.ts";
import { UserError } from "../../domain/errors.ts";
import { extractTarGz } from "../archive/tar_archive.ts";

/**
 * HTTP adapter for downloading swamp source archives from GitHub.
 */
export class HttpSourceDownloader implements SourceDownloader {
  private static readonly GITHUB_BASE =
    "https://github.com/systeminit/swamp/archive/refs";

  /**
   * Get the GitHub archive URL for a version.
   * For "main", uses heads/main.tar.gz
   * For version tags, uses tags/{version}.tar.gz
   */
  protected getArchiveUrl(version: string): string {
    if (!/^[a-zA-Z0-9._-]+$/.test(version)) {
      throw new UserError(
        `Invalid version string "${version}": must contain only alphanumeric characters, dots, hyphens, and underscores.`,
      );
    }

    if (version === "main") {
      return `${HttpSourceDownloader.GITHUB_BASE}/heads/main.tar.gz`;
    }
    // GitHub tags have a "v" prefix; add it if not already present
    const tag = version.startsWith("v") ? version : `v${version}`;
    return `${HttpSourceDownloader.GITHUB_BASE}/tags/${tag}.tar.gz`;
  }

  /**
   * Download and extract source archive for the given version.
   */
  async downloadAndExtract(
    version: string,
    targetDir: string,
  ): Promise<number> {
    const url = this.getArchiveUrl(version);

    // Ensure target directory exists
    await ensureDir(targetDir);

    const tempDir = await Deno.makeTempDir({ prefix: "swamp-source-" });

    try {
      const tarballPath = join(tempDir, "source.tar.gz");

      // Download the tarball
      let response: Response;
      try {
        response = await fetch(url);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new UserError(`Download failed: ${message}`);
      }
      if (!response.ok) {
        if (response.status === 404) {
          throw new UserError(
            `Source version "${version}" not found. Check that the version tag exists.`,
          );
        }
        throw new UserError(
          `Failed to download source: HTTP ${response.status}`,
        );
      }
      if (!response.body) {
        throw new UserError("Failed to download source: empty response body");
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

      // Extract the tarball to temp directory first
      const extractDir = join(tempDir, "extracted");
      await ensureDir(extractDir);

      try {
        const tarFile = await Deno.open(tarballPath, { read: true });
        await extractTarGz(tarFile.readable, extractDir);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new UserError(`Failed to extract source archive: ${message}`);
      }

      // GitHub archives have a top-level directory like "swamp-main" or "swamp-v1.2.3"
      // Move contents to target directory
      const entries = [];
      for await (const entry of Deno.readDir(extractDir)) {
        entries.push(entry);
      }

      if (entries.length !== 1 || !entries[0].isDirectory) {
        throw new UserError(
          "Unexpected archive structure: expected single top-level directory",
        );
      }

      const sourceRoot = join(extractDir, entries[0].name);

      // Move all contents from the extracted directory to the target
      let fileCount = 0;
      fileCount = await this.moveContents(sourceRoot, targetDir);

      return fileCount;
    } finally {
      // Cleanup temp directory
      try {
        await Deno.remove(tempDir, { recursive: true });
      } catch {
        // Best-effort cleanup
      }
    }
  }

  /**
   * Recursively move contents from source to target directory.
   * Returns the count of files moved.
   *
   * @param rootTargetDir The root extraction directory used to validate symlink
   *   targets. Defaults to `targetDir` on the first (non-recursive) call.
   */
  private async moveContents(
    sourceDir: string,
    targetDir: string,
    rootTargetDir?: string,
  ): Promise<number> {
    const effectiveRoot = resolve(rootTargetDir ?? targetDir);
    let fileCount = 0;

    for await (const entry of Deno.readDir(sourceDir)) {
      const sourcePath = join(sourceDir, entry.name);
      const targetPath = join(targetDir, entry.name);

      if (entry.isSymlink) {
        const linkTarget = await Deno.readLink(sourcePath);
        const resolvedTarget = resolve(dirname(targetPath), linkTarget);
        if (
          resolvedTarget === effectiveRoot ||
          resolvedTarget.startsWith(effectiveRoot + SEPARATOR)
        ) {
          // Resolve the link type from the source side, where the
          // target already exists. Required by Deno.symlink on Windows
          // when the target may not yet be present at the destination
          // (different walk orders produce different timing). Defaults
          // to "file" for broken symlinks; the type argument is ignored
          // on POSIX.
          let linkType: "file" | "dir" = "file";
          try {
            const stat = await Deno.stat(sourcePath);
            if (stat.isDirectory) linkType = "dir";
          } catch {
            // Broken symlink in source — keep default
          }
          await Deno.symlink(linkTarget, targetPath, { type: linkType });
        }
      } else if (entry.isDirectory) {
        await ensureDir(targetPath);
        fileCount += await this.moveContents(
          sourcePath,
          targetPath,
          effectiveRoot,
        );
      } else {
        await Deno.copyFile(sourcePath, targetPath);
        fileCount++;
      }
    }

    return fileCount;
  }
}
