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

import { assertStringIncludes } from "@std/assert/string-includes";
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { CLI_ARGS } from "./test_helpers.ts";

const PROJECT_ROOT = Deno.cwd();

async function runCli(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const command = new Deno.Command(Deno.execPath(), {
    args: [...CLI_ARGS, ...args],
    stdout: "piped",
    stderr: "piped",
    cwd: PROJECT_ROOT,
    env: {
      ...Deno.env.toObject(),
      SWAMP_NO_TELEMETRY: "1",
    },
  });

  const { code, stdout, stderr } = await command.output();
  return {
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    code,
  };
}

/** Initialize a swamp repo in a temp directory. */
async function initTempRepo(): Promise<string> {
  const tmpDir = await Deno.makeTempDir();
  await runCli(["init", tmpDir]);
  return tmpDir;
}

Deno.test("extension fmt auto-fixes formatting issues", async () => {
  const tmpDir = await initTempRepo();
  try {
    // Create model with formatting issues
    const modelsDir = join(tmpDir, "extensions", "models");
    await Deno.mkdir(modelsDir, { recursive: true });
    const modelPath = join(modelsDir, "model.ts");
    await Deno.writeTextFile(modelPath, "export const x=1;export const y=2;");

    const manifestPath = join(tmpDir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/myext",
        version: "2026.02.26.1",
        models: ["model.ts"],
      }),
    );

    const { code } = await runCli([
      "extension",
      "fmt",
      manifestPath,
      "--repo-dir",
      tmpDir,
      "--no-color",
    ]);
    assertEquals(code, 0);

    // Verify the file was fixed
    const fixed = await Deno.readTextFile(modelPath);
    assertStringIncludes(fixed, "export const x = 1;");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extension fmt auto-fixes lint issues", async () => {
  const tmpDir = await initTempRepo();
  try {
    // Create model with a lint-fixable issue (no-window → globalThis)
    const modelsDir = join(tmpDir, "extensions", "models");
    await Deno.mkdir(modelsDir, { recursive: true });
    const modelPath = join(modelsDir, "model.ts");
    await Deno.writeTextFile(
      modelPath,
      "export const x = window.location;\n",
    );

    const manifestPath = join(tmpDir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/myext",
        version: "2026.02.26.1",
        models: ["model.ts"],
      }),
    );

    const { code } = await runCli([
      "extension",
      "fmt",
      manifestPath,
      "--repo-dir",
      tmpDir,
      "--no-color",
    ]);
    assertEquals(code, 0);

    // Verify window was replaced with globalThis
    const fixed = await Deno.readTextFile(modelPath);
    assertEquals(fixed.includes("window."), false);
    assertStringIncludes(fixed, "globalThis.location");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extension fmt --check reports issues without fixing", async () => {
  const tmpDir = await initTempRepo();
  try {
    // Create model with formatting issues
    const modelsDir = join(tmpDir, "extensions", "models");
    await Deno.mkdir(modelsDir, { recursive: true });
    const modelPath = join(modelsDir, "model.ts");
    const badContent = "export const x=1;export const y=2;";
    await Deno.writeTextFile(modelPath, badContent);

    const manifestPath = join(tmpDir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/myext",
        version: "2026.02.26.1",
        models: ["model.ts"],
      }),
    );

    const { code, stderr } = await runCli([
      "extension",
      "fmt",
      manifestPath,
      "--repo-dir",
      tmpDir,
      "--check",
      "--no-color",
    ]);
    assertEquals(code === 0, false);
    assertStringIncludes(stderr, "Quality checks failed");

    // Verify the file was NOT modified
    const unchanged = await Deno.readTextFile(modelPath);
    assertEquals(unchanged, badContent);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extension fmt formats vault TypeScript files", async () => {
  const tmpDir = await initTempRepo();
  try {
    // Create vault file with formatting issues
    const vaultsDir = join(tmpDir, "extensions", "vaults");
    await Deno.mkdir(vaultsDir, { recursive: true });
    const vaultPath = join(vaultsDir, "my_vault.ts");
    await Deno.writeTextFile(
      vaultPath,
      "export const vault={type:'@test/my-vault'};",
    );

    const manifestPath = join(tmpDir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/myext",
        version: "2026.02.26.1",
        vaults: ["my_vault.ts"],
      }),
    );

    const { code } = await runCli([
      "extension",
      "fmt",
      manifestPath,
      "--repo-dir",
      tmpDir,
      "--no-color",
    ]);
    assertEquals(code, 0);

    // Verify the vault file was formatted
    const fixed = await Deno.readTextFile(vaultPath);
    assertStringIncludes(fixed, 'type: "@test/my-vault"');
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extension fmt --check catches vault file issues", async () => {
  const tmpDir = await initTempRepo();
  try {
    // Create vault file with formatting issues
    const vaultsDir = join(tmpDir, "extensions", "vaults");
    await Deno.mkdir(vaultsDir, { recursive: true });
    const vaultPath = join(vaultsDir, "my_vault.ts");
    const badContent = "export const vault={type:'@test/my-vault'};";
    await Deno.writeTextFile(vaultPath, badContent);

    const manifestPath = join(tmpDir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/myext",
        version: "2026.02.26.1",
        vaults: ["my_vault.ts"],
      }),
    );

    const { code, stderr } = await runCli([
      "extension",
      "fmt",
      manifestPath,
      "--repo-dir",
      tmpDir,
      "--check",
      "--no-color",
    ]);
    assertEquals(code === 0, false);
    assertStringIncludes(stderr, "Quality checks failed");

    // Verify the file was NOT modified
    const unchanged = await Deno.readTextFile(vaultPath);
    assertEquals(unchanged, badContent);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extension fmt --help shows usage", async () => {
  const { stdout } = await runCli(["extension", "fmt", "--help"]);
  assertStringIncludes(stdout, "fmt");
  assertStringIncludes(stdout, "manifest-path");
});

Deno.test("extension fmt auto-fixes under paths.base=manifest", async () => {
  const tmpDir = await initTempRepo();
  try {
    // Per-extension-subdir layout: manifest sits in a subdir alongside
    // its source. paths.base=manifest tells the resolver to find
    // entries beside the manifest, not under the configured modelsDir.
    const extDir = join(tmpDir, "extensions", "models", "fmt-paths-base");
    await Deno.mkdir(extDir, { recursive: true });
    const modelPath = join(extDir, "model.ts");
    await Deno.writeTextFile(modelPath, "export const x=1;export const y=2;");

    const manifestPath = join(extDir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/fmt-paths",
        version: "2026.04.29.1",
        paths: { base: "manifest" },
        models: ["model.ts"],
      }),
    );

    const { code, stderr, stdout } = await runCli([
      "extension",
      "fmt",
      manifestPath,
      "--repo-dir",
      tmpDir,
      "--no-color",
    ]);
    assertEquals(code, 0, `Expected success but got:\n${stderr}\n${stdout}`);

    const fixed = await Deno.readTextFile(modelPath);
    assertStringIncludes(fixed, "export const x = 1;");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
