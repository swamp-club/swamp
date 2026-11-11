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

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  buildInvocations,
  differs,
  diffReport,
  extractCommandPaths,
  type InvocationResult,
  mapPool,
  normalize,
  parseParityArgs,
  parseSchema,
  parseVersionJson,
  type RunOutput,
  type SchemaNode,
  typoFor,
  VERSION_PLACEHOLDER,
} from "./cli_parity.ts";

function node(
  name: string,
  subcommands: SchemaNode[] = [],
  extra: Partial<SchemaNode> = {},
): SchemaNode {
  return { name, aliases: [], hidden: false, subcommands, ...extra };
}

const tree = node("swamp", [
  node("data", [node("get"), node("gc", [], { hidden: true })]),
  node("audit", [], { hidden: true }),
  node("behavior", [node("run"), node("lease", [node("acquire")])], {
    aliases: ["behaviour"],
  }),
]);

Deno.test("parseParityArgs: two binaries, CPU-count concurrency, 60 s timeout", () => {
  assertEquals(parseParityArgs(["a", "b"], 8), {
    binaryA: "a",
    binaryB: "b",
    concurrency: 8,
    timeoutMs: 60_000,
  });
});

Deno.test("parseParityArgs: reads --concurrency and --timeout-ms", () => {
  assertEquals(
    parseParityArgs(["--concurrency", "2", "a", "b", "--timeout-ms=900"], 8),
    { binaryA: "a", binaryB: "b", concurrency: 2, timeoutMs: 900 },
  );
});

Deno.test("parseParityArgs: refuses the wrong binary count, bad numbers and unknown options", () => {
  assertThrows(() => parseParityArgs(["a"], 4), Error, "two binary");
  assertThrows(() => parseParityArgs(["a", "b", "c"], 4), Error, "two binary");
  assertThrows(
    () => parseParityArgs(["a", "b", "--concurrency", "0"], 4),
    Error,
    "--concurrency",
  );
  assertThrows(
    () => parseParityArgs(["a", "b", "--quick"], 4),
    Error,
    "unknown option",
  );
});

Deno.test("parseParityArgs: a zero CPU count still runs one at a time", () => {
  assertEquals(parseParityArgs(["a", "b"], 0).concurrency, 1);
});

Deno.test("parseSchema: reads the nested command tree", () => {
  const text = JSON.stringify({
    version: "1",
    root: {
      name: "swamp",
      aliases: [],
      hidden: false,
      description: "ignored",
      subcommands: [{
        name: "data",
        aliases: ["d"],
        hidden: true,
        subcommands: [],
      }],
    },
  });
  assertEquals(
    parseSchema(text),
    node("swamp", [node("data", [], { aliases: ["d"], hidden: true })]),
  );
});

Deno.test("parseSchema: refuses a tree missing fields", () => {
  assertThrows(
    () =>
      parseSchema(
        JSON.stringify({ root: { name: "swamp", subcommands: [{}] } }),
      ),
    Error,
    "unexpected command shape",
  );
});

Deno.test("parseVersionJson: reads the version and refuses an empty one", () => {
  assertEquals(
    parseVersionJson('{"version":"20261110.1-sha.abc"}'),
    "20261110.1-sha.abc",
  );
  assertThrows(() => parseVersionJson('{"version":""}'), Error, "no version");
});

Deno.test("extractCommandPaths: every path below the root, hidden included, depth first", () => {
  assertEquals(extractCommandPaths(tree), [
    ["data"],
    ["data", "get"],
    ["data", "gc"],
    ["audit"],
    ["behavior"],
    ["behavior", "run"],
    ["behavior", "lease"],
    ["behavior", "lease", "acquire"],
  ]);
});

Deno.test("typoFor: swaps two letters after the first", () => {
  assertEquals(typoFor("data", new Set(["data"])), "dtaa");
});

Deno.test("typoFor: never returns a name or alias that resolves", () => {
  const taken = new Set(["abc", "acb", "abcq"]);
  const typo = typoFor("abc", taken);
  assert(!taken.has(typo));
  assertEquals(typo, "abcqq");
});

Deno.test("typoFor: short and repeated-letter names fall back to a suffix", () => {
  assertEquals(typoFor("ls", new Set(["ls"])), "lsq");
  assertEquals(typoFor("aaa", new Set(["aaa"])), "aaaq");
});

Deno.test("buildInvocations: root help, per-path help, completions, typos, version", () => {
  const invocations = buildInvocations(tree).map((args) => args.join(" "));
  assertEquals(invocations.slice(0, 9), [
    "--help",
    "-h",
    "",
    "--json",
    "--json --help",
    "help",
    "help --include-hidden",
    "data --help",
    "help data",
  ]);
  for (const shell of ["bash", "zsh", "fish"]) {
    assert(invocations.includes(`completions ${shell}`), shell);
  }
  assert(invocations.includes("audit --help"));
  assert(invocations.includes("help behavior lease acquire"));
  assertEquals(invocations.at(-1), "version --json");
});

Deno.test("buildInvocations: one typo at the root and in every group, from a visible child", () => {
  const typos = buildInvocations(tree)
    .filter((args) => args.length > 0 && !args[0].startsWith("-"))
    .filter((args) => !args.includes("--help") && args[0] !== "help")
    .filter((args) => args[0] !== "completions" && args[0] !== "version");
  assertEquals(typos, [
    ["dtaa"],
    ["data", "gte"],
    ["behavior", "rnu"],
    ["behavior", "lease", "aqcuire"],
  ]);
});

Deno.test("normalize: masks the binary's version and the padding that follows it", () => {
  const short = "Version: 1.0-sha.a           \nUsage: swamp";
  const long = "Version: 1.0.123-sha.abcdef   \nUsage: swamp";
  assertEquals(
    normalize(short, "1.0-sha.a"),
    normalize(long, "1.0.123-sha.abcdef"),
  );
  assertEquals(
    normalize(short, "1.0-sha.a"),
    `Version: ${VERSION_PLACEHOLDER}\nUsage: swamp`,
  );
});

Deno.test("normalize: masks every occurrence and keeps other text", () => {
  assertEquals(
    normalize('{"version": "v9"}\nv9 again\n', "v9"),
    `{"version": "${VERSION_PLACEHOLDER}"}\n${VERSION_PLACEHOLDER} again\n`,
  );
});

const same: RunOutput = { exitCode: 0, stdout: "one\ntwo\n", stderr: "" };

function result(args: string[], b: Partial<RunOutput> = {}): InvocationResult {
  return { args, a: same, b: { ...same, ...b } };
}

Deno.test("diffReport: identical results pass", () => {
  const results = [result(["--help"]), result(["help"])];
  assertEquals(results.some(differs), false);
  assertEquals(diffReport(results), { differing: 0 });
});

Deno.test("diffReport: names the first difference in invocation order and counts them all", () => {
  const { differing, report } = diffReport([
    result(["--help"]),
    result(["data", "--help"], { stdout: "one\nTWO\n" }),
    result(["help", "data"], { exitCode: 2 }),
  ]);
  assertEquals(differing, 2);
  assertStringIncludes(report ?? "", "2 of 3 invocations differ");
  assertStringIncludes(report ?? "", "swamp data --help");
  assertStringIncludes(report ?? "", "stdout differs at line 2");
  assertStringIncludes(report ?? "", "A two");
  assertStringIncludes(report ?? "", "B TWO");
  assertEquals((report ?? "").includes("swamp help data"), false);
});

Deno.test("diffReport: reports stderr and exit code differences separately", () => {
  const { report } = diffReport([
    result(["dtaa"], { exitCode: 1, stderr: "Error: sign in\n" }),
  ]);
  assertStringIncludes(report ?? "", "stderr differs at line 1");
  assertStringIncludes(report ?? "", "exit code: A 0, B 1");
  assertEquals((report ?? "").includes("stdout differs"), false);
});

Deno.test("diffReport: shows shared context before the difference and marks a shorter side", () => {
  const a = ["l1", "l2", "l3", "l4", "l5"].join("\n");
  const { report } = diffReport([
    {
      args: ["help"],
      a: { ...same, stdout: a },
      b: { ...same, stdout: "l1\nl2\nl3\nl4" },
    },
  ]);
  const lines = (report ?? "").split("\n");
  assertStringIncludes(report ?? "", "stdout differs at line 5");
  assert(lines.includes("      l2"));
  assert(lines.includes("      l4"));
  assertEquals(lines.includes("      l1"), false);
  assert(lines.includes("    A l5"));
  assert(lines.includes("    B (end of output)"));
});

Deno.test("mapPool: keeps input order and never exceeds the limit", async () => {
  let inFlight = 0;
  let peak = 0;
  const gates: Array<() => void> = [];
  const pending = mapPool([1, 2, 3, 4, 5], 2, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise<void>((resolve) => gates.push(resolve));
    inFlight--;
    return n * 10;
  });
  // release in reverse arrival order so completion order differs from input
  while (gates.length > 0 || inFlight > 0) {
    await Promise.resolve();
    gates.pop()?.();
  }
  assertEquals(await pending, [10, 20, 30, 40, 50]);
  assertEquals(peak, 2);
});

Deno.test("mapPool: an empty list resolves at once", async () => {
  assertEquals(await mapPool([], 4, () => Promise.resolve(1)), []);
});
