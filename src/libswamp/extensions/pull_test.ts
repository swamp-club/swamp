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

import { assertEquals, assertThrows } from "@std/assert";
import { assertStringIncludes } from "@std/assert/string-includes";
import { join } from "@std/path";
import {
  computeOrphanDiff,
  parseExtensionRef,
  updateUpstreamExtensions,
  validateExtensionName,
} from "./pull.ts";
import { UserError } from "../../domain/errors.ts";

Deno.test("parseExtensionRef: parses name without version", () => {
  const ref = parseExtensionRef("@myorg/my-ext");
  assertEquals(ref.name, "@myorg/my-ext");
  assertEquals(ref.version, null);
});

Deno.test("parseExtensionRef: parses name with version", () => {
  const ref = parseExtensionRef("@myorg/my-ext@2026.02.26.1");
  assertEquals(ref.name, "@myorg/my-ext");
  assertEquals(ref.version, "2026.02.26.1");
});

Deno.test("parseExtensionRef: throws on missing @ prefix", () => {
  assertThrows(
    () => parseExtensionRef("myorg/my-ext"),
    UserError,
    'must start with "@"',
  );
});

Deno.test("parseExtensionRef: throws on empty version", () => {
  assertThrows(
    () => parseExtensionRef("@myorg/my-ext@"),
    UserError,
    "Version cannot be empty",
  );
});

Deno.test("parseExtensionRef: parses nested segments", () => {
  const ref = parseExtensionRef("@myorg/my-ext/sub");
  assertEquals(ref.name, "@myorg/my-ext/sub");
  assertEquals(ref.version, null);
});

Deno.test("validateExtensionName: accepts valid names", () => {
  validateExtensionName("@myorg/my-ext");
  validateExtensionName("@my_org/my_ext");
  validateExtensionName("@myorg/my-ext/sub");
});

Deno.test("validateExtensionName: rejects invalid names", () => {
  assertThrows(
    () => validateExtensionName("myorg/my-ext"),
    UserError,
    "Must match",
  );
  assertThrows(
    () => validateExtensionName("@MyOrg/My-Ext"),
    UserError,
    "Must match",
  );
});

Deno.test("updateUpstreamExtensions: writes and updates entries", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    await updateUpstreamExtensions(lockfilePath, "@test/first", "1.0.0", [
      "a.yaml",
    ]);

    const content = await Deno.readTextFile(lockfilePath);
    const data = JSON.parse(content);
    assertEquals(data["@test/first"].version, "1.0.0");
    assertEquals(data["@test/first"].files, ["a.yaml"]);
    assertStringIncludes(data["@test/first"].pulledAt, "20");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("computeOrphanDiff: empty inputs yield empty diff", () => {
  assertEquals(computeOrphanDiff([], []), []);
  assertEquals(computeOrphanDiff(["a.ts"], []), ["a.ts"]);
  assertEquals(computeOrphanDiff([], ["a.ts"]), []);
});

Deno.test("computeOrphanDiff: identical sets yield no orphans", () => {
  const files = [
    ".swamp/pulled-extensions/@x/y/models/a.ts",
    ".swamp/bundles/abc/a.js",
  ];
  assertEquals(computeOrphanDiff(files, files), []);
});

Deno.test(
  "computeOrphanDiff: paths in old but NOT new are orphans",
  () => {
    // The canonical case from issue 202: v1 had two files, v2 declares
    // only one, so the dropped one is the orphan.
    const oldFiles = [
      ".swamp/pulled-extensions/@hivemq/harvester/kubeconfig/models/harvester/kubeconfig.ts",
      ".swamp/pulled-extensions/@hivemq/harvester/kubeconfig/models/harvester/fetch_kubeconfig.ts",
      ".swamp/bundles/738c72f8/harvester/kubeconfig.js",
      ".swamp/bundles/738c72f8/harvester/fetch_kubeconfig.js",
    ];
    const extractedFiles = [
      ".swamp/pulled-extensions/@hivemq/harvester/kubeconfig/models/harvester/kubeconfig.ts",
      ".swamp/bundles/738c72f8/harvester/kubeconfig.js",
    ];
    const orphans = computeOrphanDiff(oldFiles, extractedFiles);
    assertEquals(orphans.length, 2);
    assertEquals(
      orphans.includes(
        ".swamp/pulled-extensions/@hivemq/harvester/kubeconfig/models/harvester/fetch_kubeconfig.ts",
      ),
      true,
    );
    assertEquals(
      orphans.includes(".swamp/bundles/738c72f8/harvester/fetch_kubeconfig.js"),
      true,
    );
  },
);

Deno.test(
  "computeOrphanDiff: all files dropped — every old path is an orphan",
  () => {
    const oldFiles = ["a.ts", "b.ts", "c.ts"];
    const extractedFiles = ["x.ts"];
    assertEquals(computeOrphanDiff(oldFiles, extractedFiles), [
      "a.ts",
      "b.ts",
      "c.ts",
    ]);
  },
);

Deno.test(
  "computeOrphanDiff: order of returned orphans matches old-list order",
  () => {
    // Stability: if two callers compute the same diff, they get the
    // same list. Important for deterministic event output.
    const oldFiles = ["c.ts", "a.ts", "b.ts"];
    const extractedFiles = ["a.ts"];
    assertEquals(computeOrphanDiff(oldFiles, extractedFiles), ["c.ts", "b.ts"]);
  },
);
