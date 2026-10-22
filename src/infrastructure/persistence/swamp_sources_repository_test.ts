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

import { assertEquals, assertRejects } from "@std/assert";
import { basename, dirname, join } from "@std/path";
import {
  collectDirsForKind,
  expandSourcePaths,
  flattenSourceKindDirs,
  readSwampSources,
  removeSwampSources,
  resolveExtensionKindsForSource,
  resolveMountedSourceDirs,
  resolveSourceExtensionDirs,
  writeSwampSources,
} from "./swamp_sources_repository.ts";
import type { ExtensionKind } from "../../domain/repo/swamp_sources.ts";
import { assertPathEquals } from "./path_test_helpers.ts";
import { withMockedCommand } from "@swamp-club/swamp-testing";

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
    assertPathEquals(result?.sources[0].path, "/tmp/ext-a");
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
    assertPathEquals(result?.sources[0].path, "/tmp/my-ext");
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
    assertPathEquals(result[0].path, "/tmp/my-ext");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("expandSourcePaths: resolves relative paths against sourceBaseDir when provided", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_sources_test_" });
  try {
    const mainRoot = join(tmpDir, "main-checkout");
    const worktreeRoot = join(
      tmpDir,
      "main-checkout",
      ".claude",
      "worktrees",
      "test",
    );
    const siblingDir = join(tmpDir, "sibling-repo");
    await Deno.mkdir(siblingDir, { recursive: true });
    await Deno.mkdir(worktreeRoot, { recursive: true });
    await Deno.mkdir(mainRoot, { recursive: true });

    const result = await expandSourcePaths(
      { sources: [{ path: "../sibling-repo" }] },
      worktreeRoot,
      mainRoot,
    );
    assertEquals(result.length, 1);
    assertPathEquals(result[0].path, siblingDir);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("expandSourcePaths: falls back to repoDir when sourceBaseDir not provided", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_sources_test_" });
  try {
    const result = await expandSourcePaths(
      { sources: [{ path: "../sibling" }] },
      tmpDir,
    );
    assertEquals(result.length, 1);
    assertPathEquals(result[0].path, join(tmpDir, "..", "sibling"));
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
    assertEquals(basename(paths[0]), "a");
    assertEquals(basename(paths[1]), "b");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("expandSourcePaths: a glob survives directories appearing and disappearing under it", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_sources_test_" });
  let stop = false;
  // Lock directories that come and go, as in a home directory.
  const churn = (async () => {
    for (let n = 0; !stop; n++) {
      const lockDir = join(tmpDir, "exts", `lock-${n % 500}`);
      try {
        await Deno.mkdir(lockDir);
        await Deno.remove(lockDir);
      } catch {
        // Another iteration already created or removed it.
      }
    }
  })();
  try {
    await Deno.mkdir(join(tmpDir, "exts", "a"), { recursive: true });
    await Deno.mkdir(join(tmpDir, "exts", "b"), { recursive: true });
    for (let i = 0; i < 100; i++) {
      const result = await expandSourcePaths(
        { sources: [{ path: join(tmpDir, "exts", "*") }] },
        tmpDir,
      );
      const stable = result.map((s) => basename(s.path))
        .filter((name) => !name.startsWith("lock-"));
      assertEquals(stable, ["a", "b"]);
    }
  } finally {
    stop = true;
    await churn;
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

    const { resolved: result } = await resolveSourceExtensionDirs([
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

    const { resolved: result } = await resolveSourceExtensionDirs([
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
  const { resolved: result } = await resolveSourceExtensionDirs([
    { path: "/nonexistent/path" },
  ]);
  assertEquals(result.length, 1);
  assertPathEquals(result[0].sourcePath, "/nonexistent/path");
  assertEquals(result[0].modelsDir, undefined);
});

Deno.test("resolveSourceExtensionDirs: returns warning for missing source path", async () => {
  const { warnings } = await resolveSourceExtensionDirs([
    { path: "/nonexistent/path/for/warning/test" },
  ]);
  assertEquals(warnings.length, 1);
  assertPathEquals(
    warnings[0].sourcePath,
    "/nonexistent/path/for/warning/test",
  );
  assertEquals(warnings[0].reason, "not_found");
});

Deno.test("resolveSourceExtensionDirs: returns warning for non-directory source path", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_sources_test_" });
  try {
    const filePath = join(tmpDir, "not-a-dir");
    await Deno.writeTextFile(filePath, "");
    const { warnings } = await resolveSourceExtensionDirs([
      { path: filePath },
    ]);
    assertEquals(warnings.length, 1);
    assertEquals(warnings[0].reason, "not_a_directory");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("resolveSourceExtensionDirs: no warnings for valid source", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_sources_test_" });
  try {
    const sourceDir = join(tmpDir, "valid-ext");
    await Deno.mkdir(join(sourceDir, "extensions", "models"), {
      recursive: true,
    });
    const { warnings } = await resolveSourceExtensionDirs([
      { path: sourceDir },
    ]);
    assertEquals(warnings.length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
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

    const { resolved: result } = await resolveSourceExtensionDirs([
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

  const datastores = collectDirsForKind(sources, "datastores");
  assertEquals(datastores, []);
});

// -----------------------------------------------------------------
// Snapshot tests for resolveSourceExtensionDirs.
//
// These pin load-time behaviour across the `readSourceMarker` extraction
// added in the issue-139 fix. Each fixture covers a case that exercises
// a distinct branch of the resolver: layout default, layout override via
// marker, missing path, glob expansion, single `only` filter, multi-kind
// roots, and per-kind dir existence checks.
//
// If any snapshot needs updating, verify the change is intentional and
// propagate it to the parity test below.
// -----------------------------------------------------------------

/** Serialise a ResolvedSourceDirs array relative to a base tmp dir so
 * snapshots are stable across different test environments. */
function snapshotResolved(
  results: ReadonlyArray<unknown>,
  base: string,
): Array<Record<string, string | undefined>> {
  const rel = (v: unknown): string | undefined => {
    if (typeof v !== "string") return undefined;
    const stripped = v.startsWith(base) ? v.slice(base.length) : v;
    // Normalize Windows backslashes so the snapshot matches forward-slash
    // expected literals — POSIX no-op.
    return stripped.replaceAll("\\", "/");
  };
  return results.map((r) => {
    const out: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
      out[k] = rel(v);
    }
    return out;
  });
}

Deno.test("resolveSourceExtensionDirs snapshot: all five kinds present", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_snap_" });
  try {
    const src = join(tmp, "all");
    for (
      const kind of [
        "models",
        "vaults",
        "datastores",
        "reports",
        "workflows",
      ]
    ) {
      await Deno.mkdir(join(src, "extensions", kind), { recursive: true });
    }
    const { resolved: result } = await resolveSourceExtensionDirs([{
      path: src,
    }]);
    assertEquals(snapshotResolved(result, tmp), [
      {
        sourcePath: "/all",
        modelsDir: "/all/extensions/models",
        vaultsDir: "/all/extensions/vaults",
        datastoresDir: "/all/extensions/datastores",
        reportsDir: "/all/extensions/reports",
        workflowsDir: "/all/extensions/workflows",
      },
    ]);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("resolveSourceExtensionDirs snapshot: models-only root", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_snap_" });
  try {
    const src = join(tmp, "models-only");
    await Deno.mkdir(join(src, "extensions", "models"), { recursive: true });
    const { resolved: result } = await resolveSourceExtensionDirs([{
      path: src,
    }]);
    assertEquals(snapshotResolved(result, tmp), [
      {
        sourcePath: "/models-only",
        modelsDir: "/models-only/extensions/models",
      },
    ]);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("resolveSourceExtensionDirs snapshot: workflows-only root", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_snap_" });
  try {
    const src = join(tmp, "wf");
    await Deno.mkdir(join(src, "extensions", "workflows"), { recursive: true });
    const { resolved: result } = await resolveSourceExtensionDirs([{
      path: src,
    }]);
    assertEquals(snapshotResolved(result, tmp), [
      {
        sourcePath: "/wf",
        workflowsDir: "/wf/extensions/workflows",
      },
    ]);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("resolveSourceExtensionDirs snapshot: marker overrides modelsDir", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_snap_" });
  try {
    const src = join(tmp, "overridden");
    await Deno.mkdir(join(src, "custom", "models"), { recursive: true });
    await Deno.writeTextFile(
      join(src, ".swamp.yaml"),
      'swampVersion: "1.0.0"\ninitializedAt: "2026-01-01"\nmodelsDir: custom/models\n',
    );
    const { resolved: result } = await resolveSourceExtensionDirs([{
      path: src,
    }]);
    assertEquals(snapshotResolved(result, tmp), [
      {
        sourcePath: "/overridden",
        modelsDir: "/overridden/custom/models",
      },
    ]);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("resolveSourceExtensionDirs snapshot: non-existent path yields empty", async () => {
  const { resolved: result } = await resolveSourceExtensionDirs([
    { path: "/definitely/does/not/exist/v139" },
  ]);
  assertEquals(result.length, 1);
  assertPathEquals(result[0].sourcePath, "/definitely/does/not/exist/v139");
  assertEquals(result[0].modelsDir, undefined);
  assertEquals(result[0].vaultsDir, undefined);
  assertEquals(result[0].datastoresDir, undefined);
  assertEquals(result[0].reportsDir, undefined);
  assertEquals(result[0].workflowsDir, undefined);
});

Deno.test("resolveSourceExtensionDirs snapshot: only filter narrows kinds", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_snap_" });
  try {
    const src = join(tmp, "filtered");
    await Deno.mkdir(join(src, "extensions", "models"), { recursive: true });
    await Deno.mkdir(join(src, "extensions", "vaults"), { recursive: true });
    const { resolved: result } = await resolveSourceExtensionDirs([
      { path: src, only: ["vaults"] },
    ]);
    assertEquals(snapshotResolved(result, tmp), [
      {
        sourcePath: "/filtered",
        vaultsDir: "/filtered/extensions/vaults",
      },
    ]);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("resolveSourceExtensionDirs snapshot: non-standard layout via content pre-scan", async () => {
  // The reporter's scenario (issue #139): user passes an
  // `extensions/models/` dir itself as the source path. Pre-fix this
  // silently resolved to zero kinds; post-fix the content pre-scan sees
  // the `export const model` declaration in the .ts file and treats the
  // source path itself as the models dir.
  const tmp = await Deno.makeTempDir({ prefix: "swamp_snap_" });
  try {
    const src = join(tmp, "sister", "extensions", "models");
    await Deno.mkdir(src, { recursive: true });
    await Deno.writeTextFile(
      join(src, "m.ts"),
      'export const model = { type: "@r/m" };',
    );
    const { resolved: result } = await resolveSourceExtensionDirs([{
      path: src,
    }]);
    assertEquals(result.length, 1);
    assertEquals(result[0].sourcePath, src);
    // Post-fix: pre-scan detects the model export and sets modelsDir to
    // the source path itself (the loader will walk it and filter).
    assertEquals(result[0].modelsDir, src);
    assertEquals(result[0].vaultsDir, undefined);
    assertEquals(result[0].workflowsDir, undefined);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("resolveSourceExtensionDirs: large YAML file is skipped during pre-scan (no OOM)", async () => {
  // Guards the content pre-scan from OOM on source dirs that happen to
  // hold large YAML data fixtures. Legitimate workflow YAML is small;
  // anything over the 64 KiB cap is skipped without being read into
  // memory or parsed.
  const tmp = await Deno.makeTempDir({ prefix: "swamp_yaml_cap_" });
  try {
    const src = join(tmp, "pipeline");
    await Deno.mkdir(src, { recursive: true });
    // Build a 128 KiB YAML that WOULD parse as a workflow (has top-level
    // jobs:) but should be skipped by the size guard.
    const padding = "x: ".repeat(30_000);
    await Deno.writeTextFile(
      join(src, "big-fixture.yaml"),
      `${padding}\njobs:\n  one:\n    steps: []\n`,
    );
    const { resolved: result } = await resolveSourceExtensionDirs([{
      path: src,
    }]);
    // Because the large YAML was skipped, the source contributes no
    // kinds — no workflow detected.
    assertEquals(result[0].workflowsDir, undefined);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("resolveSourceExtensionDirs: detects export beyond 64 KiB in large .ts file", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_large_ts_" });
  try {
    const src = join(tmp, "big-report");
    await Deno.mkdir(src, { recursive: true });
    const padding = "// pad\n".repeat(12_000);
    await Deno.writeTextFile(
      join(src, "report.ts"),
      `${padding}export const report = { name: "@test/big", description: "x", scope: "workflow" as const, execute: async () => ({ markdown: "ok", json: {} }) };\n`,
    );
    const stat = await Deno.stat(join(src, "report.ts"));
    if (stat.size <= 65536) {
      throw new Error(
        `Test file must exceed 64 KiB to exercise the fix (got ${stat.size})`,
      );
    }
    const { resolved: result } = await resolveSourceExtensionDirs([{
      path: src,
    }]);
    assertEquals(result.length, 1);
    assertPathEquals(result[0].reportsDir!, src);
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

// -----------------------------------------------------------------
// Parity test: resolveExtensionKindsForSource must agree with
// resolveSourceExtensionDirs about which kinds a source contributes.
// Drift between the two would split add-time validation from load-time
// resolution — users would see add succeed then loads find nothing, or
// vice versa. The pair below runs both functions against the same set
// of fixtures and asserts equivalence.
// -----------------------------------------------------------------

const KIND_FIELDS: Array<
  [
    ExtensionKind,
    keyof import("../../domain/repo/swamp_sources.ts").ResolvedSourceDirs,
  ]
> = [
  ["models", "modelsDir"],
  ["vaults", "vaultsDir"],
  ["datastores", "datastoresDir"],
  ["reports", "reportsDir"],
  ["workflows", "workflowsDir"],
];

function kindsFromResolved(
  r: import("../../domain/repo/swamp_sources.ts").ResolvedSourceDirs,
): ExtensionKind[] {
  const out: ExtensionKind[] = [];
  for (const [kind, field] of KIND_FIELDS) {
    if (r[field] !== undefined) out.push(kind);
  }
  return out;
}

Deno.test("parity: resolveExtensionKindsForSource matches resolveSourceExtensionDirs for standard layout", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_parity_" });
  try {
    const src = join(tmp, "all");
    for (
      const kind of [
        "models",
        "vaults",
        "datastores",
        "reports",
        "workflows",
      ]
    ) {
      await Deno.mkdir(join(src, "extensions", kind), { recursive: true });
    }
    const fromDirs = kindsFromResolved(
      (await resolveSourceExtensionDirs([{ path: src }])).resolved[0],
    );
    const fromHelper = await resolveExtensionKindsForSource(
      { path: src },
      tmp,
    );
    assertEquals(fromHelper.sort(), fromDirs.sort());
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("parity: non-standard (content pre-scan) layout", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_parity_" });
  try {
    const src = join(tmp, "loose");
    await Deno.mkdir(src, { recursive: true });
    await Deno.writeTextFile(
      join(src, "m.ts"),
      'export const model = { type: "@r/m" };',
    );
    await Deno.writeTextFile(
      join(src, "v.ts"),
      'export const vault = { type: "@r/v" };',
    );
    const fromDirs = kindsFromResolved(
      (await resolveSourceExtensionDirs([{ path: src }])).resolved[0],
    );
    const fromHelper = await resolveExtensionKindsForSource(
      { path: src },
      tmp,
    );
    assertEquals(fromHelper.sort(), fromDirs.sort());
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("parity: marker-override layout", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_parity_" });
  try {
    const src = join(tmp, "mk");
    await Deno.mkdir(join(src, "custom", "models"), { recursive: true });
    await Deno.writeTextFile(
      join(src, ".swamp.yaml"),
      'swampVersion: "1.0.0"\ninitializedAt: "2026-01-01"\nmodelsDir: custom/models\n',
    );
    const fromDirs = kindsFromResolved(
      (await resolveSourceExtensionDirs([{ path: src }])).resolved[0],
    );
    const fromHelper = await resolveExtensionKindsForSource(
      { path: src },
      tmp,
    );
    assertEquals(fromHelper.sort(), fromDirs.sort());
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("parity: --only filter respected identically", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_parity_" });
  try {
    const src = join(tmp, "filt");
    await Deno.mkdir(join(src, "extensions", "models"), { recursive: true });
    await Deno.mkdir(join(src, "extensions", "vaults"), { recursive: true });
    const fromDirs = kindsFromResolved(
      (await resolveSourceExtensionDirs([{ path: src, only: ["vaults"] }]))
        .resolved[0],
    );
    const fromHelper = await resolveExtensionKindsForSource(
      { path: src, only: ["vaults"] },
      tmp,
    );
    assertEquals(fromHelper.sort(), fromDirs.sort());
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("parity: non-existent path returns empty from both", async () => {
  const fromDirs = kindsFromResolved(
    (await resolveSourceExtensionDirs([
      { path: "/definitely/not/there/v139/parity" },
    ])).resolved[0],
  );
  const fromHelper = await resolveExtensionKindsForSource(
    { path: "/definitely/not/there/v139/parity" },
    "/tmp",
  );
  assertEquals(fromHelper, []);
  assertEquals(fromDirs, []);
});

Deno.test("parity: resolveExtensionKindsForSource returns kinds in EXTENSION_KINDS order", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_parity_" });
  try {
    const src = join(tmp, "order");
    // Create in reverse declaration order to ensure the returned list
    // is sorted by EXTENSION_KINDS, not by discovery order.
    for (
      const kind of [
        "workflows",
        "reports",
        "datastores",
        "vaults",
        "models",
      ]
    ) {
      await Deno.mkdir(join(src, "extensions", kind), { recursive: true });
    }
    const kinds = await resolveExtensionKindsForSource({ path: src }, tmp);
    assertEquals(kinds, [
      "models",
      "vaults",
      "datastores",
      "reports",
      "workflows",
    ]);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("resolveSourceExtensionDirs: standard layout wins over loose root files", async () => {
  // Mixed layout precedence: when a source has BOTH
  // extensions/<kind>/ subdirs AND loose extension files at the root,
  // standard layout takes precedence and the loose files are ignored
  // (prevents double-loading in transitional repos).
  const tmp = await Deno.makeTempDir({ prefix: "swamp_mixed_" });
  try {
    const src = join(tmp, "mixed");
    await Deno.mkdir(join(src, "extensions", "models"), { recursive: true });
    await Deno.writeTextFile(
      join(src, "extensions", "models", "m.ts"),
      'export const model = { type: "@r/m" };',
    );
    await Deno.writeTextFile(
      join(src, "loose.ts"),
      'export const model = { type: "@r/loose" };',
    );
    const { resolved: result } = await resolveSourceExtensionDirs([{
      path: src,
    }]);
    assertEquals(result.length, 1);
    assertEquals(result[0].modelsDir, join(src, "extensions", "models"));
    // Loose root file NOT surfaced — standard layout precedence.
    assertEquals(result[0].sourcePath, src);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("flattenSourceKindDirs: lists each source's kind dirs in source order", () => {
  assertEquals(
    flattenSourceKindDirs([
      { sourcePath: "/b", vaultsDir: "/b/v", modelsDir: "/b/m" },
      { sourcePath: "/missing" },
      { sourcePath: "/a", modelsDir: "/a/m", workflowsDir: "/a/w" },
      { sourcePath: "/b-again", modelsDir: "/b/m" },
    ]),
    ["/b/m", "/b/v", "/a/m", "/a/w"],
  );
});

Deno.test("resolveMountedSourceDirs: returns no dirs without a sources file", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_sources_test_" });
  try {
    const { result, calls } = await withMockedCommand(
      [],
      () => resolveMountedSourceDirs(tmpDir),
    );
    assertEquals(result, []);
    assertEquals(calls.length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("resolveMountedSourceDirs: resolves relative and absolute sources in order with the only filter", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_sources_test_" });
  try {
    const repoDir = join(tmpDir, "repo");
    const sibling = join(tmpDir, "sibling");
    const other = join(tmpDir, "other");
    await Deno.mkdir(repoDir, { recursive: true });
    for (const kind of ["models", "vaults"]) {
      await Deno.mkdir(join(sibling, "extensions", kind), { recursive: true });
      await Deno.mkdir(join(other, "extensions", kind), { recursive: true });
    }
    await writeSwampSources(repoDir, {
      sources: [
        { path: other, only: ["vaults"] },
        { path: "../sibling" },
      ],
    });

    // Not a git checkout: relative paths resolve against the repo dir.
    const { result } = await withMockedCommand(
      [{ code: 128, stdout: "" }],
      () => resolveMountedSourceDirs(repoDir),
    );
    assertEquals(result.length, 3);
    assertPathEquals(result[0], join(other, "extensions", "vaults"));
    assertPathEquals(result[1], join(sibling, "extensions", "models"));
    assertPathEquals(result[2], join(sibling, "extensions", "vaults"));
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("resolveMountedSourceDirs: rejects an invalid sources file", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_sources_test_" });
  try {
    await Deno.writeTextFile(
      join(tmpDir, ".swamp-sources.yaml"),
      "sources: not-a-list\n",
    );
    await assertRejects(() => resolveMountedSourceDirs(tmpDir));
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// --- extensions/behaviors/, the behavior spelling (swamp-club#3338) -------

Deno.test("resolveSourceExtensionDirs: a source's extensions/behaviors/ loads as models after its models dir", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_sources_test_" });
  try {
    const sourceDir = join(tmpDir, "spelled");
    await Deno.mkdir(join(sourceDir, "extensions", "models"), {
      recursive: true,
    });
    await Deno.mkdir(join(sourceDir, "extensions", "behaviors"), {
      recursive: true,
    });
    const { resolved } = await resolveSourceExtensionDirs([
      { path: sourceDir },
    ]);
    assertEquals(
      resolved[0].behaviorsDir,
      join(sourceDir, "extensions", "behaviors"),
    );
    assertEquals(collectDirsForKind(resolved, "models"), [
      join(sourceDir, "extensions", "models"),
      join(sourceDir, "extensions", "behaviors"),
    ]);
    assertEquals(flattenSourceKindDirs(resolved), [
      join(sourceDir, "extensions", "models"),
      join(sourceDir, "extensions", "behaviors"),
    ]);
    assertEquals(
      await resolveExtensionKindsForSource({ path: sourceDir }, tmpDir),
      ["models"],
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("resolveSourceExtensionDirs: a source with only extensions/behaviors/ keeps the content pre-scan and still finds its behaviors", async () => {
  // Layout detection is unchanged, so a source that already had an
  // extensions/behaviors/ folder resolves as before (content pre-scan of the
  // whole source); the pre-scan now recognises export const behavior.
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_sources_test_" });
  try {
    const sourceDir = join(tmpDir, "behaviors-only");
    await Deno.mkdir(join(sourceDir, "extensions", "behaviors"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(sourceDir, "extensions", "behaviors", "echo.ts"),
      'export const behavior = { type: "@acme/echo", version: "2026.01.01.1", methods: {} };\n',
    );
    const { resolved } = await resolveSourceExtensionDirs([
      { path: sourceDir },
    ]);
    assertEquals(resolved[0].behaviorsDir, undefined);
    assertEquals(collectDirsForKind(resolved, "models"), [sourceDir]);
    assertEquals(
      await resolveExtensionKindsForSource({ path: sourceDir }, tmpDir),
      ["models"],
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("resolveSourceExtensionDirs: a source whose marker sets modelsDir to the default keeps its behaviors dir", async () => {
  // Same rule as the repo itself: only a modelsDir that moves the models dir
  // turns the behaviors dir off.
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_sources_test_" });
  try {
    const sourceDir = join(tmpDir, "explicit-default");
    await Deno.mkdir(join(sourceDir, "extensions", "models"), {
      recursive: true,
    });
    await Deno.mkdir(join(sourceDir, "extensions", "behaviors"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(sourceDir, ".swamp.yaml"),
      'swampVersion: "1.0.0"\ninitializedAt: "2026-01-01"\nmodelsDir: extensions/models\n',
    );
    const { resolved } = await resolveSourceExtensionDirs([{
      path: sourceDir,
    }]);
    assertEquals(
      resolved[0].behaviorsDir,
      join(sourceDir, "extensions", "behaviors"),
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("resolveSourceExtensionDirs: no behaviors dir once the source's marker moves its models dir, or models is filtered out", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_sources_test_" });
  try {
    const sourceDir = join(tmpDir, "configured");
    await Deno.mkdir(join(sourceDir, "custom", "models"), { recursive: true });
    await Deno.mkdir(join(sourceDir, "extensions", "behaviors"), {
      recursive: true,
    });
    await Deno.mkdir(join(sourceDir, "extensions", "vaults"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(sourceDir, ".swamp.yaml"),
      'swampVersion: "1.0.0"\ninitializedAt: "2026-01-01"\nmodelsDir: custom/models\n',
    );
    const configured = await resolveSourceExtensionDirs([{ path: sourceDir }]);
    assertEquals(configured.resolved[0].behaviorsDir, undefined);
    await Deno.remove(join(sourceDir, ".swamp.yaml"));
    const filtered = await resolveSourceExtensionDirs([
      { path: sourceDir, only: ["vaults"] },
    ]);
    assertEquals(filtered.resolved[0].behaviorsDir, undefined);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// The pre-scan's helper and skip-dir exclusions apply only below the source
// root. GitHub ARC runners check out under /actions-runner/_work/, so a
// check against the absolute path found nothing (swamp-club#3780).
async function writeModel(dir: string, file = "m.ts"): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    join(dir, file),
    'export const model = { type: "@r/m" };',
  );
}

Deno.test("resolveExtensionKindsForSource: a source under an underscore-prefixed ancestor is scanned", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_sources_test_" });
  try {
    const src = join(
      tmp,
      "actions-runner",
      "_work",
      "repo",
      "repo",
      "extensions",
      "models",
    );
    await writeModel(src);
    assertEquals(
      await resolveExtensionKindsForSource({ path: src }, tmp),
      ["models"],
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("resolveExtensionKindsForSource: a source under an ancestor named like a skipped dir is scanned", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_sources_test_" });
  try {
    for (
      const name of [
        "node_modules",
        ".git",
        ".swamp",
        "dist",
        "build",
        "target",
      ]
    ) {
      const src = join(tmp, name, "sister", "extensions", "models");
      await writeModel(src);
      assertEquals(
        await resolveExtensionKindsForSource({ path: src }, tmp),
        ["models"],
        `source under ${name}/`,
      );
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("resolveExtensionKindsForSource: a source whose own folder is named like a skipped or helper dir is scanned", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_sources_test_" });
  try {
    for (const name of ["build", "_shared"]) {
      const src = join(tmp, name);
      await writeModel(src);
      assertEquals(
        await resolveExtensionKindsForSource({ path: src }, tmp),
        ["models"],
        `source named ${name}`,
      );
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("resolveExtensionKindsForSource: helper and skipped dirs below the source are still excluded", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_sources_test_" });
  try {
    const cases: Array<[string, string]> = [
      ["lib-dir", join("_lib", "m.ts")],
      ["helper-file", "_m.ts"],
      ["node-modules", join("node_modules", "pkg", "m.ts")],
      ["build-dir", join("build", "m.ts")],
      ["git-dir", join(".git", "m.ts")],
    ];
    for (const [name, file] of cases) {
      const src = join(tmp, "_work", name);
      await writeModel(join(src, dirname(file)), basename(file));
      assertEquals(
        await resolveExtensionKindsForSource({ path: src }, tmp),
        [],
        `model only at ${file}`,
      );
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("resolveSourceExtensionDirs: a source under an underscore-prefixed ancestor loads its models", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_sources_test_" });
  try {
    const src = join(tmp, "_work", "sister", "extensions", "models");
    await writeModel(src);
    const { resolved } = await resolveSourceExtensionDirs([{ path: src }]);
    assertEquals(collectDirsForKind(resolved, "models"), [src]);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
