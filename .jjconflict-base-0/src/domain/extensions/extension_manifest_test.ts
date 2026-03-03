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
import { parseExtensionManifest } from "./extension_manifest.ts";

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

Deno.test("parseExtensionManifest rejects reserved namespace @swamp", () => {
  const yaml = `
manifestVersion: 1
name: "@swamp/myext"
version: "2026.02.26.1"
models:
  - foo.ts
`;
  const error = assertThrows(() => parseExtensionManifest(yaml));
  assertStringIncludes(
    (error as Error).message,
    "reserved namespace",
  );
});

Deno.test("parseExtensionManifest rejects reserved namespace @si", () => {
  const yaml = `
manifestVersion: 1
name: "@si/myext"
version: "2026.02.26.1"
models:
  - foo.ts
`;
  const error = assertThrows(() => parseExtensionManifest(yaml));
  assertStringIncludes(
    (error as Error).message,
    "reserved namespace",
  );
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

Deno.test("parseExtensionManifest rejects no models, workflows, or vaults", () => {
  const yaml = `
manifestVersion: 1
name: "@myuser/myext"
version: "2026.02.26.1"
`;
  const error = assertThrows(() => parseExtensionManifest(yaml));
  assertStringIncludes(
    (error as Error).message,
    "at least one model, workflow, or vault",
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
  assertEquals(manifest.workflows, []);
  assertEquals(manifest.vaults, []);
  assertEquals(manifest.additionalFiles, []);
  assertEquals(manifest.platforms, []);
  assertEquals(manifest.labels, []);
  assertEquals(manifest.dependencies, []);
});
