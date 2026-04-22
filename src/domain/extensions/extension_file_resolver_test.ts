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

import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { resolveExtensionFile } from "./extension_file_resolver.ts";
import { UserError } from "../errors.ts";

async function withTempRoot(fn: (root: string) => Promise<void>) {
  const root = await Deno.makeTempDir({ prefix: "ext-file-resolver-test-" });
  try {
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("resolveExtensionFile: undefined root throws 'not shipped as an extension'", () => {
  assertThrows(
    () => resolveExtensionFile(undefined, "prompts/review.md"),
    UserError,
    "shipped via an extension manifest",
  );
});

Deno.test("resolveExtensionFile: unsafe relPath with '..' throws", async () => {
  await withTempRoot(async (root) => {
    assertThrows(
      () => resolveExtensionFile(root, "../outside.md"),
      UserError,
      "Unsafe relative path",
    );
    await Promise.resolve();
  });
});

Deno.test("resolveExtensionFile: absolute relPath throws", async () => {
  await withTempRoot(async (root) => {
    assertThrows(
      () => resolveExtensionFile(root, "/etc/passwd"),
      UserError,
      "Unsafe relative path",
    );
    await Promise.resolve();
  });
});

Deno.test("resolveExtensionFile: source-mode missing file shows disk-path hint", async () => {
  await withTempRoot(async (root) => {
    const err = assertThrows(
      () => resolveExtensionFile(root, "missing.md"),
      UserError,
      "Extension file not found",
    );
    // Source-mode message points at the absolute path and mentions disk/manifest.
    if (err instanceof Error) {
      const msg = err.message;
      if (!msg.includes(join(root, "missing.md"))) {
        throw new Error(
          `expected source-mode error to name the absolute path, got: ${msg}`,
        );
      }
      if (!msg.toLowerCase().includes("manifest")) {
        throw new Error(
          `expected source-mode error to mention the manifest, got: ${msg}`,
        );
      }
    }
    await Promise.resolve();
  });
});

Deno.test("resolveExtensionFile: pulled-mode missing file suggests re-publish", async () => {
  await withTempRoot(async (root) => {
    // Construct a path containing the pulled-extensions marker.
    const pulledRoot = join(
      root,
      ".swamp",
      "pulled-extensions",
      "@test",
      "ext",
      "files",
    );
    await Deno.mkdir(pulledRoot, { recursive: true });

    const err = assertThrows(
      () => resolveExtensionFile(pulledRoot, "prompts/review.md"),
      UserError,
      "re-publish",
    );
    if (err instanceof Error && !err.message.includes("re-pull")) {
      throw new Error(
        `expected pulled-mode error to reference re-pull migration hint, got: ${err.message}`,
      );
    }
  });
});

Deno.test("resolveExtensionFile: valid relPath resolves to absolute path", async () => {
  await withTempRoot(async (root) => {
    await Deno.mkdir(join(root, "prompts"), { recursive: true });
    await Deno.writeTextFile(join(root, "prompts", "review.md"), "hello");

    const absPath = resolveExtensionFile(root, "prompts/review.md");
    assertEquals(absPath, join(root, "prompts", "review.md"));
  });
});

Deno.test("resolveExtensionFile: zero-byte file resolves cleanly", async () => {
  await withTempRoot(async (root) => {
    await Deno.writeTextFile(join(root, "empty.md"), "");
    const absPath = resolveExtensionFile(root, "empty.md");
    assertEquals(absPath, join(root, "empty.md"));
  });
});
