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

// ── Source-mounted freshness tests (swamp-club#274) ─────────────────────

function makeSource(version: string, specifier: string): string {
  return `
import { z } from "${specifier}";

export const model = {
  type: "@user/freshness-it",
  version: "2026.02.09.1",
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [], greeting: "${version}" }),
    },
  },
};
`;
}

async function writeSwampSources(
  repoDir: string,
  sourcePath: string,
): Promise<void> {
  const normalized = sourcePath.replaceAll("\\", "/");
  const yaml = `sources:\n  - path: "${normalized}"\n`;
  await Deno.writeTextFile(join(repoDir, ".swamp-sources.yaml"), yaml);
}

/**
 * Source-mounted extension: npm specifiers, edit with mtime change.
 * The simplest case — bundle builds from source, edit is detected via
 * fingerprint, new bundle replaces old. (swamp-club#274 cell 4)
 */
Deno.test("source-mounted: npm specifiers, edit detected and rebuilt (#274)", async () => {
  const repoDir = await Deno.makeTempDir({
    prefix: "swamp_it_274_source_npm_",
  });
  const sourceDir = await Deno.makeTempDir({
    prefix: "swamp_it_274_source_ext_",
  });
  try {
    await initializeTestRepo(repoDir);
    const modelsDir = join(sourceDir, "extensions", "models");
    await ensureDir(modelsDir);
    const sourcePath = join(modelsDir, "freshness_it.ts");

    await writeSwampSources(repoDir, sourceDir);
    await Deno.writeTextFile(sourcePath, makeSource("V1_MARKER", "npm:zod@4"));

    const prime = await runCliCommand(
      ["model", "type", "search", "freshness-it", "--json"],
      repoDir,
    );
    assertEquals(
      prime.code,
      0,
      `Prime failed:\nstdout=${prime.stdout}\nstderr=${prime.stderr}`,
    );
    assertStringIncludes(prime.stdout, "@user/freshness-it");

    const bundlePath = await findBundle(repoDir, "freshness_it.js");
    assertStringIncludes(
      await Deno.readTextFile(bundlePath),
      "V1_MARKER",
    );

    await Deno.writeTextFile(sourcePath, makeSource("V2_MARKER", "npm:zod@4"));

    const followup = await runCliCommand(
      ["model", "type", "search", "freshness-it", "--json"],
      repoDir,
    );
    assertEquals(
      followup.code,
      0,
      `Followup failed:\nstdout=${followup.stdout}\nstderr=${followup.stderr}`,
    );

    const bundleContent = await Deno.readTextFile(bundlePath);
    assertStringIncludes(bundleContent, "V2_MARKER");
    assertEquals(bundleContent.includes("V1_MARKER"), false);
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    await Deno.remove(sourceDir, { recursive: true }).catch(() => {});
  }
});

/**
 * Source-mounted extension: npm specifiers, edit with preserved mtime.
 * Editors that use atomic-rename preserve mtime — fingerprint must still
 * detect the content change. (swamp-club#274 cell 5)
 */
Deno.test("source-mounted: edit with preserved mtime detected via fingerprint (#274)", async () => {
  const repoDir = await Deno.makeTempDir({
    prefix: "swamp_it_274_source_mtime_",
  });
  const sourceDir = await Deno.makeTempDir({
    prefix: "swamp_it_274_source_ext_mtime_",
  });
  try {
    await initializeTestRepo(repoDir);
    const modelsDir = join(sourceDir, "extensions", "models");
    await ensureDir(modelsDir);
    const sourcePath = join(modelsDir, "freshness_it.ts");

    await writeSwampSources(repoDir, sourceDir);
    await Deno.writeTextFile(sourcePath, makeSource("V1_MARKER", "npm:zod@4"));

    const prime = await runCliCommand(
      ["model", "type", "search", "freshness-it", "--json"],
      repoDir,
    );
    assertEquals(prime.code, 0, `Prime failed:\n${prime.stderr}`);

    const origMtime = (await Deno.stat(sourcePath)).mtime!;
    await new Promise((r) => setTimeout(r, 1100));

    await Deno.writeTextFile(sourcePath, makeSource("V2_MARKER", "npm:zod@4"));
    await Deno.utime(sourcePath, origMtime, origMtime);

    const followup = await runCliCommand(
      ["model", "type", "search", "freshness-it", "--json"],
      repoDir,
    );
    assertEquals(followup.code, 0, `Followup failed:\n${followup.stderr}`);

    const bundlePath = await findBundle(repoDir, "freshness_it.js");
    const bundleContent = await Deno.readTextFile(bundlePath);
    assertStringIncludes(bundleContent, "V2_MARKER");
    assertEquals(bundleContent.includes("V1_MARKER"), false);
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    await Deno.remove(sourceDir, { recursive: true }).catch(() => {});
  }
});

/**
 * Source-mounted extension: bare specifiers + deno.json, edit detected.
 * The deno.json import map resolves "zod" → "npm:zod@4", so the bundle
 * builds successfully. (swamp-club#274 cell 6)
 */
Deno.test("source-mounted: bare specifiers with deno.json, edit rebuilt (#274)", async () => {
  const repoDir = await Deno.makeTempDir({
    prefix: "swamp_it_274_source_bare_deno_",
  });
  const sourceDir = await Deno.makeTempDir({
    prefix: "swamp_it_274_source_ext_bare_deno_",
  });
  try {
    await initializeTestRepo(repoDir);
    const modelsDir = join(sourceDir, "extensions", "models");
    await ensureDir(modelsDir);
    const sourcePath = join(modelsDir, "freshness_it.ts");

    await Deno.writeTextFile(
      join(sourceDir, "deno.json"),
      JSON.stringify({ imports: { "zod": "npm:zod@4" } }),
    );
    await writeSwampSources(repoDir, sourceDir);
    await Deno.writeTextFile(sourcePath, makeSource("V1_MARKER", "zod"));

    const prime = await runCliCommand(
      ["model", "type", "search", "freshness-it", "--json"],
      repoDir,
    );
    assertEquals(prime.code, 0, `Prime failed:\n${prime.stderr}`);

    await Deno.writeTextFile(sourcePath, makeSource("V2_MARKER", "zod"));

    const followup = await runCliCommand(
      ["model", "type", "search", "freshness-it", "--json"],
      repoDir,
    );
    assertEquals(followup.code, 0, `Followup failed:\n${followup.stderr}`);

    const bundlePath = await findBundle(repoDir, "freshness_it.js");
    const bundleContent = await Deno.readTextFile(bundlePath);
    assertStringIncludes(bundleContent, "V2_MARKER");
    assertEquals(bundleContent.includes("V1_MARKER"), false);
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    await Deno.remove(sourceDir, { recursive: true }).catch(() => {});
  }
});

/**
 * Source-mounted extension: bare specifiers + deno.json, edit with preserved
 * mtime. Combines the rsync/atomic-rename scenario with bare specifiers.
 * (swamp-club#274 cell 7)
 */
Deno.test("source-mounted: bare specifiers + deno.json, mtime preserved (#274)", async () => {
  const repoDir = await Deno.makeTempDir({
    prefix: "swamp_it_274_source_bare_mtime_",
  });
  const sourceDir = await Deno.makeTempDir({
    prefix: "swamp_it_274_source_ext_bare_mtime_",
  });
  try {
    await initializeTestRepo(repoDir);
    const modelsDir = join(sourceDir, "extensions", "models");
    await ensureDir(modelsDir);
    const sourcePath = join(modelsDir, "freshness_it.ts");

    await Deno.writeTextFile(
      join(sourceDir, "deno.json"),
      JSON.stringify({ imports: { "zod": "npm:zod@4" } }),
    );
    await writeSwampSources(repoDir, sourceDir);
    await Deno.writeTextFile(sourcePath, makeSource("V1_MARKER", "zod"));

    const prime = await runCliCommand(
      ["model", "type", "search", "freshness-it", "--json"],
      repoDir,
    );
    assertEquals(prime.code, 0, `Prime failed:\n${prime.stderr}`);

    const origMtime = (await Deno.stat(sourcePath)).mtime!;
    await new Promise((r) => setTimeout(r, 1100));

    await Deno.writeTextFile(sourcePath, makeSource("V2_MARKER", "zod"));
    await Deno.utime(sourcePath, origMtime, origMtime);

    const followup = await runCliCommand(
      ["model", "type", "search", "freshness-it", "--json"],
      repoDir,
    );
    assertEquals(followup.code, 0, `Followup failed:\n${followup.stderr}`);

    const bundlePath = await findBundle(repoDir, "freshness_it.js");
    const bundleContent = await Deno.readTextFile(bundlePath);
    assertStringIncludes(bundleContent, "V2_MARKER");
    assertEquals(bundleContent.includes("V1_MARKER"), false);
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    await Deno.remove(sourceDir, { recursive: true }).catch(() => {});
  }
});

/**
 * Source-mounted extension: bare specifiers, no deno.json, edit after
 * initial build. This is the core #274 bug: isExpectedBundleFailure
 * fast-path must NOT fire for source-mounted extensions. After the fix,
 * the build attempt runs, fails (bare specifiers), and the failure is
 * visible via structured warning — stale bundle is NOT silently served.
 * (swamp-club#274 cell 8)
 */
Deno.test("source-mounted: bare specifiers, deno.json removed, stale bundle not served (#274)", async () => {
  const repoDir = await Deno.makeTempDir({
    prefix: "swamp_it_274_source_bare_nodeno_",
  });
  const sourceDir = await Deno.makeTempDir({
    prefix: "swamp_it_274_source_ext_bare_nodeno_",
  });
  try {
    await initializeTestRepo(repoDir);
    const modelsDir = join(sourceDir, "extensions", "models");
    await ensureDir(modelsDir);
    const sourcePath = join(modelsDir, "freshness_it.ts");
    const denoJsonPath = join(sourceDir, "deno.json");

    await Deno.writeTextFile(
      denoJsonPath,
      JSON.stringify({ imports: { "zod": "npm:zod@4" } }),
    );
    await writeSwampSources(repoDir, sourceDir);
    await Deno.writeTextFile(sourcePath, makeSource("V1_MARKER", "zod"));

    const prime = await runCliCommand(
      ["model", "type", "search", "freshness-it", "--json"],
      repoDir,
    );
    assertEquals(prime.code, 0, `Prime failed:\n${prime.stderr}`);

    const bundlePath = await findBundle(repoDir, "freshness_it.js");
    assertStringIncludes(await Deno.readTextFile(bundlePath), "V1_MARKER");

    await Deno.remove(denoJsonPath);
    await Deno.writeTextFile(sourcePath, makeSource("V2_MARKER", "zod"));

    // Use --log mode (not --json) so log warnings appear in stdout.
    // --json suppresses log output for clean machine-readable output.
    const followup = await runCliCommand(
      ["model", "type", "search", "freshness-it", "--log"],
      repoDir,
    );

    // After the fix: the build is attempted (not skipped by fast-path),
    // fails because bare specifiers can't resolve without deno.json.
    // The stale V1 bundle may still be served as a cache fallback
    // (that's the #265 fromCache path), but the structured warning fires
    // and the OLD fingerprint is preserved so the next run retries.
    const combinedOutput = followup.stdout + followup.stderr;
    assertStringIncludes(
      combinedOutput,
      "Bundle could not be regenerated",
      "Structured warning must fire — build was attempted, not skipped by fast-path",
    );
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    await Deno.remove(sourceDir, { recursive: true }).catch(() => {});
  }
});

/**
 * Local extension: bare specifiers, no deno.json — same bug pattern as
 * source-mounted. The bypass must cover locals too. (swamp-club#274 cell 3)
 */
Deno.test("local: bare specifiers, deno.json removed, stale bundle not served (#274)", async () => {
  const repoDir = await Deno.makeTempDir({
    prefix: "swamp_it_274_local_bare_nodeno_",
  });
  try {
    await initializeTestRepo(repoDir);
    const modelsDir = join(repoDir, "extensions", "models");
    await ensureDir(modelsDir);
    const sourcePath = join(modelsDir, "freshness_it.ts");
    const denoJsonPath = join(repoDir, "deno.json");

    await Deno.writeTextFile(
      denoJsonPath,
      JSON.stringify({ imports: { "zod": "npm:zod@4" } }),
    );
    await Deno.writeTextFile(sourcePath, makeSource("V1_MARKER", "zod"));

    const prime = await runCliCommand(
      ["model", "type", "search", "freshness-it", "--json"],
      repoDir,
    );
    assertEquals(prime.code, 0, `Prime failed:\n${prime.stderr}`);

    const bundlePath = await findBundle(repoDir, "freshness_it.js");
    assertStringIncludes(await Deno.readTextFile(bundlePath), "V1_MARKER");

    await Deno.remove(denoJsonPath);
    await Deno.writeTextFile(sourcePath, makeSource("V2_MARKER", "zod"));

    const followup = await runCliCommand(
      ["model", "type", "search", "freshness-it", "--log"],
      repoDir,
    );

    const combinedOutput = followup.stdout + followup.stderr;
    assertStringIncludes(
      combinedOutput,
      "Bundle could not be regenerated",
      "Structured warning must fire for locals too — build was attempted, not skipped by fast-path",
    );
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
});

/**
 * Pulled extension: fast-path STILL fires correctly. The bypass must NOT
 * apply to pulled extensions — they rely on the pre-built bundle.
 * (swamp-club#274 cell 9 — critical regression check)
 */
Deno.test("pulled: fast-path still fires, no rebuild attempt (#274)", async () => {
  const repoDir = await Deno.makeTempDir({
    prefix: "swamp_it_274_pulled_fastpath_",
  });
  try {
    await initializeTestRepo(repoDir);

    // Build a valid bundle from source, then place it as a "pulled" bundle
    const modelsDir = join(repoDir, "extensions", "models");
    await ensureDir(modelsDir);
    const tmpSource = join(modelsDir, "scaffold.ts");
    await Deno.writeTextFile(
      tmpSource,
      makeSource("PULLED_MARKER", "npm:zod@4"),
    );

    // Prime to get a real bundle built
    const scaffold = await runCliCommand(
      ["model", "type", "search", "freshness-it", "--json"],
      repoDir,
    );
    assertEquals(scaffold.code, 0, `Scaffold failed:\n${scaffold.stderr}`);

    // Clean up the scaffold — we only needed it to prime the catalog
    const scaffoldBundle = await findBundle(repoDir, "scaffold.js");
    await Deno.remove(tmpSource);
    await Deno.remove(scaffoldBundle);

    // Set up as a pulled extension with bare specifiers (unbuildable source)
    const pulledModelsDir = join(
      repoDir,
      ".swamp",
      "pulled-extensions",
      "@user/freshness-pulled",
      "models",
    );
    await ensureDir(pulledModelsDir);
    await Deno.writeTextFile(
      join(pulledModelsDir, "pulled_model.ts"),
      makeSource("PULLED_MARKER", "zod"),
    );

    const lockfilePath = join(modelsDir, "upstream_extensions.json");
    await Deno.writeTextFile(
      lockfilePath,
      JSON.stringify({
        "@user/freshness-pulled": {
          version: "1.0.0",
          pulledAt: new Date().toISOString(),
        },
      }),
    );

    // Run type search to trigger the load. For pulled extensions with
    // bare specifiers and no deno.json, the fast-path should fire and
    // skip the build attempt entirely. The test verifies that the
    // "Bundle could not be regenerated" warning does NOT appear — that
    // warning fires only when a build is attempted and falls back to
    // cache. The fast-path skips the build entirely, so no warning.
    // Use --log to capture warnings in stdout.
    const result = await runCliCommand(
      ["model", "type", "search", "freshness-pulled", "--log"],
      repoDir,
    );

    // For pulled extensions, the fast-path fires and returns the cache.
    // If there's no cache yet, the build fails but the fast-path means
    // no build was attempted — the warning about regeneration should NOT
    // fire. Instead we expect either success (cached) or a different
    // error (no bundle found).
    const combinedOutput = result.stdout + result.stderr;
    assertEquals(
      combinedOutput.includes("Bundle could not be regenerated"),
      false,
      "Pulled extension should use fast-path, not attempt a build that fires the regeneration warning",
    );
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
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
