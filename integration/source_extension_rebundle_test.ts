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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { initializeTestRepo, runCliCommand } from "./test_helpers.ts";
import { stringify as stringifyYaml } from "@std/yaml";

const BUNDLEABLE_V1 = `
import { z } from "npm:zod@4";

export const model = {
  type: "@user/source-rebundle-it",
  version: "2026.01.01.1",
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [], greeting: "V1" }),
    },
  },
};
`;

const BARE_SPECIFIER_V2 = `
import { z } from "zod";

export const model = {
  type: "@user/source-rebundle-it",
  version: "2026.01.01.2",
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [], greeting: "V2" }),
    },
    newMethod: {
      description: "New method added in V2",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [], result: "NEW" }),
    },
  },
};
`;

const WARNING_SUBSTRING = "source fingerprint preserved";

/**
 * Warm-start regression test for issue #265. Verifies that source-mounted
 * extensions with bare specifiers (triggering isExpectedBundleFailure) don't
 * permanently poison the catalog fingerprint when the bundle can't be
 * regenerated.
 *
 * Three assertion groups:
 * (a) Warning-log precision: unchanged source produces no warning.
 * (b) Permanent-failure determinism: modified source with bare specifier
 *     preserves catalog fingerprint and emits warning on every warm-start.
 * (c) Bundle content: old bundle stays on disk, new methods don't appear.
 */
Deno.test("Source-mounted extension: fingerprint preserved when bundle build fails (#265)", async () => {
  const repoDir = await Deno.makeTempDir({
    prefix: "swamp_it_source_rebundle_",
  });
  const extDir = await Deno.makeTempDir({
    prefix: "swamp_it_source_ext_",
  });
  try {
    await initializeTestRepo(repoDir);

    // Set up a source-mounted extension in a separate directory (no deno.json).
    const modelsDir = join(extDir, "models");
    await ensureDir(modelsDir);
    const sourcePath = join(modelsDir, "source_rebundle_it.ts");

    // Write .swamp-sources.yaml pointing to the external directory.
    await Deno.writeTextFile(
      join(repoDir, ".swamp-sources.yaml"),
      stringifyYaml({
        sources: [{ path: extDir }],
      } as Record<string, unknown>),
    );

    // --- Step 1: Prime with bundleable V1 ---
    await Deno.writeTextFile(sourcePath, BUNDLEABLE_V1);
    const prime = await runCliCommand(
      ["model", "type", "search", "source-rebundle-it", "--json"],
      repoDir,
    );
    assertEquals(
      prime.code,
      0,
      `Prime run failed:\nstdout=${prime.stdout}\nstderr=${prime.stderr}`,
    );
    assertStringIncludes(prime.stdout, "@user/source-rebundle-it");

    // Verify V1 bundle was created with V1 content.
    const bundlePath = await findBundle(repoDir, "source_rebundle_it.js");
    const v1Bundle = await Deno.readTextFile(bundlePath);
    assertStringIncludes(v1Bundle, "V1", "V1 bundle must contain V1 marker");

    // --- Step 2 (scenario c): Unchanged source — no warning ---
    // Use non-JSON mode so LogTape warnings reach stderr.
    const unchanged = await runCliCommand(
      ["model", "type", "search", "source-rebundle-it"],
      repoDir,
    );
    assertEquals(unchanged.code, 0);
    assertEquals(
      unchanged.stderr.includes(WARNING_SUBSTRING),
      false,
      "No warning expected when source is unchanged (legitimate cache hit)",
    );

    // --- Step 3 (scenario b): Modify source to bare specifier + new method ---
    await Deno.writeTextFile(sourcePath, BARE_SPECIFIER_V2);

    const firstRetry = await runCliCommand(
      ["model", "type", "search", "source-rebundle-it"],
      repoDir,
    );
    assertEquals(
      firstRetry.code,
      0,
      `First retry failed:\nstdout=${firstRetry.stdout}\nstderr=${firstRetry.stderr}`,
    );

    // Warning must fire: fromCache=true AND fingerprint differs.
    assertStringIncludes(
      firstRetry.stderr,
      WARNING_SUBSTRING,
      "Warning expected when bundle build fails and fingerprint is preserved",
    );

    // Bundle content must still be V1 (stale — the build failed).
    const afterFirstRetry = await Deno.readTextFile(bundlePath);
    assertStringIncludes(
      afterFirstRetry,
      "V1",
      "Bundle must still contain V1 marker — build failed, old cache used",
    );
    assertEquals(
      afterFirstRetry.includes("V2"),
      false,
      "V2 marker must NOT be in bundle — build failed",
    );

    // --- Step 4 (scenario b continued): Second warm-start — deterministic ---
    const secondRetry = await runCliCommand(
      ["model", "type", "search", "source-rebundle-it"],
      repoDir,
    );
    assertEquals(
      secondRetry.code,
      0,
      `Second retry failed:\nstdout=${secondRetry.stdout}\nstderr=${secondRetry.stderr}`,
    );

    // Warning must fire again — fingerprint still mismatches.
    assertStringIncludes(
      secondRetry.stderr,
      WARNING_SUBSTRING,
      "Warning expected on second retry — fingerprint still preserved",
    );

    // Bundle must still be V1.
    const afterSecondRetry = await Deno.readTextFile(bundlePath);
    assertStringIncludes(
      afterSecondRetry,
      "V1",
      "Bundle must still contain V1 marker on second retry",
    );
  } finally {
    try {
      await Deno.remove(repoDir, { recursive: true });
    } catch { /* EBUSY from sqlite — temp dir is ephemeral, OS reclaims */ }
    try {
      await Deno.remove(extDir, { recursive: true });
    } catch { /* best-effort cleanup */ }
  }
});

/**
 * Locates the bundle file by walking `.swamp/bundles/` — the intermediate
 * hash segment varies per source dir, so we search by filename.
 */
async function findBundle(
  repoDir: string,
  bundleName: string,
): Promise<string> {
  const bundlesRoot = join(repoDir, ".swamp", "bundles");
  return await walkForFile(bundlesRoot, bundleName);
}

async function walkForFile(dir: string, target: string): Promise<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isFile && entry.name === target) return path;
    if (entry.isDirectory) {
      try {
        return await walkForFile(path, target);
      } catch {
        // Not found in this subtree — continue.
      }
    }
  }
  throw new Error(`${target} not found under ${dir}`);
}
