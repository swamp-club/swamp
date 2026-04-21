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
  resolveExtensionKindsForSource,
  resolveSourceExtensionDirs,
  writeSwampSources,
} from "./swamp_sources_repository.ts";
import type { ExtensionKind } from "../../domain/repo/swamp_sources.ts";

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
    return v.startsWith(base) ? v.slice(base.length) : v;
  };
  return results.map((r) => {
    const out: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
      out[k] = rel(v);
    }
    return out;
  });
}

Deno.test("resolveSourceExtensionDirs snapshot: all six kinds present", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_snap_" });
  try {
    const src = join(tmp, "all");
    for (
      const kind of [
        "models",
        "vaults",
        "drivers",
        "datastores",
        "reports",
        "workflows",
      ]
    ) {
      await Deno.mkdir(join(src, "extensions", kind), { recursive: true });
    }
    const result = await resolveSourceExtensionDirs([{ path: src }]);
    assertEquals(snapshotResolved(result, tmp), [
      {
        sourcePath: "/all",
        modelsDir: "/all/extensions/models",
        vaultsDir: "/all/extensions/vaults",
        driversDir: "/all/extensions/drivers",
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
    const result = await resolveSourceExtensionDirs([{ path: src }]);
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
    const result = await resolveSourceExtensionDirs([{ path: src }]);
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
    const result = await resolveSourceExtensionDirs([{ path: src }]);
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
  const result = await resolveSourceExtensionDirs([
    { path: "/definitely/does/not/exist/v139" },
  ]);
  assertEquals(result.length, 1);
  assertEquals(result[0].sourcePath, "/definitely/does/not/exist/v139");
  assertEquals(result[0].modelsDir, undefined);
  assertEquals(result[0].vaultsDir, undefined);
  assertEquals(result[0].driversDir, undefined);
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
    const result = await resolveSourceExtensionDirs([
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
    const result = await resolveSourceExtensionDirs([{ path: src }]);
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
    const result = await resolveSourceExtensionDirs([{ path: src }]);
    // Because the large YAML was skipped, the source contributes no
    // kinds — no workflow detected.
    assertEquals(result[0].workflowsDir, undefined);
  } finally {
    await Deno.remove(tmp, { recursive: true });
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
  ["drivers", "driversDir"],
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
        "drivers",
        "datastores",
        "reports",
        "workflows",
      ]
    ) {
      await Deno.mkdir(join(src, "extensions", kind), { recursive: true });
    }
    const fromDirs = kindsFromResolved(
      (await resolveSourceExtensionDirs([{ path: src }]))[0],
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
      (await resolveSourceExtensionDirs([{ path: src }]))[0],
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
      (await resolveSourceExtensionDirs([{ path: src }]))[0],
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
      (await resolveSourceExtensionDirs([{ path: src, only: ["vaults"] }]))[0],
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
    ]))[0],
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
        "drivers",
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
      "drivers",
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
    const result = await resolveSourceExtensionDirs([{ path: src }]);
    assertEquals(result.length, 1);
    assertEquals(result[0].modelsDir, join(src, "extensions", "models"));
    // Loose root file NOT surfaced — standard layout precedence.
    assertEquals(result[0].sourcePath, src);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
