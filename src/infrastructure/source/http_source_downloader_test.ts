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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { HttpSourceDownloader } from "./http_source_downloader.ts";
import { UserError } from "../../domain/errors.ts";

Deno.test("downloadAndExtract copies regular files", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "swamp-test-" });
  try {
    // Create a fake archive structure: top-level dir with files
    const archiveRoot = join(tempDir, "archive");
    const innerDir = join(archiveRoot, "swamp-main");
    await ensureDir(innerDir);
    await Deno.writeTextFile(join(innerDir, "file1.txt"), "hello");
    await Deno.writeTextFile(join(innerDir, "file2.txt"), "world");

    // Create a tarball from the archive
    const tarball = join(tempDir, "test.tar.gz");
    const tar = new Deno.Command("tar", {
      args: ["-czf", tarball, "-C", archiveRoot, "swamp-main"],
      stdout: "piped",
      stderr: "piped",
    });
    const tarResult = await tar.output();
    assert(tarResult.success, "tar creation should succeed");

    // Serve the tarball via a local HTTP server
    const server = Deno.serve({ port: 0, onListen: () => {} }, (_req) => {
      const body = Deno.readFileSync(tarball);
      return new Response(body, {
        headers: { "content-type": "application/gzip" },
      });
    });

    const port = server.addr.port;

    const targetDir = join(tempDir, "target");
    await ensureDir(targetDir);

    // Bypass URL construction by subclassing to point to our test server
    const TestDownloader = class extends HttpSourceDownloader {
      protected override getArchiveUrl(_version: string): string {
        return `http://localhost:${port}/test.tar.gz`;
      }
    };

    const testDownloader = new TestDownloader();
    const fileCount = await testDownloader.downloadAndExtract(
      "main",
      targetDir,
    );

    assertEquals(fileCount, 2);
    assertEquals(
      await Deno.readTextFile(join(targetDir, "file1.txt")),
      "hello",
    );
    assertEquals(
      await Deno.readTextFile(join(targetDir, "file2.txt")),
      "world",
    );

    await server.shutdown();
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("downloadAndExtract preserves symlinks", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "swamp-test-" });
  try {
    // Create archive structure with a symlink
    const archiveRoot = join(tempDir, "archive");
    const innerDir = join(archiveRoot, "swamp-main");
    const subDir = join(innerDir, "target-dir");
    await ensureDir(subDir);
    await Deno.writeTextFile(join(subDir, "content.txt"), "linked content");
    await Deno.symlink("target-dir", join(innerDir, "link-to-dir"));

    // Create tarball (with -h omitted so symlinks are preserved)
    const tarball = join(tempDir, "test.tar.gz");
    const tar = new Deno.Command("tar", {
      args: ["-czf", tarball, "-C", archiveRoot, "swamp-main"],
      stdout: "piped",
      stderr: "piped",
    });
    const tarResult = await tar.output();
    assert(tarResult.success, "tar creation should succeed");

    // Serve tarball
    const server = Deno.serve({ port: 0, onListen: () => {} }, (_req) => {
      const body = Deno.readFileSync(tarball);
      return new Response(body, {
        headers: { "content-type": "application/gzip" },
      });
    });

    const port = server.addr.port;

    const TestDownloader = class extends HttpSourceDownloader {
      protected override getArchiveUrl(_version: string): string {
        return `http://localhost:${port}/test.tar.gz`;
      }
    };

    const testDownloader = new TestDownloader();
    const targetDir = join(tempDir, "target");
    await ensureDir(targetDir);

    const fileCount = await testDownloader.downloadAndExtract(
      "main",
      targetDir,
    );

    // The symlink should be preserved, not dereferenced
    const linkPath = join(targetDir, "link-to-dir");
    const linkStat = await Deno.lstat(linkPath);
    assert(linkStat.isSymlink, "link-to-dir should be a symlink");

    const linkTarget = await Deno.readLink(linkPath);
    assertEquals(linkTarget, "target-dir");

    // The symlink should still work (resolve to the target directory)
    const resolvedContent = await Deno.readTextFile(
      join(linkPath, "content.txt"),
    );
    assertEquals(resolvedContent, "linked content");

    // fileCount should only count regular files, not symlinks or directories
    assertEquals(fileCount, 1);

    await server.shutdown();
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("downloadAndExtract copies nested directories", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "swamp-test-" });
  try {
    const archiveRoot = join(tempDir, "archive");
    const innerDir = join(archiveRoot, "swamp-main");
    const nested = join(innerDir, "a", "b");
    await ensureDir(nested);
    await Deno.writeTextFile(join(nested, "deep.txt"), "deep content");

    const tarball = join(tempDir, "test.tar.gz");
    const tar = new Deno.Command("tar", {
      args: ["-czf", tarball, "-C", archiveRoot, "swamp-main"],
      stdout: "piped",
      stderr: "piped",
    });
    const tarResult = await tar.output();
    assert(tarResult.success, "tar creation should succeed");

    const server = Deno.serve({ port: 0, onListen: () => {} }, (_req) => {
      const body = Deno.readFileSync(tarball);
      return new Response(body, {
        headers: { "content-type": "application/gzip" },
      });
    });

    const port = server.addr.port;

    const TestDownloader = class extends HttpSourceDownloader {
      protected override getArchiveUrl(_version: string): string {
        return `http://localhost:${port}/test.tar.gz`;
      }
    };

    const testDownloader = new TestDownloader();
    const targetDir = join(tempDir, "target");
    await ensureDir(targetDir);

    const fileCount = await testDownloader.downloadAndExtract(
      "main",
      targetDir,
    );

    assertEquals(fileCount, 1);
    assertEquals(
      await Deno.readTextFile(join(targetDir, "a", "b", "deep.txt")),
      "deep content",
    );

    await server.shutdown();
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("downloadAndExtract throws on download failure", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "swamp-test-" });
  try {
    // Serve a response that aborts mid-stream
    const server = Deno.serve({ port: 0, onListen: () => {} }, (_req) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(4096));
        },
        async pull(controller) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          controller.error(new Error("Connection reset"));
        },
      });
      return new Response(stream, {
        headers: { "content-type": "application/gzip" },
      });
    });

    const port = server.addr.port;

    const TestDownloader = class extends HttpSourceDownloader {
      protected override getArchiveUrl(_version: string): string {
        return `http://localhost:${port}/test.tar.gz`;
      }
    };

    const testDownloader = new TestDownloader();
    const targetDir = join(tempDir, "target");
    await ensureDir(targetDir);

    await assertRejects(
      () => testDownloader.downloadAndExtract("main", targetDir),
      UserError,
      "Download failed:",
    );

    await server.shutdown();
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
