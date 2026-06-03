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

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { UserError } from "../errors.ts";
import {
  extractCollective,
  isSwampCollective,
  loadInstalledExtensionManifest,
  readInstalledExtensionVersion,
  validateExtensionName,
} from "./installed_extension_lookup.ts";

const VALID_MANIFEST = `manifestVersion: 1
name: "@adam/cfgmgmt"
version: "2026.04.22.1"
description: "Config management"
repository: "https://github.com/adam/cfgmgmt"
models:
  - foo.yaml
`;

Deno.test("loadInstalledExtensionManifest: returns null when extension is not pulled", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_iel_" });
  try {
    const result = await loadInstalledExtensionManifest(tmp, "@adam/cfgmgmt");
    assertEquals(result, null);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("loadInstalledExtensionManifest: reads manifest from <root>/<name>/manifest.yaml", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_iel_" });
  try {
    const extDir = join(tmp, "@adam", "cfgmgmt");
    await Deno.mkdir(extDir, { recursive: true });
    await Deno.writeTextFile(join(extDir, "manifest.yaml"), VALID_MANIFEST);

    const manifest = await loadInstalledExtensionManifest(
      tmp,
      "@adam/cfgmgmt",
    );
    assertEquals(manifest?.name, "@adam/cfgmgmt");
    assertEquals(manifest?.version, "2026.04.22.1");
    assertEquals(manifest?.repository, "https://github.com/adam/cfgmgmt");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("loadInstalledExtensionManifest: throws UserError for malformed name", async () => {
  await assertRejects(
    () => loadInstalledExtensionManifest("/tmp", "not-a-scoped-name"),
    UserError,
    "Invalid extension name",
  );
});

Deno.test("readInstalledExtensionVersion: returns version when entry exists", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_iel_" });
  try {
    const lockfilePath = join(tmp, "upstream_extensions.json");
    const data = {
      "@adam/cfgmgmt": {
        version: "2026.04.22.1",
        pulledAt: new Date().toISOString(),
      },
    };
    await Deno.writeTextFile(lockfilePath, JSON.stringify(data));

    const version = await readInstalledExtensionVersion(
      lockfilePath,
      "@adam/cfgmgmt",
    );
    assertEquals(version, "2026.04.22.1");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("readInstalledExtensionVersion: returns null when entry is absent", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_iel_" });
  try {
    const lockfilePath = join(tmp, "upstream_extensions.json");
    await Deno.writeTextFile(lockfilePath, "{}");

    const version = await readInstalledExtensionVersion(
      lockfilePath,
      "@adam/cfgmgmt",
    );
    assertEquals(version, null);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("readInstalledExtensionVersion: returns null when lockfile is missing", async () => {
  const version = await readInstalledExtensionVersion(
    "/nonexistent/upstream_extensions.json",
    "@adam/cfgmgmt",
  );
  assertEquals(version, null);
});

Deno.test("extractCollective: single-segment name", () => {
  assertEquals(extractCollective("@adam/cfgmgmt"), "adam");
});

Deno.test("extractCollective: multi-segment name takes the collective only", () => {
  assertEquals(extractCollective("@foo/bar/baz"), "foo");
});

Deno.test("extractCollective: throws UserError for malformed name", () => {
  assertThrows(
    () => extractCollective("not-a-scoped-name"),
    UserError,
    "Invalid extension name",
  );
});

Deno.test("isSwampCollective: true for @swamp/*", () => {
  assertEquals(isSwampCollective("@swamp/aws"), true);
  assertEquals(isSwampCollective("@swamp/aws/ec2"), true);
});

Deno.test("isSwampCollective: false for non-swamp collectives", () => {
  assertEquals(isSwampCollective("@adam/cfgmgmt"), false);
  assertEquals(isSwampCollective("@swampy/aws"), false);
});

Deno.test("validateExtensionName: accepts valid scoped names", () => {
  validateExtensionName("@adam/cfgmgmt");
  validateExtensionName("@foo/bar/baz");
  validateExtensionName("@swamp_team/my-ext");
});

Deno.test("validateExtensionName: rejects names without leading @", () => {
  assertThrows(
    () => validateExtensionName("adam/cfgmgmt"),
    UserError,
    "Invalid extension name",
  );
});

Deno.test("validateExtensionName: rejects names without slash", () => {
  assertThrows(
    () => validateExtensionName("@adam"),
    UserError,
    "Invalid extension name",
  );
});

Deno.test("validateExtensionName: rejects uppercase characters", () => {
  assertThrows(
    () => validateExtensionName("@Adam/cfgmgmt"),
    UserError,
    "Invalid extension name",
  );
});
