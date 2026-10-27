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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  bundleDependencyWarnings,
  checkBundleRecord,
  describeBundleErrors,
  scanExtractedBundles,
} from "./bundle_safety_scan.ts";
import type { BundleDependencyIssue } from "../../domain/extensions/extension_safety_analyzer.ts";
import { BUNDLE_FORMAT_VERSION } from "../../domain/models/bundle.ts";

function dependencyIssue(
  dependency: string,
  file: string,
): BundleDependencyIssue {
  return {
    dependency,
    issue: { ruleId: "dynamic-code", file, line: 1, message: "m" },
  };
}

Deno.test("bundleDependencyWarnings: one warning per dependency, naming its bundles", () => {
  assertEquals(
    bundleDependencyWarnings([
      dependencyIssue("npm:a/1.0.0/i.js", "bundles/x.js"),
      dependencyIssue("npm:b/2.0.0/i.js", "bundles/x.js"),
      dependencyIssue("npm:a/1.0.0/i.js", "bundles/y.js"),
      dependencyIssue("npm:a/1.0.0/i.js", "bundles/y.js"),
    ]),
    [
      {
        file: "npm:a/1.0.0/i.js",
        message: "Dependency code uses eval() or new Function(), in 2 " +
          "bundles. Findings in dependency code are reported, not refused.",
      },
      {
        file: "npm:b/2.0.0/i.js",
        message: "Dependency code uses eval() or new Function(), in " +
          "bundles/x.js. Findings in dependency code are reported, not refused.",
      },
    ],
  );
});

Deno.test("bundleDependencyWarnings: leaves out a dependency already reported", () => {
  assertEquals(
    bundleDependencyWarnings(
      [dependencyIssue("npm:a/1.0.0/i.js", "bundle rebuilt from models/m.ts")],
      new Set(["npm:a/1.0.0/i.js"]),
    ),
    [],
  );
});

Deno.test("describeBundleErrors: one line per error, with its line when it has one", () => {
  assertEquals(
    describeBundleErrors([
      { ruleId: "dynamic-code", file: "bundles/x.js", line: 3, message: "m1" },
      { ruleId: "dynamic-code", file: "bundles/y.js", message: "m2" },
    ]),
    "  bundles/x.js line 3: m1\n  bundles/y.js: m2",
  );
});

function record(
  bundles: Record<string, string>,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    recordVersion: 2,
    bundleFormat: BUNDLE_FORMAT_VERSION,
    bundles,
    dependencies: [],
    unaudited: [],
    ...extra,
  });
}

const HASHES = new Map([
  ["bundles/a.js", "sha256:aa"],
  ["vault-bundles/sub/v.js", "sha256:bb"],
]);

Deno.test("checkBundleRecord: an archive with no record keeps its bundles", () => {
  assertEquals(checkBundleRecord(HASHES, undefined), {
    keepArchiveBundles: true,
    refusals: [],
  });
});

Deno.test("checkBundleRecord: a v1 record carries no hashes, so its bundles are kept", () => {
  assertEquals(
    checkBundleRecord(
      HASHES,
      JSON.stringify({ recordVersion: 1, dependencies: [] }),
    ),
    { keepArchiveBundles: true, refusals: [] },
  );
});

Deno.test("checkBundleRecord: a v2 record listing every bundle at its hash keeps them, nested paths included", () => {
  assertEquals(
    checkBundleRecord(HASHES, record(Object.fromEntries(HASHES))),
    { keepArchiveBundles: true, refusals: [] },
  );
});

Deno.test("checkBundleRecord: a record without bundleFormat reads as format 1", () => {
  assertEquals(
    checkBundleRecord(
      HASHES,
      record(Object.fromEntries(HASHES), { bundleFormat: undefined }),
    ).keepArchiveBundles,
    BUNDLE_FORMAT_VERSION === 1,
  );
});

Deno.test("checkBundleRecord: another bundle format is rebuilt, still checked against its hashes", () => {
  assertEquals(
    checkBundleRecord(
      HASHES,
      record(Object.fromEntries(HASHES), {
        bundleFormat: BUNDLE_FORMAT_VERSION + 1,
      }),
    ),
    { keepArchiveBundles: false, refusals: [] },
  );
  assertEquals(
    checkBundleRecord(
      HASHES,
      record({ "bundles/a.js": "sha256:aa" }, {
        bundleFormat: BUNDLE_FORMAT_VERSION + 1,
      }),
    ).refusals,
    ["vault-bundles/sub/v.js: not listed in dependency-audit.json"],
  );
});

Deno.test("checkBundleRecord: refuses a changed hash, an unlisted bundle and a listed one that is missing, in path order", () => {
  assertEquals(
    checkBundleRecord(
      HASHES,
      record({
        "bundles/a.js": "sha256:00",
        "bundles/gone.js": "sha256:cc",
        "../escape.js": "sha256:dd",
      }),
    ).refusals,
    [
      "bundles/a.js: does not match the SHA-256 dependency-audit.json records for it",
      "vault-bundles/sub/v.js: not listed in dependency-audit.json",
      "../escape.js: listed in dependency-audit.json but not in the archive",
      "bundles/gone.js: listed in dependency-audit.json but not in the archive",
    ],
  );
});

Deno.test("checkBundleRecord: escapes control characters in a path it prints", () => {
  assertEquals(
    checkBundleRecord(new Map(), record({ "bundles/\x1b[31m.js": "x" }))
      .refusals,
    ["bundles/\\x1b[31m.js: listed in dependency-audit.json but not in the archive"],
  );
});

Deno.test("checkBundleRecord: a record that is neither v1 nor v2 is refused", () => {
  for (const text of ["not json", "[]", record({}, { bundleFormat: 0 })]) {
    assertEquals(checkBundleRecord(HASHES, text), {
      keepArchiveBundles: false,
      refusals: [
        "dependency-audit.json: not a dependency audit record this swamp can read",
      ],
    });
  }
});

Deno.test("scanExtractedBundles: hashes the bytes it scans, keyed by forward-slash archive path", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-bundle-scan-" });
  try {
    await Deno.mkdir(join(dir, "bundles", "sub"), { recursive: true });
    await Deno.writeTextFile(join(dir, "bundles", "sub", "m.js"), "abc");
    const scan = await scanExtractedBundles(dir, async (d) => {
      const files: string[] = [];
      try {
        for await (const e of Deno.readDir(join(d, "sub"))) {
          files.push(join(d, "sub", e.name));
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      return files;
    });
    assertEquals([...scan.hashes], [[
      "bundles/sub/m.js",
      // SHA-256 of "abc".
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    ]]);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
});
