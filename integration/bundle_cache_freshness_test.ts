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

const V1_SOURCE = `
import { z } from "npm:zod@4";

export const model = {
  type: "@user/freshness-it",
  version: "2026.02.09.1",
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [], greeting: "V1_MARKER" }),
    },
  },
};
`;

const V2_SOURCE = `
import { z } from "npm:zod@4";

export const model = {
  type: "@user/freshness-it",
  version: "2026.02.09.1",
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [], greeting: "V2_MARKER" }),
    },
  },
};
`;

/**
 * Full end-to-end test for issue #125. Spawns the CLI, primes the bundle,
 * replaces the source with mtime preserved (the atomic-rename-style write
 * that editors / rsync --times / sub-ms saves all produce), and asserts
 * the second invocation sees the new behavior — not the stale cached
 * bundle.
 */
Deno.test("CLI rebundles user extension when source content changes with preserved mtime (#125)", async () => {
  const repoDir = await Deno.makeTempDir({
    prefix: "swamp_it_bundle_freshness_",
  });
  try {
    await initializeTestRepo(repoDir);
    const modelsDir = join(repoDir, "extensions", "models");
    await ensureDir(modelsDir);
    const sourcePath = join(modelsDir, "freshness_it.ts");

    // Prime with V1 — `type search` triggers buildIndex + catalog populate.
    await Deno.writeTextFile(sourcePath, V1_SOURCE);
    const prime = await runCliCommand(
      ["model", "type", "search", "freshness-it", "--json"],
      repoDir,
    );
    assertEquals(
      prime.code,
      0,
      `Prime run failed:\nstdout=${prime.stdout}\nstderr=${prime.stderr}`,
    );
    assertStringIncludes(prime.stdout, "@user/freshness-it");

    // Find the bundle file and confirm V1 marker is in it.
    const bundleV1 = await findBundle(repoDir, "freshness_it.js");
    assertStringIncludes(
      await Deno.readTextFile(bundleV1),
      "V1_MARKER",
      "V1 bundle must contain V1_MARKER",
    );

    // Preserve the original mtime so the staleness check cannot rely on
    // mtime advancing — this is the core of the bug.
    const origMtime = (await Deno.stat(sourcePath)).mtime!;

    // Advance wall clock at least one second, then overwrite content
    // and restore the original mtime.
    await new Promise((r) => setTimeout(r, 1100));
    await Deno.writeTextFile(sourcePath, V2_SOURCE);
    await Deno.utime(sourcePath, origMtime, origMtime);

    // Re-run — buildIndex must detect the content change via fingerprint
    // and rebundle. If the mtime-only freshness check is in effect the
    // old bundle is reused and V2_MARKER never appears.
    const followup = await runCliCommand(
      ["model", "type", "search", "freshness-it", "--json"],
      repoDir,
    );
    assertEquals(
      followup.code,
      0,
      `Followup run failed:\nstdout=${followup.stdout}\nstderr=${followup.stderr}`,
    );

    const bundleV2Content = await Deno.readTextFile(bundleV1);
    assertStringIncludes(
      bundleV2Content,
      "V2_MARKER",
      "V2 bundle must contain V2_MARKER — bundle cache failed to invalidate on content change with preserved mtime",
    );
    assertEquals(
      bundleV2Content.includes("V1_MARKER"),
      false,
      "V1 marker must be gone from the regenerated bundle",
    );
  } finally {
    await Deno.remove(repoDir, { recursive: true });
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
  for await (const topEntry of Deno.readDir(bundlesRoot)) {
    if (!topEntry.isDirectory) continue;
    const nsDir = join(bundlesRoot, topEntry.name);
    for await (const child of Deno.readDir(nsDir)) {
      if (child.isFile && child.name === bundleName) {
        return join(nsDir, child.name);
      }
    }
  }
  throw new Error(`Bundle ${bundleName} not found under ${bundlesRoot}`);
}
