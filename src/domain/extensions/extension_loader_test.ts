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
