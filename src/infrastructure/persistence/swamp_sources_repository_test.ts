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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  collectDirsForKind,
  expandSourcePaths,
  readSwampSources,
  removeSwampSources,
  resolveSourceExtensionDirs,
  writeSwampSources,
} from "./swamp_sources_repository.ts";

Deno.test("readSwampSources: returns null when file does not exist", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_sources_test_" });
  try {
    const result = await readSwampSources(tmpDir);
    assertEquals(result, null);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("readSwampSources: parses valid sources file", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_sources_test_" });
  try {
    await Deno.writeTextFile(
      join(tmpDir, ".swamp-sources.yaml"),
      "sources:\n  - path: /tmp/ext-a\n  - path: /tmp/ext-b\n    only: [models]\n",
    );
    const result = await readSwampSources(tmpDir);
    assertEquals(result?.sources.length, 2);
    assertEquals(result?.sources[0].path, "/tmp/ext-a");
    assertEquals(result?.sources[1].only, ["models"]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("writeSwampSources: creates file and readSwampSources reads it back", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_sources_test_" });
  try {
    await writeSwampSources(tmpDir, {
      sources: [{ path: "/tmp/my-ext", only: ["vaults"] }],
    });
    const result = await readSwampSources(tmpDir);
    assertEquals(result?.sources.length, 1);
    assertEquals(result?.sources[0].path, "/tmp/my-ext");
    assertEquals(result?.sources[0].only, ["vaults"]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("removeSwampSources: deletes file", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_sources_test_" });
  try {
    await writeSwampSources(tmpDir, {
      sources: [{ path: "/tmp/ext" }],
    });
    await removeSwampSources(tmpDir);
    const result = await readSwampSources(tmpDir);
    assertEquals(result, null);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("removeSwampSources: no-op when file does not exist", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_sources_test_" });
  try {
    // Should not throw
    await removeSwampSources(tmpDir);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("expandSourcePaths: expands non-glob path as-is", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_sources_test_" });
  try {
    const result = await expandSourcePaths(
      { sources: [{ path: "/tmp/my-ext" }] },
      tmpDir,
    );
    assertEquals(result.length, 1);
    assertEquals(result[0].path, "/tmp/my-ext");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("expandSourcePaths: expands glob to matching directories", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_sources_test_" });
  try {
    // Create some directories matching the glob
    await Deno.mkdir(join(tmpDir, "exts", "a"), { recursive: true });
    await Deno.mkdir(join(tmpDir, "exts", "b"), { recursive: true });
    // Create a file (should not be included)
    await Deno.writeTextFile(join(tmpDir, "exts", "file.txt"), "");

    const result = await expandSourcePaths(
      { sources: [{ path: join(tmpDir, "exts", "*") }] },
      tmpDir,
    );
    assertEquals(result.length, 2);
    const paths = result.map((s) => s.path).sort();
    assertEquals(paths[0].endsWith("/a"), true);
    assertEquals(paths[1].endsWith("/b"), true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("expandSourcePaths: inherits only filter from parent", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_sources_test_" });
  try {
    await Deno.mkdir(join(tmpDir, "exts", "a"), { recursive: true });

    const result = await expandSourcePaths(
      { sources: [{ path: join(tmpDir, "exts", "*"), only: ["vaults"] }] },
      tmpDir,
    );
    assertEquals(result.length, 1);
    assertEquals(result[0].only, ["vaults"]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("resolveSourceExtensionDirs: finds extensions/models/ in source", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_sources_test_" });
  try {
    // Create a source with standard extension layout
    const sourceDir = join(tmpDir, "my-ext");
    await Deno.mkdir(join(sourceDir, "extensions", "models"), {
      recursive: true,
    });

    const result = await resolveSourceExtensionDirs([
      { path: sourceDir },
    ]);
    assertEquals(result.length, 1);
    assertEquals(result[0].sourcePath, sourceDir);
    assertEquals(
      result[0].modelsDir,
      join(sourceDir, "extensions", "models"),
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("resolveSourceExtensionDirs: respects only filter", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_sources_test_" });
  try {
    const sourceDir = join(tmpDir, "my-ext");
    await Deno.mkdir(join(sourceDir, "extensions", "models"), {
      recursive: true,
    });
    await Deno.mkdir(join(sourceDir, "extensions", "vaults"), {
      recursive: true,
    });

    const result = await resolveSourceExtensionDirs([
      { path: sourceDir, only: ["vaults"] },
    ]);
    assertEquals(result[0].modelsDir, undefined);
    assertEquals(
      result[0].vaultsDir,
      join(sourceDir, "extensions", "vaults"),
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("resolveSourceExtensionDirs: handles missing source path gracefully", async () => {
  const result = await resolveSourceExtensionDirs([
    { path: "/nonexistent/path" },
  ]);
  assertEquals(result.length, 1);
  assertEquals(result[0].sourcePath, "/nonexistent/path");
  assertEquals(result[0].modelsDir, undefined);
});

Deno.test("resolveSourceExtensionDirs: reads source .swamp.yaml for custom dirs", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_sources_test_" });
  try {
    const sourceDir = join(tmpDir, "my-ext");
    await Deno.mkdir(join(sourceDir, "custom-models"), { recursive: true });
    await Deno.writeTextFile(
      join(sourceDir, ".swamp.yaml"),
      'swampVersion: "1.0.0"\ninitializedAt: "2026-01-01"\nmodelsDir: custom-models\n',
    );

    const result = await resolveSourceExtensionDirs([
      { path: sourceDir },
    ]);
    assertEquals(
      result[0].modelsDir,
      join(sourceDir, "custom-models"),
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("collectDirsForKind: extracts dirs for specific kind", () => {
  const sources = [
    {
      sourcePath: "/a",
      modelsDir: "/a/extensions/models",
      vaultsDir: "/a/extensions/vaults",
    },
    {
      sourcePath: "/b",
      modelsDir: "/b/extensions/models",
    },
  ];
  const models = collectDirsForKind(sources, "models");
  assertEquals(models, ["/a/extensions/models", "/b/extensions/models"]);

  const vaults = collectDirsForKind(sources, "vaults");
  assertEquals(vaults, ["/a/extensions/vaults"]);

  const drivers = collectDirsForKind(sources, "drivers");
  assertEquals(drivers, []);
});
