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
import {
  CLI_ARGS,
  isolatedHomeEnv,
  UNREACHABLE_TELEMETRY_ENDPOINT,
  waitForTelemetrySender,
} from "./test_helpers.ts";
import { writeGateCredential } from "./auth_gate_fixture.ts";

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
  configDir: string,
): Promise<Record<string, unknown>[]> {
  // Telemetry is user-global: entries spool under <config>/swamp/telemetry,
  // never under the repo.
  const dir = join(configDir, "swamp", "telemetry");
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
    try {
      await waitForTelemetrySender(join(dir, "xdg"));
    } finally {
      if (Deno.build.os === "windows") {
        await Deno.remove(dir, { recursive: true }).catch(() => {});
      } else {
        await Deno.remove(dir, { recursive: true });
      }
    }
  }
}

function baseChildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["HOME", "PATH", "USER", "TMPDIR", "TMP", "TEMP"]) {
    const value = Deno.env.get(key);
    if (value !== undefined) env[key] = value;
  }
  // Every run, repo init included, stays off the default endpoint, and the
  // test reads the still-unflushed local entry directly.
  env.SWAMP_TELEMETRY_ENDPOINT = UNREACHABLE_TELEMETRY_ENDPOINT;
  env.SWAMP_DEBUG = "0";
  return env;
}

Deno.test("CLI bootstrap stamps invocationContext on persisted telemetry", async () => {
  await withTempDir(async (dir) => {
    // Isolate the user-global telemetry spool (and identity/auth) to a temp
    // config dir so the test never touches the developer's real ~/.config.
    const configDir = join(dir, "xdg");
    // The auth gate needs a swamp-club credential in that config dir.
    await writeGateCredential(join(configDir, "swamp"));
    const childEnvWith = (extra: Record<string, string> = {}) => ({
      ...baseChildEnv(),
      // `repo init --tool claude --tool cursor` installs bundled skills into
      // the child's ~/.claude/skills and ~/.agents/skills. Root them here.
      ...isolatedHomeEnv(join(dir, "home")),
      XDG_CONFIG_HOME: configDir,
      ...extra,
    });

    const init = await runCliWithEnv(
      ["--json", "repo", "init", "--tool", "claude", "--tool", "cursor"],
      dir,
      childEnvWith(),
    );
    assertEquals(init.code, 0, `repo init failed: ${init.stderr}`);

    const markerPath = join(dir, ".swamp.yaml");
    const marker = await Deno.readTextFile(markerPath);
    await Deno.writeTextFile(
      markerPath,
      marker + "\ntelemetryKeepFlushed: true\n",
    );

    // a real command through the full action pipeline (--version exits before
    // recordSuccess); repo upgrade on an initialised repo is a cheap no-op,
    // with the claude harness signal set for detection
    const run = await runCliWithEnv(
      ["--json", "repo", "upgrade"],
      dir,
      childEnvWith({ CLAUDECODE: "1" }),
    );
    assertEquals(run.code, 0, `repo upgrade failed: ${run.stderr}`);

    const persisted = await readPersistedEntries(configDir);
    assert(persisted.length > 0, "no telemetry entries were written");

    // The spool also holds the sender's flush record, which is not an entry.
    const entries = persisted.filter((entry) => entry.invocation !== undefined);
    assert(
      entries.some((entry) => {
        const inv = entry.invocation as Record<string, unknown>;
        return inv.command === "repo" && inv.subcommand === "init";
      }),
      "no entry matched the repo init invocation",
    );
    for (const entry of entries) {
      assertEquals(entry.endpoint, UNREACHABLE_TELEMETRY_ENDPOINT);
    }

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
    // The fixture's proof verified locally, with no live check.
    assertEquals(ctx!.authMode, "verified");
  });
});
