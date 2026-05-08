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

import { assertEquals, assertNotEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import { ExtensionLoader } from "../extensions/extension_loader.ts";
import { reportKindAdapter } from "../extensions/report_kind_adapter.ts";
import { reportRegistry } from "./report_registry.ts";
import { bundleNamespace } from "../../infrastructure/persistence/paths.ts";
import { ExtensionCatalogStore } from "../../infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import type { DenoRuntime } from "../runtime/deno_runtime.ts";

/** Test DenoRuntime that returns the current deno binary path. */
const testDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve(Deno.execPath()),
};

/** W1b/(a-2): construct an ExtensionRepository wrapping a test catalog. */
function makeRepoForCatalog(
  catalog: ExtensionCatalogStore,
  repoRoot: string,
): ExtensionRepository {
  return new ExtensionRepository({
    catalog,
    lockfileRepository: new LockfileRepository(
      "/test/repo/upstream_extensions.json",
      {},
    ),
    repoRoot,
  });
}

Deno.test("UserReportLoader buildIndex rebundles when source content changes with preserved mtime (#128)", async () => {
  // Mirrors the models-loader regression at user_model_loader_test.ts —
  // swap source content but restore the original mtime (the atomic-rename
  // / rsync --times / sub-ms edit signature), then re-run buildIndex and
  // verify the regenerated bundle carries the new content. With the old
  // mtime-based freshness check the stale bundle would be served.
  const ts = Date.now();
  const name = `@user/preserved-mtime-report-${ts}`;
  const v1 = `
export const report = {
  name: "${name}",
  description: "V1_MARKER",
  scope: "method",
  execute: async (_ctx) => ({ markdown: "V1_MARKER", json: { marker: "V1" } }),
};
`;
  const v2 = `
export const report = {
  name: "${name}",
  description: "V2_MARKER",
  scope: "method",
  execute: async (_ctx) => ({ markdown: "V2_MARKER", json: { marker: "V2" } }),
};
`;

  const repoDir = await Deno.makeTempDir({
    prefix: "swamp_preserved_mtime_report_repo_",
  });
  const reportsDir = await Deno.makeTempDir({
    prefix: "swamp_preserved_mtime_reports_",
  });
  const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");

  try {
    const sourcePath = join(reportsDir, "report.ts");
    await Deno.writeTextFile(sourcePath, v1);

    const catalog1 = new ExtensionCatalogStore(dbPath);

    const repository1 = makeRepoForCatalog(catalog1, repoDir);
    const loader1 = new ExtensionLoader(
      testDenoRuntime,
      reportKindAdapter,
      repoDir,
      undefined,
      repository1,
    );
    await loader1.buildIndex(reportsDir);
    catalog1.close();

    const ns = bundleNamespace(reportsDir, repoDir);
    const bundlePath = join(
      repoDir,
      ".swamp",
      "report-bundles",
      ns,
      "report.js",
    );
    const v1Bundle = await Deno.readTextFile(bundlePath);
    assertEquals(
      v1Bundle.includes("V1_MARKER"),
      true,
      "V1 marker should be present in the initial bundle",
    );

    const origMtime = (await Deno.stat(sourcePath)).mtime!;

    // Advance wall clock so any mtime-based comparison would notice a
    // rebundle moment, making the test deterministic.
    await new Promise((r) => setTimeout(r, 1100));

    // Swap content, then restore the original mtime — the #125 trigger.
    await Deno.writeTextFile(sourcePath, v2);
    await Deno.utime(sourcePath, origMtime, origMtime);

    const srcStatAfterRestore = await Deno.stat(sourcePath);
    const bundleStatBeforeRun2 = await Deno.stat(bundlePath);
    assertEquals(
      srcStatAfterRestore.mtime!.getTime() <=
        bundleStatBeforeRun2.mtime!.getTime(),
      true,
      "Precondition — source mtime must be <= bundle mtime to exercise the bug",
    );

    // Drop the registry entry so the second buildIndex fully re-imports.
    const catalog2 = new ExtensionCatalogStore(dbPath);
    const repository2 = makeRepoForCatalog(catalog2, repoDir);
    const loader2 = new ExtensionLoader(
      testDenoRuntime,
      reportKindAdapter,
      repoDir,
      undefined,
      repository2,
    );
    await loader2.buildIndex(reportsDir);
    catalog2.close();

    const v2Bundle = await Deno.readTextFile(bundlePath);
    assertNotEquals(
      v1Bundle,
      v2Bundle,
      "Bundle must be regenerated when source content changes, even with preserved mtime",
    );
    assertEquals(
      v2Bundle.includes("V2_MARKER"),
      true,
      "V2 marker must be present in the regenerated bundle",
    );
  } finally {
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(reportsDir, { recursive: true });
  }
});

Deno.test("UserReportLoader buildIndex rebundles when transitive dep content changes with preserved mtime (#128)", async () => {
  // Transitive-dep variant — edit a _lib/*.ts helper, preserve the entry
  // point's mtime, verify the fingerprint helper walks the dep graph and
  // marks the entry point stale.
  const ts = Date.now();
  const name = `@user/preserved-mtime-report-dep-${ts}`;
  const entry = `
import { marker } from "./_lib/marker.ts";

export const report = {
  name: "${name}",
  description: "dep-transitive",
  scope: "method",
  execute: async (_ctx) => ({ markdown: marker(), json: { marker: marker() } }),
};
`;
  const libV1 = `export const marker = () => "V1_DEP_MARKER";\n`;
  const libV2 = `export const marker = () => "V2_DEP_MARKER";\n`;

  const repoDir = await Deno.makeTempDir({
    prefix: "swamp_preserved_mtime_report_dep_repo_",
  });
  const reportsDir = await Deno.makeTempDir({
    prefix: "swamp_preserved_mtime_report_dep_src_",
  });
  const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");

  try {
    await Deno.mkdir(join(reportsDir, "_lib"), { recursive: true });
    const entryPath = join(reportsDir, "report.ts");
    const libPath = join(reportsDir, "_lib", "marker.ts");
    await Deno.writeTextFile(entryPath, entry);
    await Deno.writeTextFile(libPath, libV1);

    const catalog1 = new ExtensionCatalogStore(dbPath);

    const repository1 = makeRepoForCatalog(catalog1, repoDir);
    const loader1 = new ExtensionLoader(
      testDenoRuntime,
      reportKindAdapter,
      repoDir,
      undefined,
      repository1,
    );
    await loader1.buildIndex(reportsDir);
    catalog1.close();

    const ns = bundleNamespace(reportsDir, repoDir);
    const bundlePath = join(
      repoDir,
      ".swamp",
      "report-bundles",
      ns,
      "report.js",
    );
    const v1Bundle = await Deno.readTextFile(bundlePath);
    assertEquals(v1Bundle.includes("V1_DEP_MARKER"), true);

    // Capture both the entry and dep mtimes, edit the dep content, restore
    // both mtimes so nothing on disk suggests a change except the bytes.
    const entryMtime = (await Deno.stat(entryPath)).mtime!;
    const libMtime = (await Deno.stat(libPath)).mtime!;

    await new Promise((r) => setTimeout(r, 1100));

    await Deno.writeTextFile(libPath, libV2);
    await Deno.utime(libPath, libMtime, libMtime);
    await Deno.utime(entryPath, entryMtime, entryMtime);

    const catalog2 = new ExtensionCatalogStore(dbPath);

    const repository2 = makeRepoForCatalog(catalog2, repoDir);
    const loader2 = new ExtensionLoader(
      testDenoRuntime,
      reportKindAdapter,
      repoDir,
      undefined,
      repository2,
    );
    await loader2.buildIndex(reportsDir);
    catalog2.close();

    const v2Bundle = await Deno.readTextFile(bundlePath);
    assertNotEquals(
      v1Bundle,
      v2Bundle,
      "Bundle must be regenerated when a transitive dep changes, even with preserved mtimes",
    );
    assertEquals(
      v2Bundle.includes("V2_DEP_MARKER"),
      true,
      "V2 dep marker must be present in the regenerated bundle",
    );
  } finally {
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(reportsDir, { recursive: true });
  }
});

Deno.test("UserReportLoader: registerLazyFromCatalog skips validation_failed rows (swamp-club#209)", async () => {
  const repoDir = await Deno.makeTempDir({
    prefix: "swamp_issue209_report_repo_",
  });
  const reportsDir = await Deno.makeTempDir({
    prefix: "swamp_issue209_report_dir_",
  });
  const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");

  try {
    const ts = Date.now();
    const reportName = `issue209-report-${ts}`;
    const validReport = `
export const report = {
  name: "${reportName}",
  description: "Healthy report",
  scope: "model",
  execute: async (_ctx) => {
    return { rows: [] };
  },
};
`;
    await Deno.writeTextFile(join(reportsDir, "valid.ts"), validReport);

    const catalog = new ExtensionCatalogStore(dbPath);

    const repository = makeRepoForCatalog(catalog, repoDir);
    const loader = new ExtensionLoader(
      testDenoRuntime,
      reportKindAdapter,
      repoDir,
      undefined,
      repository,
    );
    await loader.buildIndex(reportsDir);

    catalog.upsert({
      source_path: join(reportsDir, "broken.ts"),
      type_normalized: "",
      kind: "report",
      bundle_path: join(repoDir, ".swamp", "report-bundles", "broken.js"),
      version: "",
      description: "",
      extends_type: "",
      source_mtime: "2026-05-01T12:00:00.000Z",
      source_fingerprint: "deadbeef-broken",
      // W1b: validation_failed dropped — state="ValidationFailed" is the signal.
    });

    const loader2 = new ExtensionLoader(
      testDenoRuntime,
      reportKindAdapter,
      repoDir,
      undefined,
      repository,
    );
    await loader2.buildIndex(reportsDir);

    assertEquals(reportRegistry.has(reportName), true);
    assertEquals(reportRegistry.has(""), false);
    catalog.close();
  } finally {
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(reportsDir, { recursive: true });
  }
});

// ===== Pin 1 (W2) =====

Deno.test(
  "UserReportLoader.bundleAndIndexOne: returns report metadata without writing catalog rows (Pin 1)",
  async () => {
    const ts = Date.now();
    const reportName = `@user/pin1-report-${ts}`;
    const reportCode = `
export const report = {
  name: "${reportName}",
  description: "pin1",
  scope: "method",
  execute: async (_ctx) => ({ markdown: "ok", json: {} }),
};
`;

    const repoDir = await Deno.makeTempDir({ prefix: "swamp_pin1_report_r_" });
    const reportsDir = await Deno.makeTempDir({
      prefix: "swamp_pin1_report_d_",
    });
    const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");
    await Deno.mkdir(dirname(dbPath), { recursive: true });

    try {
      await Deno.writeTextFile(join(reportsDir, "report.ts"), reportCode);

      const catalog = new ExtensionCatalogStore(dbPath);
      const repository = makeRepoForCatalog(catalog, repoDir);
      const loader = new ExtensionLoader(
        testDenoRuntime,
        reportKindAdapter,
        repoDir,
        undefined,
        repository,
      );

      const before = catalog.findAll().length;
      assertEquals(before, 0);

      const result = await loader.bundleAndIndexOne({
        absolutePath: join(reportsDir, "report.ts"),
        relativePath: "report.ts",
        baseDir: reportsDir,
      });

      assertEquals(
        catalog.findAll().length,
        before,
        "Pin 1: bundleAndIndexOne must NOT write catalog rows",
      );
      assertNotEquals(result, null);
      assertEquals(result?.kind, "report");
      assertEquals(result?.typeNormalized, reportName.toLowerCase());

      catalog.close();
    } finally {
      await Deno.remove(repoDir, { recursive: true });
      await Deno.remove(reportsDir, { recursive: true });
    }
  },
);
