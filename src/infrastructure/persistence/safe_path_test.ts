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

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { dirname, join } from "@std/path";
import {
  assertContainedPath,
  assertSafePath,
  PathTraversalError,
} from "./safe_path.ts";

Deno.test("assertSafePath", async (t) => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp-safe-path-" });

  try {
    // Set up test directory structure
    const boundary = join(tmpDir, "repo", ".swamp", "outputs");
    await Deno.mkdir(boundary, { recursive: true });

    const outsideDir = join(tmpDir, "outside");
    await Deno.mkdir(outsideDir, { recursive: true });

    await t.step("path within boundary passes", async () => {
      const subdir = join(boundary, "subdir");
      await Deno.mkdir(subdir, { recursive: true });

      // Should not throw
      await assertSafePath(subdir, boundary);
    });

    await t.step("path equal to boundary passes", async () => {
      await assertSafePath(boundary, boundary);
    });

    await t.step(
      "symlink escaping boundary throws PathTraversalError",
      async () => {
        const symlinkPath = join(boundary, "evil-link");
        await Deno.symlink(outsideDir, symlinkPath, { type: "dir" });

        try {
          await assertRejects(
            () => assertSafePath(join(symlinkPath, "file.txt"), boundary),
            PathTraversalError,
            "outside boundary",
          );
        } finally {
          await Deno.remove(symlinkPath);
        }
      },
    );

    await t.step(
      "non-existent path with no symlinks passes",
      async () => {
        const nonExistent = join(boundary, "does", "not", "exist", "yet");

        // Should not throw — all ancestors are real directories within boundary
        await assertSafePath(nonExistent, boundary);
      },
    );

    await t.step(
      "non-existent path where ancestor is symlink escaping boundary throws",
      async () => {
        const symlinkDir = join(boundary, "sneaky-dir");
        await Deno.symlink(outsideDir, symlinkDir, { type: "dir" });

        try {
          await assertRejects(
            () =>
              assertSafePath(
                join(symlinkDir, "subdir", "file.txt"),
                boundary,
              ),
            PathTraversalError,
            "outside boundary",
          );
        } finally {
          await Deno.remove(symlinkDir);
        }
      },
    );

    await t.step(
      "internal symlink staying within boundary passes",
      async () => {
        const realDir = join(boundary, "real-data");
        await Deno.mkdir(realDir, { recursive: true });
        const internalLink = join(boundary, "link-to-real");
        await Deno.symlink(realDir, internalLink, { type: "dir" });

        try {
          // Should not throw — symlink stays within the boundary
          await assertSafePath(join(internalLink, "file.txt"), boundary);
        } finally {
          await Deno.remove(internalLink);
        }
      },
    );

    await t.step(
      "boundary directory replaced with symlink throws",
      async () => {
        // This simulates the original attack: .swamp/outputs is a symlink
        const attackBoundary = join(tmpDir, "repo2", ".swamp", "outputs");
        await Deno.mkdir(join(tmpDir, "repo2", ".swamp"), { recursive: true });
        await Deno.symlink(outsideDir, attackBoundary, { type: "dir" });

        try {
          // The boundary itself is a symlink to outside — the path resolves
          // outside, but the boundary also resolves outside, so the check
          // passes. The real protection is at the parent level.
          const parentBoundary = join(tmpDir, "repo2", ".swamp");
          await assertRejects(
            () =>
              assertSafePath(join(attackBoundary, "file.txt"), parentBoundary),
            PathTraversalError,
            "outside boundary",
          );
        } finally {
          await Deno.remove(attackBoundary);
        }
      },
    );

    await t.step(
      "using symlinked directory as boundary does NOT catch the attack",
      async () => {
        // Demonstrates why the boundary must be the PARENT of the
        // potentially-symlinked directory, not the directory itself.
        const attackDir = join(tmpDir, "repo3", ".swamp", "outputs");
        await Deno.mkdir(join(tmpDir, "repo3", ".swamp"), { recursive: true });
        await Deno.symlink(outsideDir, attackDir, { type: "dir" });

        try {
          // Using the symlinked dir itself as boundary — both sides resolve
          // through the symlink, so the check passes (this is the bug).
          await assertSafePath(join(attackDir, "file.txt"), attackDir);
          // ^ Does NOT throw — demonstrating the incorrect boundary choice

          // Using the parent .swamp/ as boundary correctly catches it
          const correctBoundary = join(tmpDir, "repo3", ".swamp");
          await assertRejects(
            () => assertSafePath(join(attackDir, "file.txt"), correctBoundary),
            PathTraversalError,
          );
        } finally {
          await Deno.remove(attackDir);
          await Deno.remove(join(tmpDir, "repo3"), { recursive: true });
        }
      },
    );

    await t.step("PathTraversalError contains path details", async () => {
      const symlinkPath = join(boundary, "error-test-link");
      await Deno.symlink(outsideDir, symlinkPath, { type: "dir" });

      try {
        const filePath = join(symlinkPath, "secret.txt");
        const error = await assertRejects(
          () => assertSafePath(filePath, boundary),
          PathTraversalError,
        );
        assertEquals(error.path, filePath);
        assertEquals(error.boundary, boundary);
      } finally {
        await Deno.remove(symlinkPath);
      }
    });

    await t.step(
      "deeply nested child path is accepted (platform separator)",
      async () => {
        // Mirrors the bundle-cache path shape that fails on Windows when the
        // separator check is hardcoded to "/". Uses `join` so the path is
        // built with the platform's native separator.
        const nested = join(boundary, "bundles", "abc12345", "model.js");
        await Deno.mkdir(dirname(nested), { recursive: true });
        await Deno.writeTextFile(nested, "// test");

        try {
          await assertSafePath(nested, boundary);
        } finally {
          await Deno.remove(nested);
        }
      },
    );

    await t.step(
      "path lexically outside boundary throws (no symlinks)",
      async () => {
        const outsideFile = join(outsideDir, "secret.txt");
        await assertRejects(
          () => assertSafePath(outsideFile, boundary),
          PathTraversalError,
          "outside boundary",
        );
      },
    );

    await t.step(
      "file whose name starts with '..' is accepted as a child",
      async () => {
        // Guards against a string-prefix-vs-segment bug class: a future
        // refactor that checks `rel.startsWith("..")` would incorrectly
        // reject these legitimate child filenames.
        for (const name of ["..foo", "...config", "..hidden.txt"]) {
          const filePath = join(boundary, name);
          await Deno.writeTextFile(filePath, "");
          try {
            await assertSafePath(filePath, boundary);
          } finally {
            await Deno.remove(filePath);
          }
        }
      },
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("assertContainedPath", async (t) => {
  const boundary = "/fake/repo";

  await t.step("accepts simple relative paths", () => {
    assertContainedPath(".swamp/pulled-extensions/model.ts", boundary);
    assertContainedPath("extensions/models/foo.ts", boundary);
    assertContainedPath("a/b/c/d.txt", boundary);
  });

  await t.step("rejects empty string and identity path", () => {
    assertThrows(
      () => assertContainedPath("", boundary),
      PathTraversalError,
    );
    assertThrows(
      () => assertContainedPath(".", boundary),
      PathTraversalError,
    );
  });

  await t.step("rejects .. traversal", () => {
    assertThrows(
      () => assertContainedPath("../victim-data", boundary),
      PathTraversalError,
    );
    assertThrows(
      () => assertContainedPath("a/../../outside", boundary),
      PathTraversalError,
    );
    assertThrows(
      () => assertContainedPath(".swamp/../../../etc/passwd", boundary),
      PathTraversalError,
    );
  });

  await t.step("rejects absolute paths", () => {
    assertThrows(
      () => assertContainedPath("/etc/passwd", boundary),
      PathTraversalError,
    );
    assertThrows(
      () => assertContainedPath("/tmp/evil", boundary),
      PathTraversalError,
    );
  });

  await t.step("rejects null bytes", () => {
    assertThrows(
      () => assertContainedPath("file\0.txt", boundary),
      PathTraversalError,
    );
  });

  await t.step("accepts filenames starting with ..", () => {
    assertContainedPath("..foo", boundary);
    assertContainedPath("dir/..config", boundary);
    assertContainedPath("...hidden.txt", boundary);
  });
});
