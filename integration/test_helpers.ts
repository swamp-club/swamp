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

/**
 * Shared test helpers for integration tests.
 */

import { dirname, fromFileUrl, join } from "@std/path";
import { ensureDir } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";

/** Absolute path to the project root (parent of integration/). */
const PROJECT_ROOT = join(dirname(fromFileUrl(import.meta.url)), "..");

/**
 * The deno module cache this process is using, captured at module load —
 * before any test has had a chance to repoint HOME.
 */
const DENO_CACHE_DIR = resolveDenoCacheDir();

function resolveDenoCacheDir(): string {
  const explicit = Deno.env.get("DENO_DIR");
  if (explicit) return explicit;
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
  switch (Deno.build.os) {
    case "darwin":
      return join(home, "Library", "Caches", "deno");
    case "windows":
      return join(
        Deno.env.get("LOCALAPPDATA") ?? join(home, "AppData", "Local"),
        "deno",
      );
    default:
      return join(
        Deno.env.get("XDG_CACHE_HOME") ?? join(home, ".cache"),
        "deno",
      );
  }
}

/**
 * Environment entries that root a spawned CLI's user-home writes in `homeDir`.
 *
 * `repo init`/`repo upgrade` install bundled skills into `~/.claude/skills`,
 * `~/.agents/skills` and `~/.kiro/skills`, resolved from the child's HOME at
 * spawn time. Inheriting the parent's HOME overwrites the developer's real
 * skills on every `deno run test`, and — because the suite runs every test
 * file in one process with one shared `Deno.env` — it can also capture a temp
 * directory another test file has momentarily assigned to HOME, whose cleanup
 * then fails with `Directory not empty`.
 *
 * DENO_DIR is pinned alongside it: moving HOME would otherwise move the module
 * cache with it and force the child to re-resolve every dependency.
 */
export function isolatedHomeEnv(homeDir: string): Record<string, string> {
  return {
    HOME: homeDir,
    USERPROFILE: homeDir,
    DENO_DIR: DENO_CACHE_DIR,
  };
}

/** CLI launch args that bypass `deno task` config resolution. */
export const CLI_ARGS = [
  "run",
  "--config",
  join(PROJECT_ROOT, "deno.json"),
  "--unstable-bundle",
  "--allow-read",
  "--allow-write",
  "--allow-env",
  "--allow-run",
  "--allow-sys",
  join(PROJECT_ROOT, "main.ts"),
];

/**
 * Initializes a test repository with the required marker file and directory structure.
 * Call this before running any CLI commands that require an initialized repo.
 */
export async function initializeTestRepo(repoDir: string): Promise<void> {
  // Create top-level directories for source-of-truth files
  const topLevelDirs = ["models", "workflows", "vaults"];
  for (const dir of topLevelDirs) {
    await ensureDir(join(repoDir, dir));
  }

  // Create runtime data directories under .swamp/
  const runtimeSubdirs = [
    ".swamp/outputs",
    ".swamp/data",
    ".swamp/workflow-runs",
    ".swamp/secrets",
  ];
  for (const subdir of runtimeSubdirs) {
    await ensureDir(join(repoDir, subdir));
  }

  // Create the .swamp.yaml marker file
  const markerData = {
    swampVersion: "0.0.0",
    initializedAt: new Date().toISOString(),
  };
  await Deno.writeTextFile(
    join(repoDir, ".swamp.yaml"),
    stringifyYaml(markerData as Record<string, unknown>),
  );
}

/**
 * Runs a CLI command via `deno task dev`.
 *
 * When `stdin` is provided, it is piped to the child process and the writer is
 * closed before awaiting output — required to drive commands that read from
 * stdin (e.g. `model edit`). When omitted, stdin is left at its default so
 * existing call sites are unaffected.
 */
export async function runCliCommand(
  args: string[],
  cwd: string,
  stdin?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const decoder = new TextDecoder();

  if (stdin !== undefined) {
    const child = new Deno.Command(Deno.execPath(), {
      args: [...CLI_ARGS, ...args],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      cwd,
    }).spawn();

    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();

    const { code, stdout, stderr } = await child.output();
    return {
      stdout: decoder.decode(stdout),
      stderr: decoder.decode(stderr),
      code,
    };
  }

  const command = new Deno.Command(Deno.execPath(), {
    args: [...CLI_ARGS, ...args],
    stdout: "piped",
    stderr: "piped",
    cwd,
  });

  const { code, stdout, stderr } = await command.output();
  return {
    stdout: decoder.decode(stdout),
    stderr: decoder.decode(stderr),
    code,
  };
}
