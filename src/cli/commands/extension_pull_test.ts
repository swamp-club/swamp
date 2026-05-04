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
import {
  detectConflicts,
  LockfileRepository,
  parseExtensionRef,
} from "./extension_pull.ts";
import type { UpstreamExtensionEntry } from "../../infrastructure/persistence/upstream_extensions.ts";
import { UserError } from "../../domain/errors.ts";
import { join } from "@std/path";

Deno.test("parseExtensionRef parses name without version", () => {
  const ref = parseExtensionRef("@myorg/my-ext");
  assertEquals(ref.name, "@myorg/my-ext");
  assertEquals(ref.version, null);
});

Deno.test("parseExtensionRef parses name with version", () => {
  const ref = parseExtensionRef("@myorg/my-ext@2026.02.26.1");
  assertEquals(ref.name, "@myorg/my-ext");
  assertEquals(ref.version, "2026.02.26.1");
});

Deno.test("parseExtensionRef throws on name without @ prefix", () => {
  const error = assertThrows(
    () => parseExtensionRef("invalid-name"),
    UserError,
  );
  assertStringIncludes(error.message, "must start with");
});

Deno.test("parseExtensionRef throws on empty version after @", () => {
  const error = assertThrows(
    () => parseExtensionRef("@myorg/my-ext@"),
    UserError,
  );
  assertStringIncludes(error.message, "Version cannot be empty");
});

Deno.test("LockfileRepository.writeEntry persists files array", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    const files = [
      "extensions/models/foo/bar.yaml",
      "extensions/models/foo/baz.ts",
    ];
    const repo = await LockfileRepository.create(lockfilePath);
    await repo.writeEntry("@test/ext", "1.0.0", files);

    const content = await Deno.readTextFile(lockfilePath);
    const data = JSON.parse(content) as Record<string, UpstreamExtensionEntry>;

    assertEquals(data["@test/ext"].version, "1.0.0");
    assertEquals(data["@test/ext"].files, files);
    assertEquals(typeof data["@test/ext"].pulledAt, "string");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("LockfileRepository.writeEntry preserves existing entries", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    const repoFirst = await LockfileRepository.create(lockfilePath);
    await repoFirst.writeEntry("@test/first", "1.0.0", ["a.yaml"]);
    // Sibling instance simulates a second process; re-reads disk under
    // lock so the merged write picks up the prior entry.
    const repoSecond = await LockfileRepository.create(lockfilePath);
    await repoSecond.writeEntry("@test/second", "2.0.0", ["b.yaml"]);

    const content = await Deno.readTextFile(lockfilePath);
    const data = JSON.parse(content) as Record<string, UpstreamExtensionEntry>;

    assertEquals(data["@test/first"].version, "1.0.0");
    assertEquals(data["@test/first"].files, ["a.yaml"]);
    assertEquals(data["@test/second"].version, "2.0.0");
    assertEquals(data["@test/second"].files, ["b.yaml"]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("LockfileRepository.writeEntry handles empty files array", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    const repo = await LockfileRepository.create(lockfilePath);
    await repo.writeEntry("@test/empty", "1.0.0", []);

    const content = await Deno.readTextFile(lockfilePath);
    const data = JSON.parse(content) as Record<string, UpstreamExtensionEntry>;

    assertEquals(data["@test/empty"].files, []);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("detectConflicts uses nested path for bundles, not basename", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    // Set up extract dir with a nested bundle: bundles/k8s/netpol.js
    const extractDir = join(tmpDir, "extract");
    const bundleSubdir = join(extractDir, "bundles", "k8s");
    await Deno.mkdir(bundleSubdir, { recursive: true });
    await Deno.writeTextFile(join(bundleSubdir, "netpol.js"), "// bundle");

    // Set up the repo with the same nested bundle already installed
    const repoDir = join(tmpDir, "repo");
    const bundlesDir = join(repoDir, ".swamp", "bundles");
    const nestedBundleDir = join(bundlesDir, "k8s");
    await Deno.mkdir(nestedBundleDir, { recursive: true });
    await Deno.writeTextFile(join(nestedBundleDir, "netpol.js"), "// existing");

    // Also create empty dirs for models and workflows
    const modelsDir = join(repoDir, "extensions", "models");
    const workflowsDir = join(repoDir, "workflows");
    await Deno.mkdir(modelsDir, { recursive: true });
    await Deno.mkdir(workflowsDir, { recursive: true });

    const conflicts = await detectConflicts(
      extractDir,
      modelsDir,
      workflowsDir,
      bundlesDir,
      repoDir,
    );

    // Should detect the conflict at the nested path, not the flat basename
    assertEquals(conflicts, [join(".swamp", "bundles", "k8s", "netpol.js")]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
