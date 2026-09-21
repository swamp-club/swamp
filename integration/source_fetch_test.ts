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

// Wires HttpSourceDownloader against a port-0 archive server rather than
// github.com. These previously fetched
// https://github.com/swamp-club/swamp/archive/... for real, which made the
// suite fail whenever GitHub was slow or unreachable — observed as a 504
// where the 404 test expected a missing tag. A served fixture exercises the
// same download, extract, symlink and status-code paths deterministically.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { HttpSourceDownloader } from "../src/infrastructure/source/http_source_downloader.ts";
import { createTarGz } from "../src/infrastructure/archive/tar_archive.ts";

/** The version the fixture archive is served for; anything else 404s. */
const SERVED_VERSION = "main";

/**
 * Builds an archive shaped like a GitHub source tarball — a single top-level
 * directory — containing the files and symlinks the downloader must handle.
 */
async function buildFixtureArchive(tempDir: string): Promise<string> {
  const stagingDir = join(tempDir, "staging");
  const archiveRoot = join(stagingDir, "swamp-main");
  await ensureDir(join(archiveRoot, "src"));
  await ensureDir(join(archiveRoot, ".claude", "skills", "swamp"));

  await Deno.writeTextFile(join(archiveRoot, "deno.json"), "{}\n");
  await Deno.writeTextFile(join(archiveRoot, "main.ts"), "// entry point\n");
  await Deno.writeTextFile(
    join(archiveRoot, "src", "nested.ts"),
    "// nested\n",
  );
  await Deno.writeTextFile(
    join(archiveRoot, ".claude", "skills", "swamp", "SKILL.md"),
    "# skill\n",
  );

  // The real repo carries both shapes under .claude/skills. Deno on Windows
  // refuses a symlink whose target does not yet exist without an explicit
  // type, so both are created after their targets and typed.
  await Deno.symlink(
    join("swamp", "SKILL.md"),
    join(archiveRoot, ".claude", "skills", "SKILL.md"),
    { type: "file" },
  );
  await Deno.symlink(
    "swamp",
    join(archiveRoot, ".claude", "skills", "linked-skill"),
    { type: "dir" },
  );

  const archivePath = join(tempDir, "source.tar.gz");
  await createTarGz(archiveRoot, archivePath);
  return archivePath;
}

/**
 * Serves `archivePath` for {@link SERVED_VERSION} and 404s anything else,
 * mirroring GitHub's behaviour for a tag that does not exist.
 */
function serveArchive(archivePath: string): {
  downloader: HttpSourceDownloader;
  shutdown: () => Promise<void>;
} {
  const server = Deno.serve({
    port: 0,
    hostname: "127.0.0.1",
    onListen: () => {},
  }, (req) => {
    if (!new URL(req.url).pathname.includes(SERVED_VERSION)) {
      return new Response("Not Found", { status: 404 });
    }
    return new Response(Deno.readFileSync(archivePath), {
      headers: { "content-type": "application/gzip" },
    });
  });
  const port = server.addr.port;

  const TestDownloader = class extends HttpSourceDownloader {
    protected override getArchiveUrl(version: string): string {
      return `http://127.0.0.1:${port}/${version}.tar.gz`;
    }
  };

  return {
    downloader: new TestDownloader(),
    shutdown: () => server.shutdown(),
  };
}

async function withFixtureServer(
  fn: (
    downloader: HttpSourceDownloader,
    targetDir: string,
  ) => Promise<void>,
): Promise<void> {
  const tempDir = await Deno.makeTempDir({ prefix: "swamp-source-fetch-" });
  const archivePath = await buildFixtureArchive(tempDir);
  const { downloader, shutdown } = serveArchive(archivePath);
  const targetDir = join(tempDir, "source");
  await ensureDir(targetDir);
  try {
    await fn(downloader, targetDir);
  } finally {
    await shutdown();
    if (Deno.build.os === "windows") {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

/** Counts symlinks anywhere under `dir`. */
async function countSymlinks(dir: string): Promise<number> {
  let symlinkCount = 0;
  for await (const entry of Deno.readDir(dir)) {
    const fullPath = join(dir, entry.name);
    if (entry.isSymlink) {
      symlinkCount++;
      // A preserved symlink must still carry a target.
      assert(
        (await Deno.readLink(fullPath)).length > 0,
        `Symlink ${entry.name} should have a target`,
      );
      continue;
    }
    if (entry.isDirectory) symlinkCount += await countSymlinks(fullPath);
  }
  return symlinkCount;
}

Deno.test("HttpSourceDownloader fetches and extracts a source archive", async () => {
  await withFixtureServer(async (downloader, targetDir) => {
    const fileCount = await downloader.downloadAndExtract(
      SERVED_VERSION,
      targetDir,
    );

    assert(fileCount > 0, `Expected files to be extracted, got ${fileCount}`);
    assert((await Deno.stat(join(targetDir, "deno.json"))).isFile);
    assert((await Deno.stat(join(targetDir, "main.ts"))).isFile);
    assert((await Deno.stat(join(targetDir, "src", "nested.ts"))).isFile);
  });
});

Deno.test("HttpSourceDownloader preserves symlinks to files and directories", async () => {
  await withFixtureServer(async (downloader, targetDir) => {
    await downloader.downloadAndExtract(SERVED_VERSION, targetDir);

    const skillsDir = join(targetDir, ".claude", "skills");
    assertEquals(await countSymlinks(skillsDir), 2);

    const dirLink = join(skillsDir, "linked-skill");
    assertEquals((await Deno.lstat(dirLink)).isSymlink, true);
    // Resolves through the link to the real file behind it.
    assertEquals(
      await Deno.readTextFile(join(dirLink, "SKILL.md")),
      "# skill\n",
    );
  });
});

Deno.test("HttpSourceDownloader returns a 404 error for a non-existent version", async () => {
  await withFixtureServer(async (downloader, targetDir) => {
    const error = await downloader.downloadAndExtract(
      "nonexistent-version-xyz-12345",
      targetDir,
    ).then(() => null, (e: Error) => e);

    assert(error, "Should have thrown an error for non-existent version");
    assertEquals(
      error.message,
      `Source version "nonexistent-version-xyz-12345" not found. Check that the version tag exists.`,
    );
  });
});
