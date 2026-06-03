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

import { assert, assertEquals } from "@std/assert";
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

async function readPersistedEntries(
  repoDir: string,
): Promise<Record<string, unknown>[]> {
  const dir = join(repoDir, ".swamp", "telemetry");
  const entries: Record<string, unknown>[] = [];
  for await (const file of Deno.readDir(dir)) {
    if (!file.isFile || !file.name.endsWith(".json")) continue;
    const text = await Deno.readTextFile(join(dir, file.name));
    entries.push(JSON.parse(text) as Record<string, unknown>);
  }
  return entries;
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-tel-ctx-test-" });
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

/** Subprocess env that the CLI needs to function but with no harness signals
 * unless the test sets them explicitly. */
function baseChildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["HOME", "PATH", "USER", "TMPDIR", "TMP", "TEMP"]) {
    const value = Deno.env.get(key);
    if (value !== undefined) env[key] = value;
  }
  // Pin telemetry to a localhost endpoint that nothing listens on so the
  // post-command flush dies fast and does not pollute the test's persisted
  // file. The test reads the still-unflushed local entry directly.
  env.SWAMP_DEBUG = "0";
  return env;
}

Deno.test("CLI bootstrap stamps invocationContext on persisted telemetry", async () => {
  await withTempDir(async (dir) => {
    // Initialise a repo enrolled with both claude and cursor. Use --json so
    // we can parse the result if needed.
    const init = await runCliWithEnv(
      ["--json", "repo", "init", "--tool", "claude", "--tool", "cursor"],
      dir,
      baseChildEnv(),
    );
    assertEquals(init.code, 0, `repo init failed: ${init.stderr}`);

    // Pin a telemetryEndpoint that nothing is listening on so the
    // post-command flush bails fast and the entry stays on disk for us
    // to inspect. Append the field to the existing marker.
    const markerPath = join(dir, ".swamp.yaml");
    const marker = await Deno.readTextFile(markerPath);
    await Deno.writeTextFile(
      markerPath,
      marker +
        "\ntelemetryEndpoint: http://127.0.0.1:1\ntelemetryKeepFlushed: true\n",
    );

    // Run a real command that flows through the full action pipeline
    // (Cliffy's --version handler exits before recordSuccess runs). repo
    // upgrade on an already-initialised repo is a cheap no-op and goes
    // through the full path. Set the claude harness signal in the child
    // env so detection has something to identify.
    const childEnv = baseChildEnv();
    childEnv.CLAUDECODE = "1";
    const run = await runCliWithEnv(
      ["--json", "repo", "upgrade"],
      dir,
      childEnv,
    );
    assertEquals(run.code, 0, `repo upgrade failed: ${run.stderr}`);

    // Read what was persisted under .swamp/telemetry/.
    const persisted = await readPersistedEntries(dir);
    assert(persisted.length > 0, "no telemetry entries were written");

    // Find the entry corresponding to the upgrade run.
    const target = persisted.find((entry) => {
      const inv = entry.invocation as Record<string, unknown> | undefined;
      return inv?.command === "repo" && inv?.subcommand === "upgrade";
    });
    assert(target, "no entry matched the repo upgrade invocation");

    const ctx = target!.invocationContext as
      | Record<string, unknown>
      | undefined;
    assert(ctx, "entry missing invocationContext");
    assertEquals(ctx!.configuredAiTools, ["claude", "cursor"]);
    assertEquals(ctx!.detectedAiTool, "claude");
    assertEquals(ctx!.agentSessionDetected, true);
    // The child process inherits no tty by default — isInteractive must be
    // false in this test.
    assertEquals(ctx!.isInteractive, false);
  });
});
