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

/**
 * End-to-end driver-resolution coverage for the direct `swamp model
 * method run` path against a real `.swamp.yaml` marker file. Raw-driver
 * only — no Docker required.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";
import { CLI_ARGS } from "./test_helpers.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-driver-res-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function writeMarker(
  repoDir: string,
  extra: Record<string, unknown>,
): Promise<void> {
  const marker = {
    swampVersion: "0.0.0",
    initializedAt: new Date().toISOString(),
    ...extra,
  };
  await Deno.writeTextFile(
    join(repoDir, ".swamp.yaml"),
    stringifyYaml(marker as Record<string, unknown>),
  );
}

async function initializeTestRepo(
  repoDir: string,
  markerExtra: Record<string, unknown> = {},
): Promise<void> {
  const subdirs = [
    "models",
    "workflows",
    ".swamp/outputs",
    ".swamp/data",
    ".swamp/logs",
    ".swamp/workflow-runs",
    ".swamp/workflows-evaluated",
    ".swamp/definitions-evaluated",
  ];
  for (const subdir of subdirs) {
    await ensureDir(join(repoDir, subdir));
  }
  await writeMarker(repoDir, markerExtra);
}

async function createShellModel(
  repoDir: string,
  name: string,
): Promise<void> {
  const modelData = {
    type: "command/shell",
    typeVersion: 1,
    id: crypto.randomUUID(),
    name,
    version: 1,
    tags: {},
    globalArguments: {},
    methods: {
      execute: {
        arguments: {
          run: "echo driver-res-ok",
        },
      },
    },
  };
  const modelDir = join(repoDir, "models/command/shell");
  await ensureDir(modelDir);
  await Deno.writeTextFile(
    join(modelDir, `${modelData.id}.yaml`),
    stringifyYaml(modelData as Record<string, unknown>),
  );
}

async function runCli(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const command = new Deno.Command(Deno.execPath(), {
    args: [...CLI_ARGS, ...args],
    stdout: "piped",
    stderr: "piped",
    cwd: Deno.cwd(),
  });
  const { code, stdout, stderr } = await command.output();
  return {
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    code,
  };
}

Deno.test(
  "CLI model method run honors defaultDriver: raw from .swamp.yaml",
  async () => {
    await withTempDir(async (repoDir) => {
      await initializeTestRepo(repoDir, { defaultDriver: "raw" });
      await createShellModel(repoDir, "driver-res-model");

      const result = await runCli([
        "model",
        "method",
        "run",
        "driver-res-model",
        "execute",
        "--repo-dir",
        repoDir,
        "--json",
      ]);

      assertEquals(
        result.code,
        0,
        `Should succeed with raw default. stderr: ${result.stderr}`,
      );
      const output = JSON.parse(result.stdout);
      assertEquals(output.modelName, "driver-res-model");
    });
  },
);

Deno.test(
  "CLI --driver raw override wins over .swamp.yaml defaultDriver",
  async () => {
    await withTempDir(async (repoDir) => {
      // Configure a docker default — the --driver raw override should win
      // and keep the method runnable without docker.
      await initializeTestRepo(repoDir, { defaultDriver: "docker" });
      await createShellModel(repoDir, "driver-override-model");

      const result = await runCli([
        "model",
        "method",
        "run",
        "driver-override-model",
        "execute",
        "--repo-dir",
        repoDir,
        "--driver",
        "raw",
        "--json",
      ]);

      assertEquals(
        result.code,
        0,
        `CLI override should win. stderr: ${result.stderr}`,
      );
    });
  },
);

Deno.test(
  "CLI model method run fails loudly on malformed .swamp.yaml",
  async () => {
    await withTempDir(async (repoDir) => {
      const subdirs = [
        "models",
        ".swamp/outputs",
        ".swamp/data",
        ".swamp/logs",
      ];
      for (const subdir of subdirs) {
        await ensureDir(join(repoDir, subdir));
      }
      // Valid YAML frontmatter, but structurally broken — picked up now
      // that the direct path parses the marker on every invocation.
      await Deno.writeTextFile(
        join(repoDir, ".swamp.yaml"),
        "swampVersion: [unclosed\n",
      );
      await createShellModel(repoDir, "malformed-marker-model");

      const result = await runCli([
        "model",
        "method",
        "run",
        "malformed-marker-model",
        "execute",
        "--repo-dir",
        repoDir,
        "--json",
      ]);

      assertEquals(
        result.code !== 0,
        true,
        "Malformed .swamp.yaml should abort",
      );
      // Error surface is non-specific YAML parse failure; the point is the
      // run fails rather than silently proceeding with no marker.
      assertStringIncludes(
        (result.stderr + result.stdout).toLowerCase(),
        "yaml",
      );
    });
  },
);
