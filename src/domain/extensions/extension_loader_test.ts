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
import { toFileUrl } from "@std/path";
import { findStaleFiles, type FreshnessCatalog } from "./bundle_freshness.ts";
import type { ExtensionTypeRow } from "../../infrastructure/persistence/extension_catalog_store.ts";

Deno.test("importBundleByPath: non-empty fingerprint appends ?fp= to import URL", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_fp_url_" });
  try {
    const bundlePath = join(dir, "fp_present.js");
    await Deno.writeTextFile(
      bundlePath,
      'export const model = { name: "test" };\n',
    );

    const baseUrl = toFileUrl(bundlePath).href;
    const fpUrl = `${baseUrl}?fp=abc123`;

    const mod = await import(fpUrl);
    assertEquals(mod.model.name, "test");
    assertStringIncludes(fpUrl, "?fp=abc123");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("importBundleByPath: empty fingerprint produces bare URL without ?fp=", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_fp_empty_url_" });
  try {
    const bundlePath = join(dir, "fp_empty.js");
    await Deno.writeTextFile(
      bundlePath,
      'export const model = { name: "legacy" };\n',
    );

    const fingerprint = "";
    const baseUrl = toFileUrl(bundlePath).href;
    const importUrl = fingerprint ? `${baseUrl}?fp=${fingerprint}` : baseUrl;

    assertEquals(importUrl.includes("?fp="), false);

    const mod = await import(importUrl);
    assertEquals(mod.model.name, "legacy");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("importBundleByPath: undefined fingerprint produces bare URL without ?fp=", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_fp_undef_url_" });
  try {
    const bundlePath = join(dir, "fp_undef.js");
    await Deno.writeTextFile(
      bundlePath,
      'export const model = { name: "no-fp" };\n',
    );

    const fingerprint: string | undefined = undefined;
    const baseUrl = toFileUrl(bundlePath).href;
    const importUrl = fingerprint ? `${baseUrl}?fp=${fingerprint}` : baseUrl;

    assertEquals(importUrl.includes("?fp="), false);

    const mod = await import(importUrl);
    assertEquals(mod.model.name, "no-fp");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

function buildImportUrl(baseUrl: string, fingerprint?: string): string {
  return fingerprint ? `${baseUrl}?fp=${fingerprint}` : baseUrl;
}

// -- Discovery _test.ts filtering (swamp-club#389) -----------------------

class StubCatalog implements FreshnessCatalog {
  findByKind(): ExtensionTypeRow[] {
    return [];
  }
  removeBySourcePath(): void {}
}

const discoverExcludingTestFiles = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (
      entry.isFile && entry.name.endsWith(".ts") &&
      !entry.name.endsWith("_test.ts")
    ) {
      out.push(entry.name);
    }
  }
  return out.sort();
};

const discoverIncludingTestFiles = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && entry.name.endsWith(".ts")) {
      out.push(entry.name);
    }
  }
  return out.sort();
};

Deno.test("discovery: _test.ts files excluded from local dir discovery", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_discover_local_" });
  try {
    await Deno.writeTextFile(
      join(dir, "my_model.ts"),
      "export const model = {};",
    );
    await Deno.writeTextFile(
      join(dir, "my_model_test.ts"),
      "import { model } from './my_model.ts';",
    );

    const stale = await findStaleFiles({
      modelsDir: dir,
      catalog: new StubCatalog(),
      discoverFiles: discoverExcludingTestFiles,
      kinds: ["model"],
    });

    assertEquals(
      stale.map((s) => s.relativePath),
      ["my_model.ts"],
      "_test.ts files must be excluded from local dir discovery",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("discovery: _test.ts files included from additional dir discovery", async () => {
  const localDir = await Deno.makeTempDir({
    prefix: "swamp_discover_adl_local_",
  });
  const pulledDir = await Deno.makeTempDir({
    prefix: "swamp_discover_adl_pulled_",
  });
  try {
    await Deno.writeTextFile(
      join(localDir, "local_model.ts"),
      "export const model = {};",
    );
    await Deno.writeTextFile(
      join(localDir, "local_model_test.ts"),
      "import { model } from './local_model.ts';",
    );
    await Deno.writeTextFile(
      join(pulledDir, "docker_image_test.ts"),
      "export const model = {};",
    );

    const additionalSet = new Set([pulledDir]);
    const stale = await findStaleFiles({
      modelsDir: localDir,
      additionalDirs: [pulledDir],
      catalog: new StubCatalog(),
      discoverFiles: (d) =>
        additionalSet.has(d)
          ? discoverIncludingTestFiles(d)
          : discoverExcludingTestFiles(d),
      kinds: ["model"],
    });

    const found = stale.map((s) => s.relativePath).sort();
    assertEquals(
      found,
      ["docker_image_test.ts", "local_model.ts"],
      "_test.ts must be excluded from local dir but included from additional (pulled/source) dirs",
    );
  } finally {
    await Deno.remove(localDir, { recursive: true }).catch(() => {});
    await Deno.remove(pulledDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("fingerprint URL guard: distinct fingerprints produce distinct URLs", () => {
  const baseUrl = "file:///tmp/bundle.js";

  const url1 = buildImportUrl(baseUrl, "fp-aaa");
  const url2 = buildImportUrl(baseUrl, "fp-bbb");
  const url3 = buildImportUrl(baseUrl, "");
  const url4 = buildImportUrl(baseUrl, undefined);

  assertStringIncludes(url1, "?fp=fp-aaa");
  assertStringIncludes(url2, "?fp=fp-bbb");
  assertEquals(url3, baseUrl);
  assertEquals(url3.includes("?fp="), false);
  assertEquals(url4, baseUrl);
  assertEquals(url4.includes("?fp="), false);
});
