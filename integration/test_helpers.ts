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

import { dirname, fromFileUrl, join } from "@std/path";
import { ensureDir } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";
import { waitFor } from "@swamp-club/swamp-testing";
import { getSwampDataDir } from "../src/infrastructure/persistence/paths.ts";
import { SENDER_LOCK_FILE } from "../src/infrastructure/telemetry/telemetry_sender_process.ts";
import { withGateCredentialEnv } from "./auth_gate_fixture.ts";

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
 * roots a spawned CLI's home writes in homeDir: inheriting HOME overwrites the
 * developer's real skills and can capture a temp dir another test assigned to
 * HOME
 */
export function isolatedHomeEnv(homeDir: string): Record<string, string> {
  return {
    HOME: homeDir,
    USERPROFILE: homeDir,
    DENO_DIR: DENO_CACHE_DIR,
  };
}

/** nothing listens here, so a spawned CLI's telemetry send fails at once */
export const UNREACHABLE_TELEMETRY_ENDPOINT = "http://127.0.0.1:1";

/**
 * a spawned CLI's detached sender recreates its telemetry dir when it records a
 * failed send, so a test removing that dir waits first. The sender releases the
 * lock last, and its parent claims it before starting it
 */
export async function waitForTelemetrySender(
  configDir: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<void> {
  const lockPath = join(configDir, "swamp", "telemetry", SENDER_LOCK_FILE);
  await waitFor(
    async () => {
      try {
        await Deno.stat(lockPath);
        return false;
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return true;
        throw error;
      }
    },
    "the telemetry sender to release its lock",
    { timeoutMs: options.timeoutMs ?? 60_000 },
  );
}

/**
 * The Deno cache swamp's extension bundler uses in this process, captured at
 * module load — before any test has had a chance to repoint SWAMP_HOME.
 */
export const SHARED_SWAMP_DENO_CACHE = join(getSwampDataDir(), "deno-cache");

/**
 * with SWAMP_HOME mocked to a fresh dir, `deno bundle` downloads esbuild from
 * npm on every run, and withMockedFetch cannot stub the child process; call
 * after creating swampHome and before bundling
 */
export async function linkSharedSwampDenoCache(
  swampHome: string,
): Promise<void> {
  await ensureDir(SHARED_SWAMP_DENO_CACHE);
  try {
    await Deno.symlink(
      SHARED_SWAMP_DENO_CACHE,
      join(swampHome, "deno-cache"),
      { type: "dir" },
    );
  } catch (error) {
    if (Deno.build.os !== "windows") throw error;
  }
}

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

export async function initializeTestRepo(repoDir: string): Promise<void> {
  const topLevelDirs = ["models", "workflows", "vaults"];
  for (const dir of topLevelDirs) {
    await ensureDir(join(repoDir, dir));
  }

  const runtimeSubdirs = [
    ".swamp/outputs",
    ".swamp/data",
    ".swamp/workflow-runs",
    ".swamp/secrets",
  ];
  for (const subdir of runtimeSubdirs) {
    await ensureDir(join(repoDir, subdir));
  }

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
 * when `stdin` is given it is piped and the writer closed before awaiting
 * output, for commands that read stdin
 */
export async function runCliCommand(
  args: string[],
  cwd: string,
  stdin?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  // Every CLI child needs a swamp-club credential to pass the auth gate.
  return await withGateCredentialEnv(async (env) => {
    const decoder = new TextDecoder();

    if (stdin !== undefined) {
      const child = new Deno.Command(Deno.execPath(), {
        args: [...CLI_ARGS, ...args],
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
        cwd,
        env,
        clearEnv: true,
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
      env,
      clearEnv: true,
    });

    const { code, stdout, stderr } = await command.output();
    return {
      stdout: decoder.decode(stdout),
      stderr: decoder.decode(stderr),
      code,
    };
  });
}
