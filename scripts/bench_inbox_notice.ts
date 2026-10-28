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
 * between the binaries so drift on the host affects both alike. Update
 * checks and telemetry are switched off in both, so neither adds network
 * time. Run with:
 *
 * ```
 * deno run -A scripts/bench_inbox_notice.ts \
 *   --branch ./swamp --main /path/to/main/swamp --repo /path/to/repo \
 *   --behavior <name> [--runs 30]
 * ```
 */

import { parseArgs } from "@std/cli/parse-args";

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

async function timeOnce(binary: string): Promise<number> {
  const started = performance.now();
  const { code } = await new Deno.Command(binary, {
    args: ["data", "list", flags.behavior!, "--repo-dir", flags.repo!],
    env: { SWAMP_NO_UPDATE_CHECK: "1", SWAMP_NO_TELEMETRY: "1" },
    stdout: "null",
    stderr: "null",
  }).output();
  const elapsed = performance.now() - started;
  if (code !== 0) throw new Error(`${binary} data list exited ${code}`);
  return elapsed;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

const samples: Record<keyof typeof binaries, number[]> = {
  branch: [],
  main: [],
};
// One unrecorded run each, so neither pays for a cold file cache.
await timeOnce(binaries.branch);
await timeOnce(binaries.main);
for (let i = 0; i < runs; i++) {
  samples.branch.push(await timeOnce(binaries.branch));
  samples.main.push(await timeOnce(binaries.main));
}

for (const name of ["main", "branch"] as const) {
  const sorted = [...samples[name]].sort((a, b) => a - b);
  console.log(
    `${name.padEnd(6)} median ${percentile(sorted, 0.5).toFixed(1)} ms  ` +
      `p95 ${percentile(sorted, 0.95).toFixed(1)} ms  (${runs} runs)`,
  );
}
