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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { assertPathEquals } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { TELEMETRY_SENDER_MARKER } from "../src/infrastructure/telemetry/telemetry_sender_process.ts";
import {
  BENCH_COMMANDS,
  codeCachePath,
  formatTable,
  maxRssBytes,
  median,
  MIN_RUNS,
  parseBenchArgs,
  parseRusageReport,
  replaceOnce,
  summarize,
} from "./bench_startup.ts";

Deno.test("parseBenchArgs: defaults to the minimum runs and a 60 s timeout", () => {
  assertEquals(parseBenchArgs(["./swamp"]), {
    binary: "./swamp",
    runs: MIN_RUNS,
    timeoutMs: 60_000,
  });
});

Deno.test("parseBenchArgs: reads --runs and --timeout-ms", () => {
  assertEquals(
    parseBenchArgs(["--runs", "9", "./swamp", "--timeout-ms=500"]),
    { binary: "./swamp", runs: 9, timeoutMs: 500 },
  );
});

Deno.test("parseBenchArgs: refuses fewer runs than the minimum", () => {
  const error = assertThrows(() => parseBenchArgs(["./swamp", "--runs", "4"]));
  assertStringIncludes(String(error), `at least ${MIN_RUNS}`);
});

Deno.test("parseBenchArgs: refuses a missing binary, extra binaries and unknown options", () => {
  assertThrows(() => parseBenchArgs([]), Error, "one binary");
  assertThrows(() => parseBenchArgs(["a", "b"]), Error, "one binary");
  assertThrows(() => parseBenchArgs(["a", "--cold"]), Error, "unknown option");
});

Deno.test("parseBenchArgs: refuses non-integer values", () => {
  assertThrows(() => parseBenchArgs(["a", "--runs", "five"]), Error, "--runs");
  assertThrows(
    () => parseBenchArgs(["a", "--timeout-ms", "1.5"]),
    Error,
    "--timeout-ms",
  );
});

Deno.test("median: odd, even and single counts, input left unsorted", () => {
  const values = [5, 1, 3];
  assertEquals(median(values), 3);
  assertEquals(values, [5, 1, 3]);
  assertEquals(median([4, 1, 3, 2]), 2.5);
  assertEquals(median([7]), 7);
  assertThrows(() => median([]), Error, "no values");
});

Deno.test("codeCachePath: names the cache after the binary's whole file name", () => {
  assertPathEquals(
    codeCachePath(join("scratch", "tmp"), join("builds", "swamp-base")),
    join("scratch", "tmp", "deno-compile-swamp-base.cache"),
  );
  assertPathEquals(
    codeCachePath("tmp", join("builds", "swamp.bin")),
    join("tmp", "deno-compile-swamp.bin.cache"),
  );
});

Deno.test("codeCachePath: two binaries with different names do not share a cache", () => {
  const a = codeCachePath("tmp", join("x", "swamp-base"));
  const b = codeCachePath("tmp", join("x", "swamp-pr"));
  assertEquals(a === b, false);
});

Deno.test("maxRssBytes: KiB on Linux, bytes on macOS", () => {
  assertEquals(maxRssBytes(2048, "linux"), 2048 * 1024);
  assertEquals(maxRssBytes(2048, "darwin"), 2048);
});

Deno.test("parseRusageReport: reads the helper's JSON", () => {
  assertEquals(
    parseRusageReport(
      '{"exitCode":0,"wallNs":12,"maxRss":34,"timedOut":false}\n',
    ),
    { exitCode: 0, wallNs: 12, maxRss: 34, timedOut: false },
  );
});

Deno.test("parseRusageReport: refuses unreadable or incomplete reports", () => {
  assertThrows(() => parseRusageReport("Traceback"), Error, "unreadable");
  assertThrows(() => parseRusageReport('{"exitCode":0}'), Error, "unexpected");
  assertThrows(() => parseRusageReport("null"), Error, "unexpected");
});

Deno.test("summarize: medians wall time and converts RSS to MiB", () => {
  const mib = 1024 * 1024;
  assertEquals(
    summarize([
      { wallMs: 100, rssBytes: 100 * mib },
      { wallMs: 300, rssBytes: 120 * mib },
      { wallMs: 200, rssBytes: 110 * mib },
    ]),
    { wallMs: 200, rssMiB: 110 },
  );
});

Deno.test("formatTable: prints a markdown row per command", () => {
  const table = formatTable("/b/swamp", 5, [
    {
      label: "version",
      cold: { wallMs: 384.4, rssMiB: 219.04 },
      warm: { wallMs: 110.6, rssMiB: 109 },
    },
  ]);
  assertEquals(table.split("\n"), [
    "bench-startup: /b/swamp (median of 5 runs)",
    "",
    "| command | cold ms | cold MiB | warm ms | warm MiB |",
    "| --- | ---: | ---: | ---: | ---: |",
    "| version | 384 | 219.0 | 111 | 109.0 |",
  ]);
});

Deno.test("BENCH_COMMANDS: covers the issue's command set in order", () => {
  assertEquals(BENCH_COMMANDS.map((c) => c.label), [
    "version",
    "--help",
    "help data get",
    "data get",
    "behavior run",
    "workflow run",
    "telemetry sender",
  ]);
});

Deno.test("BENCH_COMMANDS: the sender gets a fresh token on every run", () => {
  const sender = BENCH_COMMANDS.find((c) => c.label === "telemetry sender");
  let n = 0;
  const context = { newToken: () => `token-${n++}` };
  const first = sender?.args(context) ?? [];
  const second = sender?.args(context) ?? [];
  assertEquals(first[0], TELEMETRY_SENDER_MARKER);
  assertEquals(first[first.indexOf("--lock-token") + 1], "token-0");
  assertEquals(second[second.indexOf("--lock-token") + 1], "token-1");
});

Deno.test("replaceOnce: replaces a single occurrence", () => {
  assertEquals(
    replaceOnce("a: 1\nmethods: {}\n", "methods: {}", "methods: x", "f"),
    "a: 1\nmethods: x\n",
  );
});

Deno.test("replaceOnce: refuses a missing or repeated marker", () => {
  assertThrows(
    () => replaceOnce("nothing", "methods: {}", "x", "model.yaml"),
    Error,
    "model.yaml",
  );
  assertThrows(
    () => replaceOnce("run run", "run", "x", "wf.yaml"),
    Error,
    "exactly one",
  );
});
