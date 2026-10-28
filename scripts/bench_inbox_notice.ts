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
 * What the inbox notice costs a fast command (swamp-club#4059): `swamp data
 * list` timed with two compiled binaries, this branch and `main`, against
 * the same repository. A fast command reads only the inbox cache and makes no
 * request, so the two should differ by one small file read. Runs alternate
 * between the binaries so drift on the host affects both alike.
 *
 * Each run gets a cleared environment and a scratch HOME, never the user's
 * own: a copy of the signed-in credentials and auth-gate stamps, so the gate
 * passes without a request, and an inbox cache seeded with an unread message
 * in both cache layouts, so both binaries print the notice. Every run checks
 * that it did. The user's real `inbox/` and `inbox-v2/` are checksummed before
 * and after, and the script fails if either changed. Update checks and
 * telemetry are switched off, so neither adds network time. Run with:
 *
 * ```
 * deno run -A scripts/bench_inbox_notice.ts \
 *   --branch ./swamp --main /path/to/main/swamp --repo /path/to/repo \
 *   --behavior <name> [--runs 30]
 * ```
 */

import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import { keyFingerprint } from "../src/domain/auth/auth_credentials.ts";
import { InboxCacheKey, InboxState } from "../src/domain/inbox/inbox_state.ts";
import { InboxCacheFileRepository } from "../src/infrastructure/inbox/inbox_cache_file_repository.ts";
import { getSwampConfigDir } from "../src/infrastructure/persistence/paths.ts";
import { INBOX_NOTICE_READ_LINE } from "../src/presentation/renderers/inbox_notice.ts";

const flags = parseArgs(Deno.args, {
  string: ["branch", "main", "repo", "behavior", "runs"],
});
if (!flags.branch || !flags.main || !flags.repo || !flags.behavior) {
  console.error(
    "Usage: bench_inbox_notice.ts --branch <binary> --main <binary> " +
      "--repo <dir> --behavior <name> [--runs <n>]",
  );
  Deno.exit(2);
}
const runs = Number(flags.runs ?? "30");
if (!Number.isInteger(runs) || runs < 1) {
  console.error(`--runs must be a whole number of 1 or more: ${flags.runs}`);
  Deno.exit(2);
}
const binaries = { branch: flags.branch, main: flags.main };

/** The files the auth gate reads, copied so it passes without a request. */
const AUTH_FILES = [
  "auth.json",
  "auth_verified.json",
  "auth_fail_open.json",
  "auth_token_check.json",
  "auth_refresh_attempt.json",
];

const NEWEST_ID = "01JBX5Q8ZK00000000000000ZX";

/** A digest of every file under `dir`, or "absent" when it does not exist. */
async function checksum(dir: string): Promise<string> {
  const entries: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile) continue;
      const bytes = await Deno.readFile(join(dir, entry.name));
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", bytes),
      );
      const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0"))
        .join("");
      entries.push(`${entry.name} ${hex}`);
    }
  } catch (error: unknown) {
    if (error instanceof Deno.errors.NotFound) return "absent";
    throw error;
  }
  return entries.sort().join("\n");
}

/**
 * A scratch HOME whose config dir holds a copy of the real credentials and
 * gate stamps, and an inbox cache that shows a notice in both layouts.
 */
async function seedHome(realConfig: string, home: string): Promise<void> {
  const config = join(home, ".config", "swamp");
  await Deno.mkdir(config, { recursive: true, mode: 0o700 });
  for (const name of AUTH_FILES) {
    try {
      await Deno.copyFile(join(realConfig, name), join(config, name));
      await Deno.chmod(join(config, name), 0o600);
    } catch (error: unknown) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  const auth = JSON.parse(await Deno.readTextFile(join(config, "auth.json")));
  if (typeof auth.apiKey !== "string" || auth.apiKey === "") {
    throw new Error("Sign in with swamp auth login first: no stored API key");
  }
  const fingerprint = await keyFingerprint(auth.apiKey);
  const state: InboxState = {
    ...InboxState.empty(),
    snapshot: {
      unread: 1,
      newestId: NEWEST_ID,
      newestAt: null,
      pollAfterSeconds: 900,
      etag: null,
    },
    schedule: { lastPolledAt: Date.now(), nextPollAt: null, stop: null },
  };
  // The branch binary's layout.
  await new InboxCacheFileRepository(config).save(
    InboxCacheKey.of(auth.serverUrl, fingerprint),
    state,
  );
  // The first layout, one file per fingerprint, which main still reads.
  await Deno.mkdir(join(config, "inbox"), { recursive: true });
  await Deno.writeTextFile(
    join(config, "inbox", `${fingerprint}.json`),
    JSON.stringify({
      version: 1,
      snapshot: state.snapshot,
      schedule: {
        lastPolledAt: new Date(state.schedule.lastPolledAt!).toISOString(),
        nextPollAt: null,
        stop: null,
      },
      announcement: null,
    }),
    { mode: 0o600 },
  );
}

async function timeOnce(binary: string, home: string): Promise<number> {
  const started = performance.now();
  const { code, stderr } = await new Deno.Command(binary, {
    args: ["data", "list", flags.behavior!, "--repo-dir", flags.repo!],
    clearEnv: true,
    env: {
      HOME: home,
      PATH: Deno.env.get("PATH") ?? "",
      SWAMP_NO_UPDATE_CHECK: "1",
      SWAMP_NO_TELEMETRY: "1",
    },
    stdout: "null",
    stderr: "piped",
  }).output();
  const elapsed = performance.now() - started;
  if (code !== 0) throw new Error(`${binary} data list exited ${code}`);
  const text = new TextDecoder().decode(stderr);
  if (!text.includes(INBOX_NOTICE_READ_LINE.trim())) {
    throw new Error(`${binary} did not print the inbox notice:\n${text}`);
  }
  return elapsed;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

const realConfig = getSwampConfigDir();
const guarded = [join(realConfig, "inbox"), join(realConfig, "inbox-v2")];
const before = await Promise.all(guarded.map(checksum));
const home = await Deno.makeTempDir({ prefix: "swamp-bench-inbox-" });
try {
  await seedHome(realConfig, home);
  const samples: Record<keyof typeof binaries, number[]> = {
    branch: [],
    main: [],
  };
  // One unrecorded run each, so neither pays for a cold file cache.
  await timeOnce(binaries.branch, home);
  await timeOnce(binaries.main, home);
  for (let i = 0; i < runs; i++) {
    samples.branch.push(await timeOnce(binaries.branch, home));
    samples.main.push(await timeOnce(binaries.main, home));
  }

  for (const name of ["main", "branch"] as const) {
    const sorted = [...samples[name]].sort((a, b) => a - b);
    console.log(
      `${name.padEnd(6)} median ${percentile(sorted, 0.5).toFixed(1)} ms  ` +
        `p95 ${percentile(sorted, 0.95).toFixed(1)} ms  (${runs} runs)`,
    );
  }
} finally {
  await Deno.remove(home, { recursive: true });
}
const after = await Promise.all(guarded.map(checksum));
for (const [i, dir] of guarded.entries()) {
  if (before[i] !== after[i]) {
    console.error(`The benchmark changed the real inbox state in ${dir}`);
    Deno.exit(1);
  }
}
