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
import { dirname, join, resolve, SEPARATOR } from "@std/path";
import type { SourceDownloader } from "../../domain/source/mod.ts";
import { UserError } from "../../domain/errors.ts";
import { extractTarGz } from "../archive/tar_archive.ts";

export class HttpSourceDownloader implements SourceDownloader {
  private static readonly GITHUB_BASE =
    "https://github.com/swamp-club/swamp/archive/refs";

  protected getArchiveUrl(version: string): string {
    if (!/^[a-zA-Z0-9._-]+$/.test(version)) {
      throw new UserError(
        `Invalid version string "${version}": must contain only alphanumeric characters, dots, hyphens, and underscores.`,
      );
    }

    if (version === "main") {
      return `${HttpSourceDownloader.GITHUB_BASE}/heads/main.tar.gz`;
    }
    const tag = version.startsWith("v") ? version : `v${version}`;
    return `${HttpSourceDownloader.GITHUB_BASE}/tags/${tag}.tar.gz`;
  }

  async downloadAndExtract(
    version: string,
    targetDir: string,
  ): Promise<number> {
    const url = this.getArchiveUrl(version);

    await ensureDir(targetDir);

    const tempDir = await Deno.makeTempDir({ prefix: "swamp-source-" });

    try {
      const tarballPath = join(tempDir, "source.tar.gz");

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
        try {
          await Deno.remove(tarballPath);
        } catch {
          // Best-effort cleanup
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new UserError(`Download failed: ${message}`);
      }

      const extractDir = join(tempDir, "extracted");
      await ensureDir(extractDir);

      try {
        const tarFile = await Deno.open(tarballPath, { read: true });
        await extractTarGz(tarFile.readable, extractDir);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new UserError(`Failed to extract source archive: ${message}`);
      }

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

      let fileCount = 0;
      fileCount = await this.moveContents(sourceRoot, targetDir);

      return fileCount;
    } finally {
      try {
        await Deno.remove(tempDir, { recursive: true });
      } catch {
        // Best-effort cleanup
      }
    }
  }

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
          // resolve the link type from the source side, where the target
          // exists; Deno.symlink needs it on Windows. Broken symlinks default
          // to file
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
