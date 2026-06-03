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

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { HttpSourceDownloader } from "../src/infrastructure/source/http_source_downloader.ts";

Deno.test({
  name: "HttpSourceDownloader fetches swamp source from GitHub",
  // This test downloads from GitHub and may be slow
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const downloader = new HttpSourceDownloader();
    const tempDir = await Deno.makeTempDir({ prefix: "swamp-integration-" });

    try {
      const targetDir = join(tempDir, "source");
      await ensureDir(targetDir);

      const fileCount = await downloader.downloadAndExtract("main", targetDir);

      // Should have extracted a non-trivial number of files
      assert(fileCount > 0, `Expected files to be extracted, got ${fileCount}`);

      // Verify key files exist
      const denoJson = await Deno.stat(join(targetDir, "deno.json"));
      assert(denoJson.isFile, "deno.json should exist");

      const mainTs = await Deno.stat(join(targetDir, "main.ts"));
      assert(mainTs.isFile, "main.ts should exist");

      // Verify symlinks are preserved (the repo has symlinks in .claude/skills/)
      const skillsDir = join(targetDir, ".claude", "skills");
      try {
        for await (const entry of Deno.readDir(skillsDir)) {
          if (entry.isSymlink) {
            // If we find any symlink, verify it was preserved correctly
            const linkPath = join(skillsDir, entry.name);
            const linkTarget = await Deno.readLink(linkPath);
            assert(
              linkTarget.length > 0,
              `Symlink ${entry.name} should have a target`,
            );

            // The symlink target should be a relative path
            assert(
              !linkTarget.startsWith("/"),
              `Symlink ${entry.name} should have a relative target, got: ${linkTarget}`,
            );
          }
        }
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) {
          throw e;
        }
        // Skills directory may not exist in all versions, that's OK
      }
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

async function checkSymlinks(dir: string): Promise<number> {
  let symlinkCount = 0;
  for await (const entry of Deno.readDir(dir)) {
    const fullPath = join(dir, entry.name);
    if (entry.isSymlink) {
      symlinkCount++;
      // Verify the symlink was preserved (not dereferenced)
      const stat = await Deno.lstat(fullPath);
      assert(stat.isSymlink, `${fullPath} should be a symlink`);

      const target = await Deno.readLink(fullPath);
      assert(target.length > 0, `${fullPath} should have a link target`);
    } else if (entry.isDirectory) {
      symlinkCount += await checkSymlinks(fullPath);
    }
  }
  return symlinkCount;
}

Deno.test({
  name: "HttpSourceDownloader preserves symlinks that point to directories",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const downloader = new HttpSourceDownloader();
    const tempDir = await Deno.makeTempDir({ prefix: "swamp-integration-" });

    try {
      const targetDir = join(tempDir, "source");
      await ensureDir(targetDir);

      await downloader.downloadAndExtract("main", targetDir);

      const totalSymlinks = await checkSymlinks(targetDir);
      // The swamp repo is known to have symlinks; verify at least one was found
      assert(
        totalSymlinks > 0,
        `Expected at least one symlink in extracted source, found ${totalSymlinks}`,
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "HttpSourceDownloader returns 404 error for non-existent version",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const downloader = new HttpSourceDownloader();
    const tempDir = await Deno.makeTempDir({
      prefix: "swamp-integration-404-",
    });

    try {
      const targetDir = join(tempDir, "source");
      await ensureDir(targetDir);

      let errorThrown = false;
      try {
        await downloader.downloadAndExtract(
          "nonexistent-version-xyz-12345",
          targetDir,
        );
      } catch (e) {
        errorThrown = true;
        assertEquals(
          (e as Error).message,
          `Source version "nonexistent-version-xyz-12345" not found. Check that the version tag exists.`,
        );
      }
      assert(
        errorThrown,
        "Should have thrown an error for non-existent version",
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});
