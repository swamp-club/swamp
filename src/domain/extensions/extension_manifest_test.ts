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
  isSafeRelativePath,
  parseExtensionManifest,
} from "./extension_manifest.ts";

Deno.test("parseExtensionManifest parses valid manifest with models", () => {
  const yaml = `
manifestVersion: 1
name: "@myuser/myext"
version: "2026.02.26.1"
description: "My extension"
models:
  - deploy_model.ts
dependencies:
  - "@other/dep"
`;
  const manifest = parseExtensionManifest(yaml);
  assertEquals(manifest.manifestVersion, 1);
  assertEquals(manifest.name, "@myuser/myext");
  assertEquals(manifest.version, "2026.02.26.1");
  assertEquals(manifest.description, "My extension");
  assertEquals(manifest.models, ["deploy_model.ts"]);
  assertEquals(manifest.workflows, []);
  assertEquals(manifest.additionalFiles, []);
  assertEquals(manifest.dependencies, ["@other/dep"]);
});

Deno.test("parseExtensionManifest parses valid manifest with workflows", () => {
  const yaml = `
manifestVersion: 1
name: "@myuser/myext"
version: "2026.02.26.1"
workflows:
  - deploy.yaml
`;
  const manifest = parseExtensionManifest(yaml);
  assertEquals(manifest.workflows, ["deploy.yaml"]);
  assertEquals(manifest.models, []);
});

Deno.test("parseExtensionManifest parses valid manifest with additionalFiles", () => {
  const yaml = `
manifestVersion: 1
name: "@myuser/myext"
version: "2026.02.26.1"
models:
  - foo.ts
additionalFiles:
  - README.md
`;
  const manifest = parseExtensionManifest(yaml);
  assertEquals(manifest.additionalFiles, ["README.md"]);
});

Deno.test("parseExtensionManifest rejects missing manifestVersion", () => {
  const yaml = `
name: "@myuser/myext"
version: "2026.02.26.1"
models:
  - foo.ts
`;
  const error = assertThrows(() => parseExtensionManifest(yaml));
  assertStringIncludes(
    (error as Error).message,
    "missing 'manifestVersion'",
  );
});

Deno.test("parseExtensionManifest rejects unsupported manifestVersion", () => {
  const yaml = `
manifestVersion: 99
name: "@myuser/myext"
version: "2026.02.26.1"
models:
  - foo.ts
`;
  const error = assertThrows(() => parseExtensionManifest(yaml));
  assertStringIncludes(
    (error as Error).message,
    "Unsupported manifest version: 99",
  );
});

Deno.test("parseExtensionManifest rejects unscoped name", () => {
  const yaml = `
manifestVersion: 1
name: "myext"
version: "2026.02.26.1"
models:
  - foo.ts
`;
  const error = assertThrows(() => parseExtensionManifest(yaml));
  assertStringIncludes(
    (error as Error).message,
    "must be scoped",
  );
});

Deno.test("parseExtensionManifest accepts reserved collective @swamp", () => {
  const yaml = `
manifestVersion: 1
name: "@swamp/myext"
version: "2026.02.26.1"
models:
  - foo.ts
`;
  const manifest = parseExtensionManifest(yaml);
  assertEquals(manifest.name, "@swamp/myext");
});

Deno.test("parseExtensionManifest accepts reserved collective @si", () => {
  const yaml = `
manifestVersion: 1
name: "@si/myext"
version: "2026.02.26.1"
models:
  - foo.ts
`;
  const manifest = parseExtensionManifest(yaml);
  assertEquals(manifest.name, "@si/myext");
});

Deno.test("parseExtensionManifest accepts multi-segment name", () => {
  const yaml = `
manifestVersion: 1
name: "@swamp/aws/ec2"
version: "2026.02.26.1"
models:
  - foo.ts
`;
  const manifest = parseExtensionManifest(yaml);
  assertEquals(manifest.name, "@swamp/aws/ec2");
});

Deno.test("parseExtensionManifest accepts deeply nested multi-segment name", () => {
  const yaml = `
manifestVersion: 1
name: "@swamp/aws/accessanalyzer/analyzer"
version: "2026.02.26.1"
models:
  - foo.ts
`;
  const manifest = parseExtensionManifest(yaml);
  assertEquals(manifest.name, "@swamp/aws/accessanalyzer/analyzer");
});

Deno.test("parseExtensionManifest rejects invalid CalVer version", () => {
  const yaml = `
manifestVersion: 1
name: "@myuser/myext"
version: "1.0.0"
models:
  - foo.ts
`;
  const error = assertThrows(() => parseExtensionManifest(yaml));
  assertStringIncludes(
    (error as Error).message,
    "CalVer",
  );
});

Deno.test("parseExtensionManifest parses valid manifest with vaults", () => {
  const yaml = `
manifestVersion: 1
name: "@myuser/myext"
version: "2026.02.26.1"
vaults:
  - custom_vault.ts
`;
  const manifest = parseExtensionManifest(yaml);
  assertEquals(manifest.vaults, ["custom_vault.ts"]);
  assertEquals(manifest.models, []);
  assertEquals(manifest.workflows, []);
});

Deno.test("parseExtensionManifest rejects no models, workflows, vaults, drivers, datastores, or skills", () => {
  const yaml = `
manifestVersion: 1
name: "@myuser/myext"
version: "2026.02.26.1"
`;
  const error = assertThrows(() => parseExtensionManifest(yaml));
  assertStringIncludes(
    (error as Error).message,
    "at least one model, workflow, vault, driver, datastore, report, or skill",
  );
});

Deno.test("parseExtensionManifest rejects dependencies without slash", () => {
  const yaml = `
manifestVersion: 1
name: "@myuser/myext"
version: "2026.02.26.1"
models:
  - foo.ts
dependencies:
  - "nodep"
`;
  const error = assertThrows(() => parseExtensionManifest(yaml));
  assertStringIncludes(
    (error as Error).message,
    "must include a slash",
  );
});

Deno.test("parseExtensionManifest rejects non-object YAML", () => {
  const yaml = `"just a string"`;
  const error = assertThrows(() => parseExtensionManifest(yaml));
  assertStringIncludes(
    (error as Error).message,
    "must be a YAML object",
  );
});

Deno.test("parseExtensionManifest parses valid manifest with platforms", () => {
  const yaml = `
manifestVersion: 1
name: "@myuser/myext"
version: "2026.02.26.1"
models:
  - foo.ts
platforms:
  - darwin-aarch64
  - linux-x86_64
`;
  const manifest = parseExtensionManifest(yaml);
  assertEquals(manifest.platforms, ["darwin-aarch64", "linux-x86_64"]);
});

Deno.test("parseExtensionManifest parses valid manifest with labels", () => {
  const yaml = `
manifestVersion: 1
name: "@myuser/myext"
version: "2026.02.26.1"
models:
  - foo.ts
labels:
  - aws
  - kubernetes
  - security
`;
  const manifest = parseExtensionManifest(yaml);
  assertEquals(manifest.labels, ["aws", "kubernetes", "security"]);
});

Deno.test("parseExtensionManifest parses valid manifest with repository", () => {
  const yaml = `
manifestVersion: 1
name: "@myuser/myext"
version: "2026.02.26.1"
description: "My extension"
repository: "https://github.com/myuser/swamp-myext"
models:
  - foo.ts
`;
  const manifest = parseExtensionManifest(yaml);
  assertEquals(
    manifest.repository,
    "https://github.com/myuser/swamp-myext",
  );
});

Deno.test("parseExtensionManifest rejects invalid repository URL", () => {
  const yaml = `
manifestVersion: 1
name: "@myuser/myext"
version: "2026.02.26.1"
repository: "not-a-url"
models:
  - foo.ts
`;
  const error = assertThrows(() => parseExtensionManifest(yaml));
  assertStringIncludes((error as Error).message, "Invalid");
});

Deno.test("parseExtensionManifest parses valid manifest with releaseNotes", () => {
  const yaml = `
manifestVersion: 1
name: "@myuser/myext"
version: "2026.02.26.1"
models:
  - foo.ts
releaseNotes: "Fixed a critical bug in the deploy step"
`;
  const manifest = parseExtensionManifest(yaml);
  assertEquals(
    manifest.releaseNotes,
    "Fixed a critical bug in the deploy step",
  );
});

Deno.test("parseExtensionManifest defaults optional fields", () => {
  const yaml = `
manifestVersion: 1
name: "@myuser/myext"
version: "2026.02.26.1"
models:
  - foo.ts
`;
  const manifest = parseExtensionManifest(yaml);
  assertEquals(manifest.description, undefined);
  assertEquals(manifest.repository, undefined);
  assertEquals(manifest.releaseNotes, undefined);
  assertEquals(manifest.workflows, []);
  assertEquals(manifest.vaults, []);
  assertEquals(manifest.additionalFiles, []);
  assertEquals(manifest.platforms, []);
  assertEquals(manifest.labels, []);
  assertEquals(manifest.dependencies, []);
});

// --- isSafeRelativePath unit tests ---

Deno.test("isSafeRelativePath: accepts simple filename", () => {
  assertEquals(isSafeRelativePath("foo.ts"), true);
});

Deno.test("isSafeRelativePath: accepts nested relative path", () => {
  assertEquals(isSafeRelativePath("aws/ec2/instance.ts"), true);
});

Deno.test("isSafeRelativePath: rejects path with .. component", () => {
  assertEquals(isSafeRelativePath("../foo.ts"), false);
});

Deno.test("isSafeRelativePath: rejects path with multiple .. components", () => {
  assertEquals(isSafeRelativePath("../../workflows/foo.yaml"), false);
});

Deno.test("isSafeRelativePath: rejects path with .. in middle", () => {
  assertEquals(isSafeRelativePath("foo/../bar.ts"), false);
});

Deno.test("isSafeRelativePath: rejects absolute path", () => {
  assertEquals(isSafeRelativePath("/etc/passwd"), false);
});

Deno.test("isSafeRelativePath: rejects backslash path traversal", () => {
  assertEquals(isSafeRelativePath("..\\foo.ts"), false);
});

// --- Manifest-level path traversal rejection tests ---

Deno.test("parseExtensionManifest rejects path traversal in models", () => {
  const yaml = `
manifestVersion: 1
name: "@myuser/myext"
version: "2026.02.26.1"
models:
  - ../../other/model.ts
`;
  const error = assertThrows(() => parseExtensionManifest(yaml));
  assertStringIncludes((error as Error).message, "must not contain '..'");
});

Deno.test("parseExtensionManifest rejects path traversal in workflows", () => {
  const yaml = `
manifestVersion: 1
name: "@myuser/myext"
version: "2026.02.26.1"
workflows:
  - ../../workflows/deploy.yaml
`;
  const error = assertThrows(() => parseExtensionManifest(yaml));
  assertStringIncludes((error as Error).message, "must not contain '..'");
});

Deno.test("parseExtensionManifest rejects absolute path in models", () => {
  const yaml = `
manifestVersion: 1
name: "@myuser/myext"
version: "2026.02.26.1"
models:
  - /etc/passwd
`;
  const error = assertThrows(() => parseExtensionManifest(yaml));
  assertStringIncludes((error as Error).message, "must not contain '..'");
});

Deno.test("parseExtensionManifest rejects path traversal in additionalFiles", () => {
  const yaml = `
manifestVersion: 1
name: "@myuser/myext"
version: "2026.02.26.1"
models:
  - foo.ts
additionalFiles:
  - ../../../secrets.txt
`;
  const error = assertThrows(() => parseExtensionManifest(yaml));
  assertStringIncludes((error as Error).message, "must not contain '..'");
});

Deno.test("parseExtensionManifest rejects path traversal in include", () => {
  const yaml = `
manifestVersion: 1
name: "@myuser/myext"
version: "2026.02.26.1"
models:
  - foo.ts
include:
  - ../helpers.ts
`;
  const error = assertThrows(() => parseExtensionManifest(yaml));
  assertStringIncludes((error as Error).message, "must not contain '..'");
});

Deno.test("parseExtensionManifest accepts valid nested paths in models", () => {
  const yaml = `
manifestVersion: 1
name: "@myuser/myext"
version: "2026.02.26.1"
models:
  - aws/ec2/instance.ts
  - deploy_model.ts
`;
  const manifest = parseExtensionManifest(yaml);
  assertEquals(manifest.models, ["aws/ec2/instance.ts", "deploy_model.ts"]);
});

Deno.test("parseExtensionManifest defaults paths.base to typedDir", () => {
  const yaml = `
manifestVersion: 1
name: "@myuser/myext"
version: "2026.02.26.1"
models:
  - foo.ts
`;
  const manifest = parseExtensionManifest(yaml);
  assertEquals(manifest.paths.base, "typedDir");
});

Deno.test("parseExtensionManifest accepts paths.base = manifest", () => {
  const yaml = `
manifestVersion: 1
name: "@myuser/myext"
version: "2026.02.26.1"
paths:
  base: manifest
models:
  - foo.ts
`;
  const manifest = parseExtensionManifest(yaml);
  assertEquals(manifest.paths.base, "manifest");
});

Deno.test("parseExtensionManifest accepts paths.base = typedDir explicitly", () => {
  const yaml = `
manifestVersion: 1
name: "@myuser/myext"
version: "2026.02.26.1"
paths:
  base: typedDir
models:
  - foo.ts
`;
  const manifest = parseExtensionManifest(yaml);
  assertEquals(manifest.paths.base, "typedDir");
});

Deno.test("parseExtensionManifest rejects unknown paths.base value", () => {
  const yaml = `
manifestVersion: 1
name: "@myuser/myext"
version: "2026.02.26.1"
paths:
  base: manifestDir
models:
  - foo.ts
`;
  const error = assertThrows(() => parseExtensionManifest(yaml));
  assertStringIncludes((error as Error).message, "paths.base");
});

Deno.test("parseExtensionManifest rejects unknown key inside paths", () => {
  const yaml = `
manifestVersion: 1
name: "@myuser/myext"
version: "2026.02.26.1"
paths:
  base: manifest
  extra: nope
models:
  - foo.ts
`;
  const error = assertThrows(() => parseExtensionManifest(yaml));
  assertStringIncludes((error as Error).message, "paths");
});
