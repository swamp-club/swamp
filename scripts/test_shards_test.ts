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

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  allocateShardDirs,
  combinedExitCode,
  DEFAULT_WEIGHT_SECONDS,
  discoverTestFiles,
  failureBlocks,
  isTestFile,
  parseCliArgs,
  parseResultLine,
  parseTestTask,
  partition,
  shardPlan,
  testConfigFrom,
  WEIGHTS_FILE,
  weightsFromLines,
} from "./test_shards.ts";

const ROOT = join(dirname(fromFileUrl(import.meta.url)), "..");

Deno.test("isTestFile: matches the names deno test runs", () => {
  for (const name of ["a_test.ts", "b.test.tsx", "test.ts", "c_test.mjs"]) {
    assertEquals(isTestFile(name), true, name);
  }
  for (const name of ["atest.ts", "test_helpers.ts", "a_test.json", "x.ts"]) {
    assertEquals(isTestFile(name), false, name);
  }
});

Deno.test("discoverTestFiles: applies include and exclude and skips .git and node_modules", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-shards-test-" });
  try {
    const files = [
      "a_test.ts",
      "src/b.test.tsx",
      "src/test.ts",
      "src/helper.ts",
      "node_modules/pkg/x_test.ts",
      ".git/y_test.ts",
      "design/z_test.ts",
      "design2/w_test.ts",
    ];
    for (const file of files) {
      await Deno.mkdir(join(dir, dirname(file)), { recursive: true });
      await Deno.writeTextFile(join(dir, file), "");
    }
    const found = await discoverTestFiles(
      dir,
      testConfigFrom({ test: { include: ["./"] }, exclude: ["design/"] }),
    );
    assertEquals(found, [
      "a_test.ts",
      "design2/w_test.ts",
      "src/b.test.tsx",
      "src/test.ts",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("discoverTestFiles: the repo's own configuration finds this file and nothing excluded", async () => {
  const denoJson = JSON.parse(await Deno.readTextFile(join(ROOT, "deno.json")));
  const config = testConfigFrom(denoJson);
  const found = await discoverTestFiles(ROOT, config);
  assertEquals(found.includes("scripts/test_shards_test.ts"), true);
  assertEquals(
    found.filter((f) => config.exclude.some((e) => f.startsWith(`${e}/`))),
    [],
  );
});

Deno.test("partition: every file lands in exactly one shard, the heaviest first", () => {
  const files = Array.from({ length: 300 }, (_, i) => `f${i}_test.ts`);
  files.push("big_test.ts");
  const weights = { "big_test.ts": 200, "f1_test.ts": 50 };
  const shards = partition(files, weights, 4);

  assertEquals(shards.length, 4);
  assertEquals(shards.flat().sort(), [...files].sort());
  assertEquals(shards[0][0], "big_test.ts");
  assertEquals(shards[1][0], "f1_test.ts");
  // the shard holding the 200 s file takes no other file
  assertEquals(shards[0], ["big_test.ts"]);
  assertEquals(partition(files, weights, 4), shards);
});

Deno.test("partition: unlisted files share the default weight", () => {
  const shards = partition(["a_test.ts", "b_test.ts", "c_test.ts"], {}, 3);
  assertEquals(shards, [["a_test.ts"], ["b_test.ts"], ["c_test.ts"]]);
  assertEquals(DEFAULT_WEIGHT_SECONDS > 0, true);
});

Deno.test("shardPlan: one shard per 8 cores up to 4, with the cores split between them", () => {
  assertEquals(shardPlan(32), { shards: 4, jobs: 8 });
  assertEquals(shardPlan(24), { shards: 3, jobs: 8 });
  assertEquals(shardPlan(64), { shards: 4, jobs: 16 });
  assertEquals(shardPlan(8), { shards: 1, jobs: 8 });
  assertEquals(shardPlan(4), { shards: 1, jobs: 4 });
  assertEquals(shardPlan(1), { shards: 1, jobs: 1 });
  assertEquals(shardPlan(32, 2), { shards: 2, jobs: 16 });
  assertEquals(shardPlan(32, undefined, "6"), { shards: 4, jobs: 6 });
  assertEquals(shardPlan(32, undefined, "nope"), { shards: 4, jobs: 8 });
});

Deno.test("parseTestTask: shards run with exactly the test task's flags and environment", async () => {
  const denoJson = JSON.parse(await Deno.readTextFile(join(ROOT, "deno.json")));
  const task = parseTestTask(denoJson);
  assertEquals(task.env, { SWAMP_NO_TELEMETRY: "1" });
  assertEquals(task.flags.includes("--parallel"), true);
  assertEquals(
    `SWAMP_NO_TELEMETRY=1 deno test ${task.flags.join(" ")}`,
    denoJson.tasks.test,
  );
});

Deno.test("parseTestTask: a test task that is not deno test is refused", () => {
  assertThrows(
    () => parseTestTask({ tasks: { test: "npm test" } }),
    Error,
    "does not run deno test",
  );
  assertThrows(() => parseTestTask({ tasks: {} }), Error, "no test task");
});

Deno.test("parseResultLine: reads passed, failed and ignored, with or without colour", () => {
  assertEquals(
    parseResultLine("ok | 4150 passed (218 steps) | 0 failed | 1 ignored (1m19s)"),
    {
      passed: 4150,
      failed: 0,
      ignored: 1,
      line: "ok | 4150 passed (218 steps) | 0 failed | 1 ignored (1m19s)",
    },
  );
  assertEquals(
    parseResultLine(
      "\x1b[0m\x1b[31mFAILED\x1b[0m | 4879 passed (50 steps) | \x1b[0m\x1b[31m11 failed\x1b[0m | 2 ignored (12m50s)",
    )?.failed,
    11,
  );
  assertEquals(
    parseResultLine(
      "ok | 4833 passed (86 steps) | 0 failed | 1 ignored (1 step) (1m13s)",
    )?.ignored,
    1,
  );
  assertEquals(parseResultLine("ok | 12 passed | 0 failed (3s)")?.ignored, 0);
  assertEquals(parseResultLine("./a_test.ts => x ... ok (1ms)"), undefined);
});

Deno.test("failureBlocks: keeps the ERRORS and FAILURES sections up to the result line", () => {
  const lines = [
    "./a_test.ts => one ... ok (1ms)",
    " ERRORS ",
    "",
    "./b_test.ts => two => ./b_test.ts:3:6",
    "error: boom",
    " FAILURES ",
    "./b_test.ts => two => ./b_test.ts:3:6",
    "FAILED | 1 passed | 1 failed (1s)",
    "error: Test failed",
  ];
  assertEquals(failureBlocks(lines), lines.slice(1, 7));
  assertEquals(failureBlocks(lines.slice(0, 1)), []);
});

Deno.test("weightsFromLines: sums each file's test time and keeps the slow files", () => {
  const weights = weightsFromLines([
    "./integration/slow_test.ts => a ... ok (2s)",
    "./integration/slow_test.ts => b ... FAILED (1m1s)",
    "./integration/slow_test.ts => c ... ok (500ms)",
    "\x1b[0m./src/quick_test.ts => d ... ok (900ms)",
    "./src/quick_test.ts => e ... ignored (0ms)",
    "    step ... ok (5s)",
    "ok | 5 passed | 0 failed (1m)",
  ]);
  assertEquals(weights, { "integration/slow_test.ts": 63.5 });
});

Deno.test("weightsFromLines: the checked-in weights name only files that exist", async () => {
  const recorded = JSON.parse(
    await Deno.readTextFile(join(ROOT, WEIGHTS_FILE)),
  ).secondsByFile as Record<string, number>;
  const missing: string[] = [];
  for (const file of Object.keys(recorded)) {
    const exists = await Deno.stat(join(ROOT, file)).then(() => true, () => false);
    if (!exists) missing.push(file);
  }
  assertEquals(Object.keys(recorded).length > 0, true);
  assertEquals(missing, []);
});

Deno.test("combinedExitCode: fails when any shard fails, is killed or leaves temp entries", () => {
  const ok = { code: 0, signal: null, leftovers: [] };
  assertEquals(combinedExitCode([ok, ok]), 0);
  assertEquals(combinedExitCode([ok, { ...ok, code: 1 }]), 1);
  assertEquals(combinedExitCode([ok, { ...ok, signal: "SIGKILL" }]), 1);
  assertEquals(combinedExitCode([{ ...ok, leftovers: ["/t/0/x"] }]), 1);
});

Deno.test("parseCliArgs: passes deno test flags through and refuses file arguments", () => {
  assertEquals(parseCliArgs(["--no-check", "--repeats", "3"]), {
    recordWeights: false,
    passThrough: ["--no-check", "--repeats", "3"],
  });
  assertEquals(parseCliArgs(["--shards", "2", "--record-weights"]), {
    shards: 2,
    recordWeights: true,
    passThrough: [],
  });
  assertEquals(parseCliArgs(["--shards=3"]).shards, 3);
  assertThrows(() => parseCliArgs(["--shards", "0"]), Error, "at least 1");
  assertThrows(
    () => parseCliArgs(["src/a_test.ts"]),
    Error,
    "deno run test src/a_test.ts",
  );
});

Deno.test("allocateShardDirs: one single-character directory per shard, skipping names in use", async () => {
  const base = await Deno.makeTempDir({ prefix: "swamp-shards-test-" });
  try {
    await Deno.mkdir(join(base, "0"));
    const dirs = await allocateShardDirs(base, 3);
    assertEquals(dirs, [join(base, "1"), join(base, "2"), join(base, "3")]);
    const more = await allocateShardDirs(base, 2);
    assertEquals(more, [join(base, "4"), join(base, "5")]);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("allocateShardDirs: refuses and frees what it took when too few names are free", async () => {
  const base = await Deno.makeTempDir({ prefix: "swamp-shards-test-" });
  try {
    await allocateShardDirs(base, 35);
    await assertRejects(
      () => allocateShardDirs(base, 2),
      Error,
      "No free shard directories",
    );
    const left = [];
    for await (const entry of Deno.readDir(base)) left.push(entry.name);
    assertEquals(left.length, 35);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});
