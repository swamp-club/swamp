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
import { stringify as stringifyYaml } from "@std/yaml";
import type { ExtensionKind } from "../repo/swamp_sources.ts";
import { discoverManifestCrossKindDirs } from "./manifest_cross_kind_discovery.ts";

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({
    prefix: "swamp-manifest-cross-kind-test-",
  });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

async function writeManifest(
  dir: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    join(dir, "manifest.yaml"),
    stringifyYaml(manifest),
  );
}

Deno.test("discoverManifestCrossKindDirs: no manifests returns empty map", async () => {
  await withTempDir(async (dir) => {
    const modelsDir = join(dir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });

    const kindDirs = new Map<ExtensionKind, string[]>([
      ["models", [modelsDir]],
    ]);

    const result = await discoverManifestCrossKindDirs(kindDirs);
    assertEquals(result.size, 0);
  });
});

Deno.test("discoverManifestCrossKindDirs: manifest with paths.base:typedDir is ignored", async () => {
  await withTempDir(async (dir) => {
    const modelsDir = join(dir, "models");
    const extDir = join(modelsDir, "myext");
    await writeManifest(extDir, {
      manifestVersion: 1,
      name: "@test/myext",
      version: "2026.01.01.1",
      paths: { base: "typedDir" },
      models: ["model.ts"],
      reports: ["report.ts"],
    });

    const kindDirs = new Map<ExtensionKind, string[]>([
      ["models", [modelsDir]],
    ]);

    const result = await discoverManifestCrossKindDirs(kindDirs);
    assertEquals(result.size, 0);
  });
});

Deno.test("discoverManifestCrossKindDirs: manifest without paths field is ignored", async () => {
  await withTempDir(async (dir) => {
    const modelsDir = join(dir, "models");
    const extDir = join(modelsDir, "myext");
    await writeManifest(extDir, {
      manifestVersion: 1,
      name: "@test/myext",
      version: "2026.01.01.1",
      models: ["model.ts"],
      reports: ["report.ts"],
    });

    const kindDirs = new Map<ExtensionKind, string[]>([
      ["models", [modelsDir]],
    ]);

    const result = await discoverManifestCrossKindDirs(kindDirs);
    assertEquals(result.size, 0);
  });
});

Deno.test("discoverManifestCrossKindDirs: paths.base:manifest with reports adds dir", async () => {
  await withTempDir(async (dir) => {
    const modelsDir = join(dir, "models");
    const extDir = join(modelsDir, "myext");
    await writeManifest(extDir, {
      manifestVersion: 1,
      name: "@test/myext",
      version: "2026.01.01.1",
      paths: { base: "manifest" },
      models: ["model.ts"],
      reports: ["report.ts"],
    });

    const kindDirs = new Map<ExtensionKind, string[]>([
      ["models", [modelsDir]],
    ]);

    const result = await discoverManifestCrossKindDirs(kindDirs);
    assertEquals(result.get("reports"), [extDir]);
    assertEquals(result.has("models"), false);
  });
});

Deno.test("discoverManifestCrossKindDirs: multiple cross-kinds from one manifest", async () => {
  await withTempDir(async (dir) => {
    const modelsDir = join(dir, "models");
    const extDir = join(modelsDir, "myext");
    await writeManifest(extDir, {
      manifestVersion: 1,
      name: "@test/myext",
      version: "2026.01.01.1",
      paths: { base: "manifest" },
      models: ["model.ts"],
      reports: ["report.ts"],
      vaults: ["vault.ts"],
    });

    const kindDirs = new Map<ExtensionKind, string[]>([
      ["models", [modelsDir]],
    ]);

    const result = await discoverManifestCrossKindDirs(kindDirs);
    assertEquals(result.get("reports"), [extDir]);
    assertEquals(result.get("vaults"), [extDir]);
    assertEquals(result.has("models"), false);
  });
});

Deno.test("discoverManifestCrossKindDirs: dir already in kindDirs is excluded", async () => {
  await withTempDir(async (dir) => {
    const modelsDir = join(dir, "models");
    const extDir = join(modelsDir, "myext");
    await writeManifest(extDir, {
      manifestVersion: 1,
      name: "@test/myext",
      version: "2026.01.01.1",
      paths: { base: "manifest" },
      models: ["model.ts"],
      reports: ["report.ts"],
    });

    const kindDirs = new Map<ExtensionKind, string[]>([
      ["models", [modelsDir]],
      ["reports", [extDir]],
    ]);

    const result = await discoverManifestCrossKindDirs(kindDirs);
    assertEquals(result.has("reports"), false);
  });
});

Deno.test("discoverManifestCrossKindDirs: invalid manifest is skipped gracefully", async () => {
  await withTempDir(async (dir) => {
    const modelsDir = join(dir, "models");
    const extDir = join(modelsDir, "myext");
    await Deno.mkdir(extDir, { recursive: true });
    await Deno.writeTextFile(
      join(extDir, "manifest.yaml"),
      "this is not valid yaml: [",
    );

    const kindDirs = new Map<ExtensionKind, string[]>([
      ["models", [modelsDir]],
    ]);

    const result = await discoverManifestCrossKindDirs(kindDirs);
    assertEquals(result.size, 0);
  });
});

Deno.test("discoverManifestCrossKindDirs: manifest with wrong version is ignored", async () => {
  await withTempDir(async (dir) => {
    const modelsDir = join(dir, "models");
    const extDir = join(modelsDir, "myext");
    await writeManifest(extDir, {
      manifestVersion: 99,
      name: "@test/myext",
      version: "2026.01.01.1",
      paths: { base: "manifest" },
      models: ["model.ts"],
      reports: ["report.ts"],
    });

    const kindDirs = new Map<ExtensionKind, string[]>([
      ["models", [modelsDir]],
    ]);

    const result = await discoverManifestCrossKindDirs(kindDirs);
    assertEquals(result.size, 0);
  });
});

Deno.test("discoverManifestCrossKindDirs: nonexistent directory is skipped", async () => {
  const kindDirs = new Map<ExtensionKind, string[]>([
    ["models", ["/tmp/nonexistent-swamp-test-dir-" + crypto.randomUUID()]],
  ]);

  const result = await discoverManifestCrossKindDirs(kindDirs);
  assertEquals(result.size, 0);
});

Deno.test("discoverManifestCrossKindDirs: empty kind arrays in manifest are ignored", async () => {
  await withTempDir(async (dir) => {
    const modelsDir = join(dir, "models");
    const extDir = join(modelsDir, "myext");
    await writeManifest(extDir, {
      manifestVersion: 1,
      name: "@test/myext",
      version: "2026.01.01.1",
      paths: { base: "manifest" },
      models: ["model.ts"],
      reports: [],
    });

    const kindDirs = new Map<ExtensionKind, string[]>([
      ["models", [modelsDir]],
    ]);

    const result = await discoverManifestCrossKindDirs(kindDirs);
    assertEquals(result.size, 0);
  });
});

Deno.test("discoverManifestCrossKindDirs: multiple manifests across dirs", async () => {
  await withTempDir(async (dir) => {
    const modelsDir = join(dir, "models");
    const ext1 = join(modelsDir, "ext1");
    const ext2 = join(modelsDir, "ext2");

    await writeManifest(ext1, {
      manifestVersion: 1,
      name: "@test/ext1",
      version: "2026.01.01.1",
      paths: { base: "manifest" },
      models: ["model.ts"],
      reports: ["report.ts"],
    });

    await writeManifest(ext2, {
      manifestVersion: 1,
      name: "@test/ext2",
      version: "2026.01.01.1",
      paths: { base: "manifest" },
      models: ["model.ts"],
      drivers: ["driver.ts"],
    });

    const kindDirs = new Map<ExtensionKind, string[]>([
      ["models", [modelsDir]],
    ]);

    const result = await discoverManifestCrossKindDirs(kindDirs);
    assertEquals(result.get("reports"), [ext1]);
    assertEquals(result.get("drivers"), [ext2]);
  });
});
