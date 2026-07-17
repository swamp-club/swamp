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

// Verifies that CLI telemetry is user-global: every invocation spools to
// `<XDG_CONFIG_HOME>/swamp/telemetry/` — whether or not it ran inside a swamp
// repo — and never to a repo-local `.swamp/telemetry/` directory.
//
// The integration harness (CLI_ARGS) grants no `--allow-net`, so the
// post-command telemetry flush always fails and the entry stays on disk for
// inspection without ever reaching a real endpoint.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { CLI_ARGS } from "./test_helpers.ts";

interface CliRunResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function runCliWithEnv(
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<CliRunResult> {
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
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    code,
  };
}

async function readEntries(
  telemetryDir: string,
): Promise<Record<string, unknown>[]> {
  const entries: Record<string, unknown>[] = [];
  try {
    for await (const file of Deno.readDir(telemetryDir)) {
      if (!file.isFile || !file.name.endsWith(".json")) continue;
      const text = await Deno.readTextFile(join(telemetryDir, file.name));
      entries.push(JSON.parse(text) as Record<string, unknown>);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  return entries;
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-tel-global-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/** Minimal child env; XDG_CONFIG_HOME is set per-test to isolate the spool. */
function baseChildEnv(configDir: string): Record<string, string> {
  const env: Record<string, string> = { XDG_CONFIG_HOME: configDir };
  for (const key of ["HOME", "PATH", "USER", "TMPDIR", "TMP", "TEMP"]) {
    const value = Deno.env.get(key);
    if (value !== undefined) env[key] = value;
  }
  return env;
}

let cachedDenoDir: string | null = null;

/**
 * The parent process's resolved deno cache directory. Children whose
 * HOME/USERPROFILE is redirected must pin DENO_DIR to it — otherwise deno
 * re-derives the cache under the fake home and re-downloads every module.
 */
async function realDenoDir(): Promise<string> {
  if (cachedDenoDir === null) {
    const { stdout } = await new Deno.Command(Deno.execPath(), {
      args: ["info", "--json"],
      stdout: "piped",
      stderr: "null",
    }).output();
    const info = JSON.parse(new TextDecoder().decode(stdout)) as {
      denoDir: string;
    };
    cachedDenoDir = info.denoDir;
  }
  return cachedDenoDir;
}

/** Child env with home redirected to a fake home dir (Windows included). */
async function homeRedirectedEnv(
  configDir: string,
  homeDir: string,
): Promise<Record<string, string>> {
  const env = baseChildEnv(configDir);
  env.HOME = homeDir;
  env.USERPROFILE = homeDir;
  env.DENO_DIR = await realDenoDir();
  return env;
}

Deno.test("repo-less telemetry spools to the user-global directory", async () => {
  await withTempDir(async (configDir) => {
    await withTempDir(async (workDir) => {
      // `telemetry stats` flows through the full action pipeline (recordSuccess
      // runs in teardown) and now works outside a repo. workDir has no marker.
      const run = await runCliWithEnv(
        ["--json", "telemetry", "stats"],
        workDir,
        baseChildEnv(configDir),
      );
      assertEquals(run.code, 0, `telemetry stats failed: ${run.stderr}`);

      const spoolDir = join(configDir, "swamp", "telemetry");
      const entries = await readEntries(spoolDir);
      assert(
        entries.length > 0,
        "no telemetry entry written to the user-global spool",
      );

      const target = entries.find((entry) => {
        const inv = entry.invocation as Record<string, unknown> | undefined;
        return inv?.command === "telemetry" && inv?.subcommand === "stats";
      });
      assert(target, "no entry matched the telemetry stats invocation");

      const ctx = target!.invocationContext as
        | Record<string, unknown>
        | undefined;
      assert(ctx, "entry missing invocationContext");
      // Repo-less: no marker, so there is no configured tool list to report.
      assertEquals(ctx!.configuredAiTools, undefined);

      // There is no repo, so no repo-local spool should ever be created.
      await assertRejects(
        () => Deno.stat(join(workDir, ".swamp", "telemetry")),
        Deno.errors.NotFound,
      );
    });
  });
});

async function seedRepoLocalEntry(repoDir: string): Promise<string> {
  // Simulate a legacy repo-local spool holding one unflushed entry.
  const spool = join(repoDir, ".swamp", "telemetry");
  await Deno.mkdir(spool, { recursive: true });
  const name = `telemetry-2026-07-13-${crypto.randomUUID()}.json`;
  await Deno.writeTextFile(join(spool, name), '{"id":"legacy"}');
  return name;
}

Deno.test("repo upgrade migrates unflushed repo-local telemetry to the global spool", async () => {
  await withTempDir(async (configDir) => {
    await withTempDir(async (repoDir) => {
      const init = await runCliWithEnv(
        ["--json", "repo", "init", "--tool", "claude"],
        repoDir,
        baseChildEnv(configDir),
      );
      assertEquals(init.code, 0, `repo init failed: ${init.stderr}`);

      const legacyName = await seedRepoLocalEntry(repoDir);

      const run = await runCliWithEnv(
        ["--json", "repo", "upgrade"],
        repoDir,
        baseChildEnv(configDir),
      );
      assertEquals(run.code, 0, `repo upgrade failed: ${run.stderr}`);

      // The legacy entry was moved to the user-global spool...
      assertEquals(
        await Deno.stat(join(configDir, "swamp", "telemetry", legacyName))
          .then(() => true),
        true,
      );
      // ...and removed from the repo-local spool.
      await assertRejects(
        () => Deno.stat(join(repoDir, ".swamp", "telemetry", legacyName)),
        Deno.errors.NotFound,
      );
    });
  });
});

Deno.test("repo upgrade does NOT migrate telemetry for a disabled repo", async () => {
  await withTempDir(async (configDir) => {
    await withTempDir(async (repoDir) => {
      const init = await runCliWithEnv(
        ["--json", "repo", "init", "--tool", "claude"],
        repoDir,
        baseChildEnv(configDir),
      );
      assertEquals(init.code, 0, `repo init failed: ${init.stderr}`);

      // Opt this repo out of telemetry.
      const markerPath = join(repoDir, ".swamp.yaml");
      const marker = await Deno.readTextFile(markerPath);
      await Deno.writeTextFile(
        markerPath,
        marker + "\ntelemetryDisabled: true\n",
      );

      const legacyName = await seedRepoLocalEntry(repoDir);

      const run = await runCliWithEnv(
        ["--json", "repo", "upgrade"],
        repoDir,
        baseChildEnv(configDir),
      );
      assertEquals(run.code, 0, `repo upgrade failed: ${run.stderr}`);

      // The opted-out repo's entry stays orphaned in the repo-local spool...
      assertEquals(
        await Deno.stat(join(repoDir, ".swamp", "telemetry", legacyName))
          .then(() => true),
        true,
      );
      // ...and is never moved into the global spool (where it would be sent).
      await assertRejects(
        () => Deno.stat(join(configDir, "swamp", "telemetry", legacyName)),
        Deno.errors.NotFound,
      );
    });
  });
});

Deno.test("home-as-repo legacy telemetry is auto-migrated on any invocation", async () => {
  await withTempDir(async (configDir) => {
    await withTempDir(async (homeDir) => {
      await withTempDir(async (workDir) => {
        // Initialize the fake home directory itself as a swamp repo.
        const init = await runCliWithEnv(
          ["--json", "repo", "init", "--tool", "claude"],
          homeDir,
          baseChildEnv(configDir),
        );
        assertEquals(init.code, 0, `repo init failed: ${init.stderr}`);

        const legacyName = await seedRepoLocalEntry(homeDir);

        // Run an ordinary command from a non-repo cwd, with HOME pointing at
        // the home repo (USERPROFILE covers the Windows fallback).
        const run = await runCliWithEnv(
          ["--json", "telemetry", "stats"],
          workDir,
          await homeRedirectedEnv(configDir, homeDir),
        );
        assertEquals(run.code, 0, `telemetry stats failed: ${run.stderr}`);

        // The stranded entry was drained into the user-global spool...
        assertEquals(
          await Deno.stat(join(configDir, "swamp", "telemetry", legacyName))
            .then(() => true),
          true,
        );
        // ...and removed from the home repo's legacy spool.
        await assertRejects(
          () => Deno.stat(join(homeDir, ".swamp", "telemetry", legacyName)),
          Deno.errors.NotFound,
        );
      });
    });
  });
});

Deno.test("home-as-repo legacy telemetry is NOT migrated when the home repo opted out", async () => {
  await withTempDir(async (configDir) => {
    await withTempDir(async (homeDir) => {
      await withTempDir(async (workDir) => {
        const init = await runCliWithEnv(
          ["--json", "repo", "init", "--tool", "claude"],
          homeDir,
          baseChildEnv(configDir),
        );
        assertEquals(init.code, 0, `repo init failed: ${init.stderr}`);

        // Opt the home repo out of telemetry.
        const markerPath = join(homeDir, ".swamp.yaml");
        const marker = await Deno.readTextFile(markerPath);
        await Deno.writeTextFile(
          markerPath,
          marker + "\ntelemetryDisabled: true\n",
        );

        const legacyName = await seedRepoLocalEntry(homeDir);

        const run = await runCliWithEnv(
          ["--json", "telemetry", "stats"],
          workDir,
          await homeRedirectedEnv(configDir, homeDir),
        );
        assertEquals(run.code, 0, `telemetry stats failed: ${run.stderr}`);

        // The opted-out home repo's entry stays orphaned in its spool...
        assertEquals(
          await Deno.stat(join(homeDir, ".swamp", "telemetry", legacyName))
            .then(() => true),
          true,
        );
        // ...and is never moved into the global spool (where it would be sent).
        await assertRejects(
          () => Deno.stat(join(configDir, "swamp", "telemetry", legacyName)),
          Deno.errors.NotFound,
        );
      });
    });
  });
});

Deno.test("in-repo telemetry spools to the user-global directory, not the repo", async () => {
  await withTempDir(async (configDir) => {
    await withTempDir(async (repoDir) => {
      const init = await runCliWithEnv(
        ["--json", "repo", "init", "--tool", "claude"],
        repoDir,
        baseChildEnv(configDir),
      );
      assertEquals(init.code, 0, `repo init failed: ${init.stderr}`);

      // repo init must not scaffold a repo-local telemetry directory.
      await assertRejects(
        () => Deno.stat(join(repoDir, ".swamp", "telemetry")),
        Deno.errors.NotFound,
      );

      // A real command through the full pipeline (repo upgrade is a cheap
      // no-op on an already-initialised repo). Set the claude harness signal.
      const runEnv = baseChildEnv(configDir);
      runEnv.CLAUDECODE = "1";
      const run = await runCliWithEnv(
        ["--json", "repo", "upgrade"],
        repoDir,
        runEnv,
      );
      assertEquals(run.code, 0, `repo upgrade failed: ${run.stderr}`);

      // The entry landed in the user-global spool, enriched from the marker.
      const entries = await readEntries(join(configDir, "swamp", "telemetry"));
      const target = entries.find((entry) => {
        const inv = entry.invocation as Record<string, unknown> | undefined;
        return inv?.command === "repo" && inv?.subcommand === "upgrade";
      });
      assert(
        target,
        "no user-global entry matched the repo upgrade invocation",
      );

      const ctx = target!.invocationContext as
        | Record<string, unknown>
        | undefined;
      assert(ctx, "entry missing invocationContext");
      // Marker enrichment is preserved on the global event.
      assertEquals(ctx!.configuredAiTools, ["claude"]);
      assertEquals(ctx!.detectedAiTool, "claude");

      // Nothing was written to a repo-local spool.
      await assertRejects(
        () => Deno.stat(join(repoDir, ".swamp", "telemetry")),
        Deno.errors.NotFound,
      );
    });
  });
});
