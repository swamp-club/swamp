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

const PROJECT_ROOT = Deno.cwd();

async function runCli(
  args: string[],
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["task", "dev", ...args],
    stdout: "piped",
    stderr: "piped",
    cwd: PROJECT_ROOT,
    env: {
      ...Deno.env.toObject(),
      SWAMP_NO_TELEMETRY: "1",
      ...env,
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

Deno.test("extension push --help shows usage", async () => {
  const { stdout } = await runCli(["extension", "push", "--help"]);
  assertStringIncludes(stdout, "push");
  assertStringIncludes(stdout, "manifest-path");
});

Deno.test("extension --help shows subcommands", async () => {
  const { stdout } = await runCli(["extension", "--help"]);
  assertStringIncludes(stdout, "push");
  assertStringIncludes(stdout, "extension");
});

Deno.test("extension push with missing manifest file gives clear error", async () => {
  const tmpDir = await initTempRepo();
  try {
    const { stderr, code } = await runCli([
      "extension",
      "push",
      join(tmpDir, "nonexistent-manifest.yaml"),
      "--repo-dir",
      tmpDir,
      "--no-color",
    ]);
    assertEquals(code === 0, false);
    assertStringIncludes(stderr, "not found");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extension push with invalid manifest (no manifestVersion) gives clear error", async () => {
  const tmpDir = await initTempRepo();
  try {
    const manifestPath = join(tmpDir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        name: "@test/myext",
        version: "2026.02.26.1",
        models: ["model.ts"],
      }),
    );

    const { stderr, code } = await runCli([
      "extension",
      "push",
      manifestPath,
      "--repo-dir",
      tmpDir,
      "--no-color",
    ]);
    assertEquals(code === 0, false);
    assertStringIncludes(stderr, "manifestVersion");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extension push with invalid manifest (bad version) gives clear error", async () => {
  const tmpDir = await initTempRepo();
  try {
    const manifestPath = join(tmpDir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/myext",
        version: "1.0.0",
        models: ["model.ts"],
      }),
    );

    const { stderr, code } = await runCli([
      "extension",
      "push",
      manifestPath,
      "--repo-dir",
      tmpDir,
      "--no-color",
    ]);
    assertEquals(code === 0, false);
    assertStringIncludes(stderr, "CalVer");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extension push with invalid manifest (no models or workflows) gives clear error", async () => {
  const tmpDir = await initTempRepo();
  try {
    const manifestPath = join(tmpDir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/myext",
        version: "2026.02.26.1",
      }),
    );

    const { stderr, code } = await runCli([
      "extension",
      "push",
      manifestPath,
      "--repo-dir",
      tmpDir,
      "--no-color",
    ]);
    assertEquals(code === 0, false);
    assertStringIncludes(stderr, "at least one model, workflow, or vault");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extension push without auth credentials gives clear error", async () => {
  const tmpDir = await initTempRepo();
  const fakeHome = await Deno.makeTempDir();
  try {
    // Create models directory and a model file
    const modelsDir = join(tmpDir, "extensions", "models");
    await Deno.mkdir(modelsDir, { recursive: true });
    await Deno.writeTextFile(
      join(modelsDir, "model.ts"),
      "export const x = 1;\n",
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

    const { stderr, code } = await runCli(
      [
        "extension",
        "push",
        manifestPath,
        "--repo-dir",
        tmpDir,
        "--no-color",
      ],
      {
        HOME: fakeHome,
        XDG_CONFIG_HOME: join(fakeHome, ".config"),
      },
    );
    assertEquals(code === 0, false);
    assertStringIncludes(stderr, "Not authenticated");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
    await Deno.remove(fakeHome, { recursive: true });
  }
});
